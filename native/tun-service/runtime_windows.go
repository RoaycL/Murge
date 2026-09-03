//go:build windows

package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const maxCoreBytes = 128 * 1024 * 1024

type windowsRuntime struct {
	config     serviceConfig
	corePath   string
	coreSHA256 string
	job        windows.Handle
}

func newWindowsRuntime(config serviceConfig) (*windowsRuntime, error) {
	if err := secureStateDirectory(config.StateDirectory); err != nil {
		return nil, err
	}
	corePath, coreDigest, err := prepareCore(config)
	if err != nil {
		return nil, err
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	var limits windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	return &windowsRuntime{config: config, corePath: corePath, coreSHA256: coreDigest, job: job}, nil
}

// stateDirectorySDDL is the byte-for-byte normative contract mirrored by
// STATE_DIRECTORY_SDDL in src/main/tun/security-descriptors.ts (asserted in
// tests/tun-contracts.test.ts): owner+group SYSTEM, a protected DACL granting
// full control to SYSTEM and Administrators only, and a HIGH mandatory
// integrity label with no-write-up — a Medium-IL process of the same user can
// READ nothing here and can never write, so ownership records and the pinned
// profile cannot be tampered with from the session.
const stateDirectorySDDL = "O:SYG:SYD:P(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)S:(ML;OICI;NW;;;HI)"

func secureStateDirectory(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	attributes, err := windows.GetFileAttributes(windows.StringToUTF16Ptr(path))
	if err != nil {
		return err
	}
	if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("refusing reparse-point service directory")
	}
	sd, err := windows.SecurityDescriptorFromString(stateDirectorySDDL)
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	sacl, _, err := sd.SACL()
	if err != nil {
		return err
	}
	// Setting the mandatory label requires SeSecurityPrivilege to be ENABLED.
	// Both an elevated installer token and LocalSystem normally contain it but
	// Windows keeps privileges disabled until explicitly requested. Restore the
	// prior token state immediately after the one protected operation.
	restorePrivilege, err := enableSecurityPrivilege()
	if err != nil {
		return fmt.Errorf("enable SeSecurityPrivilege: %w", err)
	}
	defer restorePrivilege()
	err = windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION|
			windows.SACL_SECURITY_INFORMATION|windows.LABEL_SECURITY_INFORMATION,
		nil, nil, dacl, sacl)
	if err != nil {
		return fmt.Errorf("state directory hardening failed: %w", err)
	}
	return nil
}

func enableSecurityPrivilege() (func(), error) {
	var token windows.Token
	if err := windows.OpenProcessToken(
		windows.CurrentProcess(),
		windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY,
		&token,
	); err != nil {
		return nil, err
	}
	name, err := windows.UTF16PtrFromString("SeSecurityPrivilege")
	if err != nil {
		token.Close()
		return nil, err
	}
	var luid windows.LUID
	if err := windows.LookupPrivilegeValue(nil, name, &luid); err != nil {
		token.Close()
		return nil, err
	}
	desired := windows.Tokenprivileges{
		PrivilegeCount: 1,
		Privileges: [1]windows.LUIDAndAttributes{{
			Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED,
		}},
	}
	var previous windows.Tokenprivileges
	var returned uint32
	if err := windows.AdjustTokenPrivileges(
		token,
		false,
		&desired,
		uint32(unsafe.Sizeof(previous)),
		&previous,
		&returned,
	); err != nil {
		token.Close()
		return nil, err
	}
	if errors.Is(windows.GetLastError(), windows.ERROR_NOT_ALL_ASSIGNED) {
		token.Close()
		return nil, windows.ERROR_NOT_ALL_ASSIGNED
	}
	return func() {
		_ = windows.AdjustTokenPrivileges(token, false, &previous, 0, nil, nil)
		_ = token.Close()
	}, nil
}

func prepareCore(config serviceConfig) (string, string, error) {
	archiveDigest, err := hashFile(config.ArchivePath)
	if err != nil {
		return "", "", err
	}
	if archiveDigest != config.ArchiveSHA256 {
		return "", "", errors.New("packaged mihomo archive digest mismatch")
	}
	archive, err := zip.OpenReader(config.ArchivePath)
	if err != nil {
		return "", "", err
	}
	defer archive.Close()
	var entry *zip.File
	for _, candidate := range archive.File {
		if candidate.Name == config.ArchiveInnerName {
			if entry != nil {
				return "", "", errors.New("duplicate mihomo archive entry")
			}
			entry = candidate
		}
	}
	if entry == nil || entry.FileInfo().IsDir() || entry.UncompressedSize64 > maxCoreBytes {
		return "", "", errors.New("mihomo archive entry is invalid")
	}
	reader, err := entry.Open()
	if err != nil {
		return "", "", err
	}
	defer reader.Close()
	temporary := filepath.Join(config.StateDirectory, "core.exe.tmp")
	_ = os.Remove(temporary)
	output, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		return "", "", err
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(output, hash), io.LimitReader(reader, maxCoreBytes+1))
	if copyErr == nil {
		copyErr = output.Sync()
	}
	closeErr := output.Close()
	if copyErr != nil {
		_ = os.Remove(temporary)
		return "", "", copyErr
	}
	if closeErr != nil {
		_ = os.Remove(temporary)
		return "", "", closeErr
	}
	if written <= 0 || written > maxCoreBytes {
		_ = os.Remove(temporary)
		return "", "", errors.New("extracted mihomo size is invalid")
	}
	coreDigest := hex.EncodeToString(hash.Sum(nil))
	corePath := filepath.Join(config.StateDirectory, "core.exe")
	if err := os.Rename(temporary, corePath); err != nil {
		_ = os.Remove(corePath)
		if err = os.Rename(temporary, corePath); err != nil {
			_ = os.Remove(temporary)
			return "", "", err
		}
	}
	return corePath, coreDigest, nil
}

func (runtime *windowsRuntime) Start(profile string, _ string) (int, error) {
	if digest, err := hashFile(runtime.corePath); err != nil || digest != runtime.coreSHA256 {
		return 0, errors.New("extracted mihomo integrity check failed")
	}
	profilePath := filepath.Join(runtime.config.StateDirectory, "session.yaml")
	if err := writePrivateFile(profilePath, []byte(profile)); err != nil {
		return 0, err
	}
	command := exec.Command(runtime.corePath, "-d", runtime.config.StateDirectory, "-f", profilePath)
	command.Dir = runtime.config.StateDirectory
	command.Env = safeWindowsEnvironment()
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
	if err := command.Start(); err != nil {
		_ = os.Remove(profilePath)
		return 0, err
	}
	processHandle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(command.Process.Pid))
	if err != nil || windows.AssignProcessToJobObject(runtime.job, processHandle) != nil {
		if processHandle != 0 {
			windows.CloseHandle(processHandle)
		}
		_ = command.Process.Kill()
		_ = command.Wait()
		_ = os.Remove(profilePath)
		return 0, errors.New("failed to bind mihomo to the service job object")
	}
	windows.CloseHandle(processHandle)
	go func() { _ = command.Wait() }()
	return command.Process.Pid, nil
}

func (runtime *windowsRuntime) Stop(pid int) error {
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(pid))
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return nil
	}
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	if err := windows.TerminateProcess(handle, 0); err != nil {
		return err
	}
	event, err := windows.WaitForSingleObject(handle, 10_000)
	if err != nil {
		return err
	}
	if event != windows.WAIT_OBJECT_0 {
		return errors.New("mihomo stop was not confirmed")
	}
	return nil
}

func (runtime *windowsRuntime) Inspect(pid int) (bool, error) {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(pid))
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(handle)
	event, err := windows.WaitForSingleObject(handle, 0)
	if err != nil {
		return false, err
	}
	if event == windows.WAIT_OBJECT_0 {
		return false, nil
	}
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if err := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size); err != nil {
		return false, err
	}
	observedPath := windows.UTF16ToString(buffer[:size])
	if !strings.EqualFold(filepath.Clean(observedPath), filepath.Clean(runtime.corePath)) {
		return false, errors.New("owned PID executable path mismatch")
	}
	digest, err := hashFile(observedPath)
	if err != nil {
		return false, err
	}
	if digest != runtime.coreSHA256 {
		return false, errors.New("owned PID executable digest mismatch")
	}
	if err := windows.AssignProcessToJobObject(runtime.job, handle); err != nil {
		return false, errors.New("failed to attach owned mihomo to service job object")
	}
	return true, nil
}

func hashFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func writePrivateFile(path string, data []byte) error {
	temporary := path + ".tmp"
	_ = os.Remove(temporary)
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if closeErr != nil {
		_ = os.Remove(temporary)
		return closeErr
	}
	_ = os.Remove(path)
	return os.Rename(temporary, path)
}

func safeWindowsEnvironment() []string {
	keys := []string{"SystemRoot", "WINDIR", "TEMP", "TMP"}
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		if value := os.Getenv(key); value != "" {
			result = append(result, fmt.Sprintf("%s=%s", key, value))
		}
	}
	return result
}
