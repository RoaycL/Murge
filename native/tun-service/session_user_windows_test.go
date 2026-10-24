//go:build windows

package main

import (
	"reflect"
	"testing"

	"golang.org/x/sys/windows"
)

func TestEnvironmentBlockIsDoubleNulTerminated(t *testing.T) {
	block, err := environmentBlock([]string{"A=1", "B=2"})
	if err != nil {
		t.Fatal(err)
	}
	want := append(append(windows.StringToUTF16("A=1"), windows.StringToUTF16("B=2")...), 0)
	if !reflect.DeepEqual(block, want) {
		t.Fatalf("unexpected block: %v", block)
	}
	empty, err := environmentBlock(nil)
	if err != nil || !reflect.DeepEqual(empty, []uint16{0, 0}) {
		t.Fatalf("empty block: %v %v", empty, err)
	}
	if _, err := environmentBlock([]string{"A=\x00"}); err == nil {
		t.Fatal("NUL inside an entry must be rejected")
	}
}

func TestOnlyInstallerOperationsBypassTheServiceEntry(t *testing.T) {
	for _, argument := range []string{"--install", "--uninstall", "--session-user-sid", "--restore-client-proxy"} {
		if !isInstallerOperation(argument) {
			t.Fatalf("%s should be an installer operation", argument)
		}
	}
	for _, argument := range []string{"--console", "--restore-system-proxy", ""} {
		if isInstallerOperation(argument) {
			t.Fatalf("%q must not be an installer operation", argument)
		}
	}
}

func TestInstalledClientPathIsTheGuiNextToResources(t *testing.T) {
	got := installedClientPath(`C:\Program Files\App\resources\tun-service`, serviceTemplate{ClientExecutableName: "app"})
	if got != `C:\Program Files\App\app.exe` {
		t.Fatalf("unexpected client path: %s", got)
	}
}
