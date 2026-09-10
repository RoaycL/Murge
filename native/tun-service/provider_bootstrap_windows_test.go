//go:build windows

package main

import (
	"bytes"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func freeLoopbackPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

// Opt-in real-core regression for the upgrade failure: with an unreachable
// remote provider and a completely empty home, the bootstrap cache must let
// mihomo expose its authenticated controller instead of exiting during load.
func TestRealMihomoStartsFromColdProviderCache(t *testing.T) {
	core := os.Getenv("MURGE_REAL_CORE")
	if core == "" {
		t.Skip("set MURGE_REAL_CORE to an extracted official mihomo executable")
	}
	home := t.TempDir()
	mixedPort := freeLoopbackPort(t)
	controllerPort := freeLoopbackPort(t)
	secret := "ab0123456789cdab0123456789cdab0123456789cdab0123456789cdab01"
	profile := fmt.Sprintf(`mixed-port: %d
allow-lan: false
mode: rule
log-level: info
external-controller: 127.0.0.1:%d
secret: %s
tun:
  enable: false
  device: Murge TUN
  stack: mixed
  dns-hijack: []
proxy-providers:
  ColdNodes:
    type: http
    path: ./proxy_providers/cold.yaml
    url: http://127.0.0.1:1/unreachable
    interval: 3600
rule-providers:
  ColdMrs:
    type: http
    behavior: domain
    format: mrs
    path: ./rule_providers/cold.mrs
    url: http://127.0.0.1:1/unreachable.mrs
    interval: 3600
proxy-groups:
  - name: ColdGroup
    type: select
    use: [ColdNodes]
rules:
  - RULE-SET,ColdMrs,DIRECT
  - MATCH,DIRECT
`, mixedPort, controllerPort, secret)
	runtime := windowsRuntime{config: serviceConfig{StateDirectory: home}}
	seeded, err := seedMissingProviderCaches(profile, home, func(target, behavior string) error {
		return runtime.seedMRSProviderCache(core, target, behavior)
	})
	if err != nil || len(seeded) != 2 {
		t.Fatalf("cold cache bootstrap failed: seeded=%v err=%v", seeded, err)
	}
	configPath := filepath.Join(home, "config.yaml")
	if err := os.WriteFile(configPath, []byte(profile), 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(core, "-d", home, "-f", configPath)
	command.Dir = home
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = command.Process.Kill()
		_ = command.Wait()
	}()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		request, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/version", controllerPort), nil)
		request.Header.Set("Authorization", "Bearer "+secret)
		client := http.Client{Timeout: 500 * time.Millisecond}
		if response, requestErr := client.Do(request); requestErr == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return
			}
		}
		if command.ProcessState != nil {
			t.Fatalf("mihomo exited before readiness: %s", output.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("mihomo did not start from cold provider cache: %s", output.String())
}
