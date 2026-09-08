//go:build windows

package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
	"unsafe"

	"golang.org/x/sys/windows"
)

const maxCoreBytes = 128 * 1024 * 1024

type windowsRuntime struct {
	config            serviceConfig
	corePath          string
	coreSHA256        string
	coreIdentity      *fileIdentity
	bundledCorePath   string
	bundledCoreSHA256 string
	job               windows.Handle
	versionMu         sync.Mutex
	processMu         sync.Mutex
	processOutput     map[int]*boundedTailWriter
}

type boundedTailWriter struct {
	mu    sync.Mutex
	data  []byte
	limit int
}

func newBoundedTailWriter(limit int) *boundedTailWriter {
	return &boundedTailWriter{limit: limit}
}

func (writer *boundedTailWriter) Write(data []byte) (int, error) {
	written := len(data)
	writer.mu.Lock()
	defer writer.mu.Unlock()
	writer.data = append(writer.data, data...)
	if len(writer.data) > writer.limit {
		writer.data = append([]byte(nil), writer.data[len(writer.data)-writer.limit:]...)
	}
	return written, nil
}

func (writer *boundedTailWriter) String() string {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	return strings.TrimSpace(string(writer.data))
}

func (runtime *windowsRuntime) Validate(profile string, version string) error {
	corePath, coreDigest := runtime.bundledCorePath, runtime.bundledCoreSHA256
	if version != "" {
		runtime.versionMu.Lock()
		defer runtime.versionMu.Unlock()
		var err error
		corePath, coreDigest, err = runtime.versionCore(version, 0, false)
		if err != nil {
			return err
		}
	}
	if digest, err := hashFile(corePath); err != nil || digest != coreDigest {
		return errors.New("extracted mihomo integrity check failed")
	}
	temporary, err := os.CreateTemp(runtime.config.StateDirectory, "validate-*.yaml")
	if err != nil {
		return err
	}
	path := temporary.Name()
	defer os.Remove(path)
	if _, err = temporary.Write([]byte(profile)); err == nil {
		err = temporary.Sync()
	}
	closeErr := temporary.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, corePath, "-t", "-d", runtime.config.StateDirectory, "-f", path)
	command.Dir = runtime.config.StateDirectory
	command.Env = safeWindowsEnvironment()
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, runErr := command.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return fmt.Errorf("%w: timeout", errConfigInvalid)
	}
	if runErr != nil {
		message := strings.TrimSpace(string(output))
		if len(message) > 3500 {
			message = message[len(message)-3500:]
		}
		if message == "" {
			message = runErr.Error()
		}
		return fmt.Errorf("%w: %s", errConfigInvalid, message)
	}
	return nil
}

func newWindowsRuntime(config serviceConfig) (*windowsRuntime, error) {
	if err := secureStateDirectory(config.TrustDirectory); err != nil {
		return nil, err
	}
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
	coreIdentity, err := fileIdentityForPath(corePath)
	if err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	return &windowsRuntime{
		config: config, corePath: corePath, coreSHA256: coreDigest,
		coreIdentity: &coreIdentity, bundledCorePath: corePath, bundledCoreSHA256: coreDigest, job: job,
	}, nil
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
	if err := rejectReparsePath(path); err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString(stateDirectorySDDL)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil {
		return errors.New("state directory owner SID is unavailable")
	}
	group, _, err := sd.Group()
	if err != nil || group == nil {
		return errors.New("state directory group SID is unavailable")
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	sacl, _, err := sd.SACL()
	if err != nil {
		return err
	}
	// SeSecurity is required for the mandatory label. SeRestore lets both the
	// elevated installer and LocalSystem take ownership of a directory that was
	// pre-created with a hostile DACL. Restore both token states immediately.
	restorePrivileges, err := enablePrivileges("SeSecurityPrivilege", "SeRestorePrivilege")
	if err != nil {
		return fmt.Errorf("enable directory-hardening privileges: %w", err)
	}
	defer restorePrivileges()

	// Hold a no-follow directory handle without FILE_SHARE_DELETE while applying
	// security. This prevents the checked final component from being swapped for
	// a junction between validation and SetSecurityInfo.
	pathPtr, err := windows.UTF16PtrFromString(filepath.Clean(path))
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(
		pathPtr,
		windows.READ_CONTROL|windows.WRITE_DAC|windows.WRITE_OWNER|windows.ACCESS_SYSTEM_SECURITY|windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT,
		0,
	)
	if err != nil {
		return fmt.Errorf("open state directory without following reparse points: %w", err)
	}
	defer windows.CloseHandle(handle)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("refusing non-directory or reparse-point service path")
	}
	err = windows.SetSecurityInfo(handle, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|
			windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION|
			windows.SACL_SECURITY_INFORMATION|windows.LABEL_SECURITY_INFORMATION,
		owner, group, dacl, sacl)
	if err != nil {
		return fmt.Errorf("state directory hardening failed: %w", err)
	}
	return nil
}

// rejectReparsePath checks every existing path component, not only the leaf.
// A junction at namespace/tun-service would otherwise make a normal-looking
// state leaf resolve into an attacker-controlled tree.
func rejectReparsePath(path string) error {
	clean := filepath.Clean(path)
	if !filepath.IsAbs(clean) {
		return errors.New("service directory must be absolute")
	}
	volume := filepath.VolumeName(clean)
	if len(volume) != 2 || volume[1] != ':' {
		return errors.New("service directory must be on a local drive")
	}
	current := volume + string(filepath.Separator)
	remainder := strings.TrimPrefix(clean, current)
	for _, segment := range strings.Split(remainder, string(filepath.Separator)) {
		if segment == "" {
			continue
		}
		current = filepath.Join(current, segment)
		attributes, err := windows.GetFileAttributes(windows.StringToUTF16Ptr(current))
		if err != nil {
			return err
		}
		if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return fmt.Errorf("refusing reparse-point service path component: %s", current)
		}
	}
	return nil
}

func enablePrivileges(names ...string) (func(), error) {
	restores := make([]func(), 0, len(names))
	for _, name := range names {
		restore, err := enablePrivilege(name)
		if err != nil {
			for index := len(restores) - 1; index >= 0; index-- {
				restores[index]()
			}
			return nil, fmt.Errorf("enable %s: %w", name, err)
		}
		restores = append(restores, restore)
	}
	return func() {
		for index := len(restores) - 1; index >= 0; index-- {
			restores[index]()
		}
	}, nil
}

func enablePrivilege(privilegeName string) (func(), error) {
	var token windows.Token
	if err := windows.OpenProcessToken(
		windows.CurrentProcess(),
		windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY,
		&token,
	); err != nil {
		return nil, err
	}
	name, err := windows.UTF16PtrFromString(privilegeName)
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

func (runtime *windowsRuntime) Start(profile string, _ string, version string) (int, error) {
	corePath, coreDigest := runtime.bundledCorePath, runtime.bundledCoreSHA256
	if version != "" {
		runtime.versionMu.Lock()
		var err error
		corePath, coreDigest, err = runtime.versionCore(version, 0, false)
		runtime.versionMu.Unlock()
		if err != nil {
			return 0, err
		}
	}
	digest, coreIdentity, err := hashFileWithIdentity(corePath)
	if err != nil || digest != coreDigest {
		return 0, errors.New("extracted mihomo integrity check failed")
	}
	listenerPorts, err := listenerPortsFromProfile(profile)
	if err != nil {
		return 0, err
	}
	profilePath := filepath.Join(runtime.config.StateDirectory, "session.yaml")
	if err := writePrivateFile(profilePath, []byte(profile)); err != nil {
		return 0, err
	}
	command := exec.Command(corePath, "-d", runtime.config.StateDirectory, "-f", profilePath)
	command.Dir = runtime.config.StateDirectory
	command.Env = safeWindowsEnvironment()
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
	output := newBoundedTailWriter(8 * 1024)
	command.Stdout = output
	command.Stderr = output
	// Port takeover must run inside this LocalSystem service and immediately
	// precede process creation. The desktop client cannot terminate an elevated
	// competing core and must never attempt to.
	if err := reclaimWindowsListenerPorts(listenerPorts); err != nil {
		_ = os.Remove(profilePath)
		return 0, fmt.Errorf("reclaim listener ports: %w", err)
	}
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
	runtime.processMu.Lock()
	if runtime.processOutput == nil {
		runtime.processOutput = make(map[int]*boundedTailWriter)
	}
	runtime.processOutput[command.Process.Pid] = output
	runtime.processMu.Unlock()
	go func() { _ = command.Wait() }()
	runtime.corePath = corePath
	runtime.coreSHA256 = coreDigest
	runtime.coreIdentity = &coreIdentity
	return command.Process.Pid, nil
}

func (runtime *windowsRuntime) ReadProvider(kind string, name string) (providerContent, error) {
	content, err := resolveProviderContent(runtime.config.StateDirectory, kind, name)
	if err != nil || content.Format != "mrs" {
		return content, err
	}
	if content.Behavior != "domain" && content.Behavior != "ipcidr" && content.Behavior != "classical" {
		return providerContent{}, errProviderMRSConvert
	}
	if digest, err := hashFile(runtime.corePath); err != nil || digest != runtime.coreSHA256 {
		return providerContent{}, errProviderMRSConvert
	}
	temporary, err := os.CreateTemp(runtime.config.StateDirectory, "mrs-view-*.txt")
	if err != nil {
		return providerContent{}, fmt.Errorf("%w: temporary output: %v", errProviderContentRead, err)
	}
	temporaryPath := temporary.Name()
	_ = temporary.Close()
	defer os.Remove(temporaryPath)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, runtime.corePath, "convert-ruleset", content.Behavior, "mrs", content.Path, temporaryPath)
	command.Dir = runtime.config.StateDirectory
	command.Env = safeWindowsEnvironment()
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := command.Run(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return providerContent{}, errProviderMRSConvertTimeout
		}
		return providerContent{}, errProviderMRSConvert
	}
	info, err := os.Stat(temporaryPath)
	if err != nil || info.Size() > maxProviderContentBytes {
		return providerContent{}, errProviderContentTooLarge
	}
	data, err := os.ReadFile(temporaryPath)
	if err != nil || !utf8.Valid(data) {
		return providerContent{}, errProviderContentInvalid
	}
	return providerContent{Text: string(data), Format: "text", Source: "cache"}, nil
}

func (runtime *windowsRuntime) Stop(pid int) error {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(pid))
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return nil
	}
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if err := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size); err != nil {
		return err
	}
	observedPath := windows.UTF16ToString(buffer[:size])
	if !strings.EqualFold(filepath.Clean(observedPath), filepath.Clean(runtime.corePath)) {
		return errors.New("refusing to stop reused PID")
	}
	if digest, err := hashFile(observedPath); err != nil || digest != runtime.coreSHA256 {
		return errors.New("refusing to stop unverified process")
	}
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
	runtime.processMu.Lock()
	delete(runtime.processOutput, pid)
	runtime.processMu.Unlock()
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
		var exitCode uint32
		_ = windows.GetExitCodeProcess(handle, &exitCode)
		runtime.processMu.Lock()
		output := runtime.processOutput[pid]
		delete(runtime.processOutput, pid)
		runtime.processMu.Unlock()
		detail := ""
		if output != nil {
			detail = output.String()
		}
		if detail == "" {
			detail = fmt.Sprintf("exit code %d", exitCode)
		}
		return false, fmt.Errorf("%w: %s", errOwnedProcessExited, detail)
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
	identity, err := fileIdentityForPath(observedPath)
	if err != nil {
		return false, err
	}
	// The protected core is immutable in steady state. Re-hash only when its
	// stable file identity changed instead of reading the whole binary every five
	// seconds during liveness reconciliation.
	if runtime.coreIdentity == nil || *runtime.coreIdentity != identity {
		digest, verifiedIdentity, hashErr := hashFileWithIdentity(observedPath)
		if hashErr != nil || digest != runtime.coreSHA256 {
			return false, errors.New("owned PID executable digest mismatch")
		}
		runtime.coreIdentity = &verifiedIdentity
	}
	if err := windows.AssignProcessToJobObject(runtime.job, handle); err != nil {
		return false, errors.New("failed to attach owned mihomo to service job object")
	}
	return true, nil
}

func hashFile(path string) (string, error) {
	digest, _, err := hashFileWithIdentity(path)
	return digest, err
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
