//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestCopyFileAtomicWaitsForDestinationImageLock(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "new.exe")
	destination := filepath.Join(root, "service.exe")
	if err := os.WriteFile(source, []byte("new service"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, []byte("old service"), 0600); err != nil {
		t.Fatal(err)
	}
	pointer, err := windows.UTF16PtrFromString(destination)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(
		pointer,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		t.Fatal(err)
	}
	released := make(chan struct{})
	go func() {
		time.Sleep(500 * time.Millisecond)
		_ = windows.CloseHandle(handle)
		close(released)
	}()
	if err := copyFileAtomic(source, destination); err != nil {
		t.Fatal(err)
	}
	<-released
	content, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "new service" {
		t.Fatalf("destination was not replaced: %q", content)
	}
}
