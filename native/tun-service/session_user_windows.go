//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The installer runs elevated, and its token is not always the user who will
// use the app: a standard user who elevates with a separate administrator
// account ("over the shoulder") gets an installer running as that
// administrator. The user who owns the shell on the installer's desktop is the
// one sitting at it, so that is the account the service must trust and the
// account whose proxy state and startup task the installer manages.
//
// When there is no shell on this desktop (a silent deployment from a service
// session) the installer's own token is the only identity there is, which is
// what earlier releases always used.

var (
	user32                      = windows.NewLazySystemDLL("user32.dll")
	procGetShellWindow          = user32.NewProc("GetShellWindow")
	advapi32                    = windows.NewLazySystemDLL("advapi32.dll")
	procCreateProcessWithTokenW = advapi32.NewProc("CreateProcessWithTokenW")
)

var errNoSessionShell = errors.New("no shell window on this desktop")

const clientProxyRestoreTimeout = 90 * time.Second

// sessionShellToken returns a primary token for the user who owns the shell
// of the calling process's desktop. The caller closes it.
func sessionShellToken() (windows.Token, error) {
	hwnd, _, _ := procGetShellWindow.Call()
	if hwnd == 0 {
		return 0, errNoSessionShell
	}
	var processID uint32
	if _, err := windows.GetWindowThreadProcessId(windows.HWND(hwnd), &processID); err != nil {
		return 0, fmt.Errorf("resolve shell process: %w", err)
	}
	var ownSession, shellSession uint32
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &ownSession); err != nil {
		return 0, err
	}
	if err := windows.ProcessIdToSessionId(processID, &shellSession); err != nil {
		return 0, err
	}
	if ownSession != shellSession {
		return 0, errors.New("shell window belongs to another session")
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, processID)
	if err != nil {
		return 0, fmt.Errorf("open shell process: %w", err)
	}
	defer windows.CloseHandle(process)
	var shellToken windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY, &shellToken); err != nil {
		return 0, fmt.Errorf("open shell token: %w", err)
	}
	defer shellToken.Close()
	var primary windows.Token
	access := uint32(windows.TOKEN_QUERY | windows.TOKEN_DUPLICATE | windows.TOKEN_ASSIGN_PRIMARY | windows.TOKEN_ADJUST_DEFAULT | windows.TOKEN_ADJUST_SESSIONID)
	if err := windows.DuplicateTokenEx(shellToken, access, nil, windows.SecurityImpersonation, windows.TokenPrimary, &primary); err != nil {
		return 0, fmt.Errorf("duplicate shell token: %w", err)
	}
	return primary, nil
}

// installingUserSID is the account the service trusts and the installer acts
// for: the desktop's shell user, else the installer's own user.
func installingUserSID(own windows.Token) (string, error) {
	if shell, err := sessionShellToken(); err == nil {
		defer shell.Close()
		user, err := shell.GetTokenUser()
		if err != nil {
			return "", err
		}
		return user.User.Sid.String(), nil
	} else if !errors.Is(err, errNoSessionShell) {
		// A shell exists but cannot be inspected; guessing a different account
		// would bind the service to the wrong user.
		return "", fmt.Errorf("identify the signed-in user: %w", err)
	}
	user, err := own.GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String(), nil
}

// restoreClientProxy runs the installed GUI's headless proxy restore as the
// signed-in user, whose HKCU and AppData hold the proxy state, and returns its
// exit code. Only the template's client executable can be run this way.
func restoreClientProxy(clientPath string) (uint32, error) {
	if _, err := os.Stat(clientPath); err != nil {
		return 0, err
	}
	commandLine := windows.ComposeCommandLine([]string{clientPath, "--restore-system-proxy"})
	shell, err := sessionShellToken()
	if errors.Is(err, errNoSessionShell) {
		return runAndWait(clientPath, commandLine, 0)
	}
	if err != nil {
		return 0, err
	}
	defer shell.Close()
	return runAndWait(clientPath, commandLine, shell)
}

// runAndWait starts the program (as token's user when token is non-zero) and
// waits for it. A run past the timeout is terminated and reported as failure.
func runAndWait(program, commandLine string, token windows.Token) (uint32, error) {
	programPtr, err := windows.UTF16PtrFromString(program)
	if err != nil {
		return 0, err
	}
	commandPtr, err := windows.UTF16PtrFromString(commandLine)
	if err != nil {
		return 0, err
	}
	startup := &windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfo{}))}
	process := &windows.ProcessInformation{}
	if token == 0 {
		err = windows.CreateProcess(programPtr, commandPtr, nil, nil, false, windows.CREATE_NO_WINDOW, nil, nil, startup, process)
	} else {
		var environment []string
		environment, err = token.Environ(false)
		if err != nil {
			return 0, fmt.Errorf("build user environment: %w", err)
		}
		block, blockErr := environmentBlock(environment)
		if blockErr != nil {
			return 0, blockErr
		}
		// CreateProcessWithTokenW needs SeImpersonatePrivilege, which an elevated
		// administrator token holds; CreateProcessAsUser would need
		// SeAssignPrimaryTokenPrivilege, which it does not.
		const logonWithProfile = 0x00000001
		result, _, callErr := procCreateProcessWithTokenW.Call(
			uintptr(token), logonWithProfile,
			uintptr(unsafe.Pointer(programPtr)), uintptr(unsafe.Pointer(commandPtr)),
			uintptr(windows.CREATE_NO_WINDOW|windows.CREATE_UNICODE_ENVIRONMENT),
			uintptr(unsafe.Pointer(&block[0])), 0,
			uintptr(unsafe.Pointer(startup)), uintptr(unsafe.Pointer(process)),
		)
		if result == 0 {
			err = callErr
		}
	}
	if err != nil {
		return 0, fmt.Errorf("start %s: %w", program, err)
	}
	defer windows.CloseHandle(process.Process)
	defer windows.CloseHandle(process.Thread)
	event, err := windows.WaitForSingleObject(process.Process, uint32(clientProxyRestoreTimeout/time.Millisecond))
	if err != nil {
		return 0, err
	}
	if event != windows.WAIT_OBJECT_0 {
		_ = windows.TerminateProcess(process.Process, 1)
		return 0, errors.New("proxy restore timed out")
	}
	var code uint32
	if err := windows.GetExitCodeProcess(process.Process, &code); err != nil {
		return 0, err
	}
	return code, nil
}

// environmentBlock encodes KEY=VALUE pairs as a double-NUL-terminated UTF-16 block.
func environmentBlock(environment []string) ([]uint16, error) {
	var block []uint16
	for _, entry := range environment {
		if strings.ContainsRune(entry, 0) {
			return nil, errors.New("environment entry contains NUL")
		}
		encoded, err := windows.UTF16FromString(entry)
		if err != nil {
			return nil, err
		}
		block = append(block, encoded...)
	}
	if len(block) == 0 {
		block = append(block, 0)
	}
	return append(block, 0), nil
}
