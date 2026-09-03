//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// removeAllWithRetry backoff: bounded retries with a growing sleep so a service
// image file that is transiently locked during process teardown does not abort a
// completed uninstall. 5 attempts * 250ms..1.25s ≈ 1.5s worst case, well under
// the 30s stop budget and far beyond how long Windows holds a terminated
// service's image for.
const (
	maxRemoveAllAttempts   = 5
	removeAllRetryInterval = 250 * time.Millisecond
)

type serviceTemplate struct {
	ServiceName          string `json:"serviceName"`
	PipeName             string `json:"pipeName"`
	NamespaceID          string `json:"namespaceId"`
	ArchiveFilename      string `json:"archiveFilename"`
	ArchiveSHA256        string `json:"archiveSha256"`
	ArchiveInnerName     string `json:"archiveInnerName"`
	ClientExecutableName string `json:"clientExecutableName"`
}

func runInstallerCommand(operation string, bootstrapDirectory string) error {
	token := windows.GetCurrentProcessToken()
	if !token.IsElevated() {
		return errors.New("service installation requires an elevated token")
	}
	template, err := loadServiceTemplate(filepath.Join(bootstrapDirectory, "service-template.json"))
	if err != nil {
		return err
	}
	programData := os.Getenv("ProgramData")
	if !filepath.IsAbs(programData) {
		return errors.New("ProgramData is unavailable")
	}
	root := filepath.Join(programData, template.NamespaceID, "tun-service")
	serviceHome := filepath.Join(root, "service")
	stateDirectory := filepath.Join(root, "state")
	switch operation {
	case "--install":
		user, err := token.GetTokenUser()
		if err != nil {
			return err
		}
		return installOrUpgradeService(template, bootstrapDirectory, serviceHome, stateDirectory, user.User.Sid.String())
	case "--uninstall":
		return uninstallService(template, root, stateDirectory)
	default:
		return errors.New("unknown installer operation")
	}
}

func loadServiceTemplate(path string) (serviceTemplate, error) {
	file, err := os.Open(path)
	if err != nil {
		return serviceTemplate{}, err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	var template serviceTemplate
	if err := decoder.Decode(&template); err != nil {
		return serviceTemplate{}, err
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return serviceTemplate{}, err
	}
	if !safeNamePattern.MatchString(template.ServiceName) || !safeNamePattern.MatchString(template.PipeName) || !safeNamePattern.MatchString(template.NamespaceID) {
		return serviceTemplate{}, errors.New("unsafe service template identity")
	}
	if filepath.Base(template.ArchiveFilename) != template.ArchiveFilename || filepath.Base(template.ArchiveInnerName) != template.ArchiveInnerName || !sha256Pattern.MatchString(template.ArchiveSHA256) {
		return serviceTemplate{}, errors.New("unsafe service template asset")
	}
	if !safeNamePattern.MatchString(template.ClientExecutableName) {
		return serviceTemplate{}, errors.New("unsafe client executable name")
	}
	return template, nil
}

func installOrUpgradeService(template serviceTemplate, bootstrapDirectory, serviceHome, stateDirectory, allowedSID string) error {
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	existing, openErr := manager.OpenService(template.ServiceName)
	if openErr == nil {
		if err := stopServiceAndWait(existing, 30*time.Second); err != nil {
			existing.Close()
			return err
		}
		existing.Close()
		if _, err := os.Stat(filepath.Join(stateDirectory, "ownership.json")); err == nil {
			return errors.New("owned mihomo process remains after service stop")
		}
	} else if !errors.Is(openErr, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return fmt.Errorf("open existing service: %w", openErr)
	}
	if err := os.MkdirAll(serviceHome, 0700); err != nil {
		return err
	}
	if err := secureStateDirectory(serviceHome); err != nil {
		return err
	}
	if err := secureStateDirectory(stateDirectory); err != nil {
		return err
	}
	sourceExe := filepath.Join(bootstrapDirectory, "tun-service.exe")
	serviceExe := filepath.Join(serviceHome, "tun-service.exe")
	if err := copyFileAtomic(sourceExe, serviceExe); err != nil {
		return err
	}
	archivePath := filepath.Clean(filepath.Join(bootstrapDirectory, "..", "bin", template.ArchiveFilename))
	if digest, err := hashFile(archivePath); err != nil || digest != template.ArchiveSHA256 {
		return errors.New("installer-bundled mihomo archive failed verification")
	}
	clientPath := filepath.Clean(filepath.Join(bootstrapDirectory, "..", "..", template.ClientExecutableName+".exe"))
	clientDigest, err := hashFile(clientPath)
	if err != nil {
		return fmt.Errorf("hash installed GUI: %w", err)
	}
	config := serviceConfig{
		ServiceName: template.ServiceName, PipeName: template.PipeName, AllowedSID: allowedSID,
		ArchivePath: archivePath, ArchiveSHA256: template.ArchiveSHA256,
		ArchiveInnerName: template.ArchiveInnerName, StateDirectory: stateDirectory,
		AllowedClientPath: clientPath, AllowedClientSHA256: clientDigest,
	}
	configBytes, err := json.Marshal(config)
	if err != nil {
		return err
	}
	if err := writePrivateFile(filepath.Join(serviceHome, "service-config.json"), configBytes); err != nil {
		return err
	}
	serviceConfig := mgr.Config{
		StartType: mgr.StartAutomatic, ErrorControl: mgr.ErrorNormal,
		ServiceStartName: "LocalSystem", DisplayName: template.ServiceName,
		Description: "Privileged mihomo TUN lifecycle service",
		SidType:     windows.SERVICE_SID_TYPE_UNRESTRICTED, DelayedAutoStart: true,
	}
	service, err := manager.OpenService(template.ServiceName)
	if err == nil {
		defer service.Close()
		if err := service.UpdateConfig(serviceConfig); err != nil {
			return err
		}
	} else if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		service, err = manager.CreateService(template.ServiceName, serviceExe, serviceConfig)
		if err != nil {
			return err
		}
		defer service.Close()
	} else {
		return fmt.Errorf("open service for update: %w", err)
	}
	_ = service.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 2 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
		{Type: mgr.NoAction},
	}, 24*60*60)
	if err := service.Start(); err != nil {
		return fmt.Errorf("start service: %w", err)
	}
	return waitForServiceRunning(service, 30*time.Second)
}

func uninstallService(template serviceTemplate, root, stateDirectory string) error {
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(template.ServiceName)
	if err == nil {
		if err := stopServiceAndWait(service, 30*time.Second); err != nil {
			service.Close()
			return err
		}
		if _, err := os.Stat(filepath.Join(stateDirectory, "ownership.json")); err == nil {
			service.Close()
			return errors.New("refusing uninstall while mihomo ownership remains")
		}
		if err := service.Delete(); err != nil {
			service.Close()
			return err
		}
		service.Close()
	} else if !errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return fmt.Errorf("open service for uninstall: %w", err)
	}
	return removeAllWithRetry(root)
}

// removeAllWithRetry removes root, retrying briefly so a just-stopped service
// process that is still releasing its image file (the exe under root/service)
// does not make an otherwise-complete uninstall fail. The SCM entry has already
// been deleted by the caller's service.Delete(); this only needs the on-disk
// state gone. A genuinely persistent lock still surfaces as an error after the
// retry window, so real problems are never silently swallowed.
func removeAllWithRetry(root string) error {
	var err error
	for attempt := 0; attempt < maxRemoveAllAttempts; attempt++ {
		err = os.RemoveAll(root)
		if err == nil {
			return nil
		}
		time.Sleep(time.Duration(attempt+1) * removeAllRetryInterval)
	}
	return err
}

func stopServiceAndWait(service *mgr.Service, timeout time.Duration) error {
	status, err := service.Query()
	if err != nil {
		return err
	}
	if status.State == svc.Stopped {
		return nil
	}
	if _, err := service.Control(svc.Stop); err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
		return err
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		status, err = service.Query()
		if err != nil {
			return err
		}
		if status.State == svc.Stopped {
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	return errors.New("service stop timed out")
}

func waitForServiceRunning(service *mgr.Service, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		status, err := service.Query()
		if err != nil {
			return err
		}
		switch status.State {
		case svc.Running:
			return nil
		case svc.Stopped:
			return fmt.Errorf(
				"service stopped during startup (win32ExitCode=%d, serviceExitCode=%d)",
				status.Win32ExitCode,
				status.ServiceSpecificExitCode,
			)
		}
		time.Sleep(250 * time.Millisecond)
	}
	return errors.New("service start timed out")
}

func copyFileAtomic(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	temporary := destination + ".tmp"
	_ = os.Remove(temporary)
	output, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	if copyErr == nil {
		copyErr = output.Sync()
	}
	closeErr := output.Close()
	if copyErr != nil {
		_ = os.Remove(temporary)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(temporary)
		return closeErr
	}
	_ = os.Remove(destination)
	if err := os.Rename(temporary, destination); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("replace service executable: %w", err)
	}
	return nil
}
