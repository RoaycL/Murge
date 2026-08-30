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

func TestRejectUnsafeProfileMutations(t *testing.T) {
	mutations := []string{
		"strict-route: true", "auto-route: false", "allow-lan: true",
		"external-controller: 0.0.0.0:19090", "MATCH,REJECT",
	}
	replacements := []string{
		"strict-route: false", "auto-route: true", "allow-lan: false",
		"external-controller: 127.0.0.1:19090", "MATCH,DIRECT",
	}
	for index, mutation := range mutations {
		profile := stringsReplaceOnce(safeProfile, replacements[index], mutation)
		if _, err := decodeRequest(encodedStart(profile)); err == nil {
			t.Fatalf("accepted %s", mutation)
		}
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
