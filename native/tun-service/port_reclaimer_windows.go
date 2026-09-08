//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

type windowsListenerProcessAdapter struct{}

func (windowsListenerProcessAdapter) Inspect(ports []int) ([]listenerOwner, error) {
	command := exec.Command("netstat.exe", "-ano")
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := command.Output()
	if err != nil {
		return nil, err
	}
	return parseNetstatOwners(string(output), ports), nil
}

func (windowsListenerProcessAdapter) Terminate(pid int) error {
	if pid <= 4 || pid == os.Getpid() {
		return fmt.Errorf("refusing to terminate protected process %d", pid)
	}
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(pid))
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return nil
	}
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	if err := windows.TerminateProcess(handle, 1); err != nil {
		return err
	}
	result, err := windows.WaitForSingleObject(handle, 5_000)
	if err != nil {
		return err
	}
	if result != windows.WAIT_OBJECT_0 {
		return errors.New("listener process termination was not confirmed")
	}
	return nil
}

func reclaimWindowsListenerPorts(ports []int) error {
	return reclaimListenerPorts(ports, os.Getpid(), windowsListenerProcessAdapter{})
}
