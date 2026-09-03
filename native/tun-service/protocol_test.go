package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"
)

const safeProfile = `mixed-port: 17890
allow-lan: false
mode: direct
log-level: info
ipv6: false
external-controller: 127.0.0.1:19090
secret: abababababababababababababababababababababababababababababababab
tun:
  enable: true
  device: Product TUN
  stack: mixed
  auto-route: true
  auto-detect-interface: true
  strict-route: false
  dns-hijack:
    - any:53
dns:
  enable: true
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver:
    - system
rules:
  - MATCH,DIRECT
`

// proxiedProfile is what the main process now submits: a real subscription's
// proxies, groups, providers and rules on top of the same structural boundary.
const proxiedProfile = `mixed-port: 17890
allow-lan: false
bind-address: 127.0.0.1
mode: rule
log-level: info
external-controller: 127.0.0.1:19090
secret: abababababababababababababababababababababababababababababababab
proxies:
  - name: node-a
    type: ss
    server: example.invalid
    port: 8388
    cipher: aes-128-gcm
    password: pw
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - node-a
      - DIRECT
proxy-providers:
  vendor:
    type: http
    url: https://example.invalid/sub.yaml
    path: ./providers/vendor.yaml
rule-providers:
  reject:
    type: http
    behavior: domain
    url: https://example.invalid/reject.yaml
    path: ./ruleset/reject.yaml
tun:
  enable: true
  device: Product TUN
  stack: mixed
  auto-route: true
  auto-detect-interface: true
  strict-route: false
  mtu: 9000
  dns-hijack:
    - any:53
dns:
  enable: true
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver:
    - 223.5.5.5
  fallback:
    - 1.1.1.1
rules:
  - RULE-SET,reject,REJECT
  - GEOIP,CN,DIRECT
  - MATCH,PROXY
`

func encodedStart(profile string) []byte {
	digest := sha256.Sum256([]byte(profile))
	data, _ := json.Marshal(serviceRequest{
		ProtocolVersion: 2, RequestID: "1", Operation: "start",
		SessionID: "8a86eb80-621f-4a73-8249-1e4455df80de",
		Profile:   profile, ProfileSHA256: hex.EncodeToString(digest[:]),
	})
	return data
}

func TestDecodeSafeStart(t *testing.T) {
	if _, err := decodeRequest(encodedStart(safeProfile)); err != nil {
		t.Fatal(err)
	}
}

// The service must now accept real proxy content: that is the point of a TUN
// proxy. Only the structural boundary stays enforced.
func TestAcceptProxiedProfile(t *testing.T) {
	if _, err := decodeRequest(encodedStart(proxiedProfile)); err != nil {
		t.Fatalf("rejected a legitimate proxied profile: %v", err)
	}
}

// Content that used to be refused by the DIRECT-only policy is now allowed.
func TestAcceptProxyContentMutations(t *testing.T) {
	accepted := []struct {
		name        string
		replacement string
		original    string
	}{
		{"reject rule", "  - MATCH,REJECT", "  - MATCH,PROXY"},
		{"rule mode", "mode: rule", "mode: rule"},
		{"ipv6 enabled", "mode: rule\nipv6: true", "mode: rule"},
		{"strict route", "  strict-route: true", "  strict-route: false"},
		{"auto route off", "  auto-route: false", "  auto-route: true"},
		{"extra dns hijack", "    - any:53\n    - 198.18.0.2:53", "    - any:53"},
		{"custom fake-ip range", "  fake-ip-range: 28.0.0.1/8", "  fake-ip-range: 198.18.0.1/16"},
	}
	for _, row := range accepted {
		profile := stringsReplaceOnce(proxiedProfile, row.original, row.replacement)
		if _, err := decodeRequest(encodedStart(profile)); err != nil {
			t.Fatalf("%s: rejected legitimate content: %v", row.name, err)
		}
	}
}

// The non-negotiable structural boundary must still fail closed.
func TestRejectUnsafeProfileMutations(t *testing.T) {
	rejected := []struct {
		name        string
		original    string
		replacement string
	}{
		{"lan bind", "allow-lan: false", "allow-lan: true"},
		{"public controller", "external-controller: 127.0.0.1:19090", "external-controller: 0.0.0.0:19090"},
		{"public bind-address", "bind-address: 127.0.0.1", "bind-address: 0.0.0.0"},
		{"tun disabled", "  enable: true", "  enable: false"},
		{"bad device", "  device: Product TUN", "  device: bad\\nname"},
		{"bad stack", "  stack: mixed", "  stack: hyper"},
		{"short secret", "secret: abababababababababababababababababababababababababababababababab", "secret: abc"},
		{"privileged port", "mixed-port: 17890", "mixed-port: 53"},
		{"extra http inbound", "mode: rule", "mode: rule\nport: 7890"},
		{"socks inbound", "mode: rule", "mode: rule\nsocks-port: 7891"},
		{"redir inbound", "mode: rule", "mode: rule\nredir-port: 7892"},
		{"tproxy inbound", "mode: rule", "mode: rule\ntproxy-port: 7893"},
		{"extra listeners", "mode: rule", "mode: rule\nlisteners:\n  - name: in\n    type: http\n    port: 1080"},
		{"unauthenticated pipe controller", "mode: rule", "mode: rule\nexternal-controller-pipe: \\\\.\\pipe\\evil"},
		{"unauthenticated unix controller", "mode: rule", "mode: rule\nexternal-controller-unix: /tmp/evil.sock"},
		{"unauthenticated tls controller", "mode: rule", "mode: rule\nexternal-controller-tls: 0.0.0.0:9443"},
		{"external doh server", "mode: rule", "mode: rule\nexternal-doh-server: /dns-query"},
		{"external ui path", "mode: rule", "mode: rule\nexternal-ui: C:\\Windows\\Temp\\ui"},
		{"external ui download", "mode: rule", "mode: rule\nexternal-ui-url: https://attacker.invalid/ui.zip"},
		{"external ui name", "mode: rule", "mode: rule\nexternal-ui-name: evil"},
		{"tunnels inbound", "mode: rule", "mode: rule\ntunnels:\n  - tcp/udp,0.0.0.0:12345,10.0.0.5:22,node-a"},
		{"ntp clock write", "mode: rule", "mode: rule\nntp:\n  enable: true\n  server: 1.2.3.4\n  write-to-system: true"},
		{"controller cors", "mode: rule", "mode: rule\nexternal-controller-cors:\n  allow-origins:\n    - '*'\n  allow-private-network: true"},
		{"absolute provider path", "    path: ./ruleset/reject.yaml", "    path: C:\\Windows\\System32\\evil.dll"},
		{"traversing provider path", "    path: ./ruleset/reject.yaml", "    path: ../../../../Windows/System32/evil.dll"},
		{"rooted provider path", "    path: ./ruleset/reject.yaml", "    path: /Windows/System32/evil.dll"},
		{"drive relative provider path", "    path: ./ruleset/reject.yaml", "    path: C:evil.dll"},
		{"public dns bind", "  enhanced-mode: fake-ip", "  enhanced-mode: fake-ip\n  listen: 0.0.0.0:53"},
		{"dns disabled", "  enable: true\n  enhanced-mode: fake-ip", "  enable: false\n  enhanced-mode: fake-ip"},
		{"redir-host dns", "  enhanced-mode: fake-ip", "  enhanced-mode: redir-host"},
	}
	for _, row := range rejected {
		profile := stringsReplaceOnce(proxiedProfile, row.original, row.replacement)
		if profile == proxiedProfile {
			t.Fatalf("%s: test fixture did not change (bad anchor %q)", row.name, row.original)
		}
		if _, err := decodeRequest(encodedStart(profile)); err == nil {
			t.Fatalf("%s: accepted an unsafe profile", row.name)
		}
	}
}

// A missing TUN/DNS block must fail closed rather than default to permissive.
func TestRejectMissingRequiredBlocks(t *testing.T) {
	minimal := `mixed-port: 17890
allow-lan: false
external-controller: 127.0.0.1:19090
secret: abababababababababababababababababababababababababababababababab
rules:
  - MATCH,DIRECT
`
	if _, err := decodeRequest(encodedStart(minimal)); err == nil {
		t.Fatal("accepted a profile with no tun block")
	}
}

// YAML-level smuggling must still be refused regardless of content policy.
func TestRejectYAMLTricks(t *testing.T) {
	alias := stringsReplaceOnce(proxiedProfile, "  device: Product TUN", "  device: &d Product TUN\n  extra: *d")
	if _, err := decodeRequest(encodedStart(alias)); err == nil {
		t.Fatal("accepted YAML aliases")
	}
	tagged := stringsReplaceOnce(proxiedProfile, "  device: Product TUN", "  device: !!python/object Product TUN")
	if _, err := decodeRequest(encodedStart(tagged)); err == nil {
		t.Fatal("accepted a custom YAML tag")
	}
	multi := proxiedProfile + "---\nmixed-port: 1\n"
	if _, err := decodeRequest(encodedStart(multi)); err == nil {
		t.Fatal("accepted multiple YAML documents")
	}
}

func TestRejectUnknownEnvelopeField(t *testing.T) {
	data := encodedStart(safeProfile)
	data = append(data[:len(data)-1], []byte(`,"executable":"cmd.exe"}`)...)
	if _, err := decodeRequest(data); err == nil {
		t.Fatal("accepted executable")
	}
}

type fakeRuntime struct {
	nextPID    int
	live       bool
	stopErr    error
	inspectErr error
}

func (runtime *fakeRuntime) Start(string, string) (int, error) {
	runtime.live = true
	return runtime.nextPID, nil
}
func (runtime *fakeRuntime) Stop(int) error {
	if runtime.stopErr != nil {
		return runtime.stopErr
	}
	runtime.live = false
	return nil
}
func (runtime *fakeRuntime) Inspect(int) (bool, error) { return runtime.live, runtime.inspectErr }

type memoryStore struct {
	owned    *ownedProcess
	writeErr error
}

func (store *memoryStore) Read() (*ownedProcess, error) { return store.owned, nil }
func (store *memoryStore) Write(value ownedProcess) error {
	if store.writeErr != nil {
		return store.writeErr
	}
	copy := value
	store.owned = &copy
	return nil
}
func (store *memoryStore) Clear() error { store.owned = nil; return nil }

func TestManagerRetainsOwnershipOnStopFailure(t *testing.T) {
	runtime := &fakeRuntime{nextPID: 42}
	store := &memoryStore{}
	manager := newSessionManager(runtime, store)
	start, _ := decodeRequest(encodedStart(safeProfile))
	if response := manager.Handle(start); response.Outcome != "running" {
		t.Fatalf("start: %s", response.Outcome)
	}
	runtime.stopErr = errors.New("timeout")
	response := manager.Handle(serviceRequest{ProtocolVersion: 2, RequestID: "2", Operation: "stop", SessionID: start.SessionID})
	if response.Outcome != "stopping" || manager.owned == nil {
		t.Fatal("stop failure lost ownership")
	}
}

func TestReconcileConflictNeitherStartsSecondChildNorKillsReusedPID(t *testing.T) {
	runtime := &fakeRuntime{nextPID: 99, live: true, inspectErr: errors.New("executable mismatch")}
	store := &memoryStore{owned: &ownedProcess{SessionID: "8a86eb80-621f-4a73-8249-1e4455df80de", PID: 42}}
	manager := newSessionManager(runtime, store)
	if response := manager.Handle(serviceRequest{ProtocolVersion: 2, RequestID: "1", Operation: "reconcile"}); response.Outcome != "conflict" {
		t.Fatalf("reconcile: %s", response.Outcome)
	}
	start, _ := decodeRequest(encodedStart(safeProfile))
	if response := manager.Handle(start); response.Outcome != "conflict" {
		t.Fatalf("start: %s", response.Outcome)
	}
	if response := manager.Handle(serviceRequest{ProtocolVersion: 2, RequestID: "2", Operation: "stop", SessionID: store.owned.SessionID}); response.Outcome != "conflict" {
		t.Fatalf("stop: %s", response.Outcome)
	}
	if runtime.nextPID != 99 || !runtime.live {
		t.Fatal("conflict path mutated the process")
	}
}

func TestStartPersistenceAndStopFailureBlocksASecondChild(t *testing.T) {
	runtime := &fakeRuntime{nextPID: 42, stopErr: errors.New("cannot terminate")}
	store := &memoryStore{writeErr: errors.New("disk full")}
	manager := newSessionManager(runtime, store)
	start, _ := decodeRequest(encodedStart(safeProfile))
	if response := manager.Handle(start); response.Outcome != "stopping" {
		t.Fatalf("first start: %s", response.Outcome)
	}
	runtime.nextPID = 99
	if response := manager.Handle(start); response.Outcome != "conflict" {
		t.Fatalf("second start: %s", response.Outcome)
	}
	if manager.owned == nil || manager.owned.PID != 42 {
		t.Fatal("uncertain child ownership was lost")
	}
}

func stringsReplaceOnce(value, old, replacement string) string {
	index := bytes.Index([]byte(value), []byte(old))
	if index < 0 {
		return value
	}
	return value[:index] + replacement + value[index+len(old):]
}
