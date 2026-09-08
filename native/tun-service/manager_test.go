package main

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

// flakyStore fails its first N reads, then behaves. It models the transient
// filesystem errors (antivirus scan, backup reader) that must NOT latch the
// fail-closed `blocked` state permanently.
type flakyStore struct {
	failReads int
	record    *ownedProcess
	writes    int
	clears    int
}

func (store *flakyStore) Read() (*ownedProcess, error) {
	if store.failReads > 0 {
		store.failReads--
		return nil, errors.New("transient store read failure")
	}
	if store.record == nil {
		return nil, nil
	}
	copy := *store.record
	return &copy, nil
}

func (store *flakyStore) Write(owned ownedProcess) error {
	store.writes++
	store.record = &owned
	return nil
}

func (store *flakyStore) Clear() error {
	store.clears++
	store.record = nil
	return nil
}

type flakyRuntime struct {
	started      int
	stopped      []int
	startErr     error
	stopErr      error
	inspectFn    func(pid int) (bool, error)
	installed    []string
	installGate  <-chan struct{}
	validateGate <-chan struct{}
}

func (runtime *flakyRuntime) Start(_ string, _ string, _ string) (int, error) {
	if runtime.startErr != nil {
		return 0, runtime.startErr
	}
	runtime.started++
	return 4200 + runtime.started, nil
}

func (runtime *flakyRuntime) Validate(_ string, _ string) error {
	if runtime.validateGate != nil {
		<-runtime.validateGate
	}
	return nil
}

func (runtime *flakyRuntime) Install(version string, _ int) error {
	if runtime.installGate != nil {
		<-runtime.installGate
	}
	runtime.installed = append(runtime.installed, version)
	return nil
}

func TestSlowInstallDoesNotBlockLifecycleStatus(t *testing.T) {
	gate := make(chan struct{})
	runtime := &flakyRuntime{installGate: gate}
	manager := newSessionManager(runtime, &flakyStore{})
	done := make(chan serviceResponse, 1)
	go func() {
		done <- manager.Handle(serviceRequest{Operation: "install", Version: "v1.19.29"})
	}()
	time.Sleep(10 * time.Millisecond)
	statusDone := make(chan serviceResponse, 1)
	go func() { statusDone <- manager.Handle(serviceRequest{Operation: "status"}) }()
	select {
	case response := <-statusDone:
		if response.Outcome != "stopped" {
			t.Fatalf("unexpected status during install: %+v", response)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("status was blocked behind version download")
	}
	close(gate)
	if response := <-done; response.Outcome != "installed" {
		t.Fatalf("install did not finish: %+v", response)
	}
}

func TestSlowValidationDoesNotBlockLifecycleStatus(t *testing.T) {
	gate := make(chan struct{})
	manager := newSessionManager(&flakyRuntime{validateGate: gate}, &flakyStore{})
	done := make(chan serviceResponse, 1)
	go func() { done <- manager.Handle(serviceRequest{Operation: "validate", Profile: safeProfile}) }()
	time.Sleep(10 * time.Millisecond)
	status := manager.Handle(serviceRequest{Operation: "status"})
	if status.Outcome != "stopped" {
		t.Fatalf("unexpected status during validation: %+v", status)
	}
	close(gate)
	if response := <-done; response.Outcome != "valid" {
		t.Fatalf("validation did not finish: %+v", response)
	}
}

func (runtime *flakyRuntime) ReadProvider(kind string, name string) (providerContent, error) {
	return providerContent{Text: kind + ": " + name, Format: "yaml", Source: "cache"}, nil
}

func TestInstallDelegatesToRuntimeAndReportsInstalled(t *testing.T) {
	runtime := &flakyRuntime{}
	manager := newSessionManager(runtime, &flakyStore{})
	response := manager.Handle(serviceRequest{Operation: "install", Version: "v1.19.29", ProxyPort: 7890})
	if response.Outcome != "installed" || len(runtime.installed) != 1 || runtime.installed[0] != "v1.19.29" {
		t.Fatalf("version install did not reach runtime: response=%+v installed=%v", response, runtime.installed)
	}
}

func TestValidateDelegatesToRuntimeAndReportsValid(t *testing.T) {
	runtime := &flakyRuntime{}
	manager := newSessionManager(runtime, &flakyStore{})
	response := manager.Handle(serviceRequest{Operation: "validate", Profile: safeProfile})
	if response.Outcome != "valid" || response.ErrorCode != nil {
		t.Fatalf("validation did not succeed: %+v", response)
	}
}

func (runtime *flakyRuntime) Stop(pid int) error {
	if runtime.stopErr != nil {
		return runtime.stopErr
	}
	runtime.stopped = append(runtime.stopped, pid)
	return nil
}

func (runtime *flakyRuntime) Inspect(pid int) (bool, error) {
	if runtime.inspectFn == nil {
		return false, nil
	}
	return runtime.inspectFn(pid)
}

func TestReconcileRetriesTransientStoreReadsBeforeLatchingBlocked(t *testing.T) {
	store := &flakyStore{failReads: 2}
	manager := newSessionManager(&flakyRuntime{}, store)
	response := serviceResponse{}
	if err := manager.reconcile(&response); err != nil {
		t.Fatalf("transient store errors must be retried, got: %v", err)
	}
	if response.Outcome != "stopped" {
		t.Fatalf("expected stopped, got %q", response.Outcome)
	}
	if manager.blocked {
		t.Fatal("a transient store error must not latch blocked")
	}
}

func TestReconcileStillLatchesBlockedOnPersistentStoreFailure(t *testing.T) {
	store := &flakyStore{failReads: 1_000_000}
	manager := newSessionManager(&flakyRuntime{}, store)
	response := serviceResponse{}
	if err := manager.reconcile(&response); err == nil {
		t.Fatal("a persistent store failure must still fail closed")
	}
	if !manager.blocked {
		t.Fatal("a persistent store failure must latch blocked")
	}
}

func TestReconcileClearsExitedChildAndReturnsItsDiagnostic(t *testing.T) {
	store := &flakyStore{record: &ownedProcess{SessionID: "session-1", PID: 4242}}
	runtime := &flakyRuntime{inspectFn: func(int) (bool, error) {
		return false, fmt.Errorf("%w: configuration rejected", errOwnedProcessExited)
	}}
	manager := newSessionManager(runtime, store)
	response := manager.Handle(serviceRequest{Operation: "reconcile"})
	if response.Outcome != "failed" || response.ValidationMessage == nil || !strings.Contains(*response.ValidationMessage, "configuration rejected") {
		t.Fatalf("exited child diagnostic was not returned: %+v", response)
	}
	if store.record != nil || manager.owned != nil || manager.conflict || manager.blocked {
		t.Fatalf("exited child ownership was not cleared: store=%+v manager=%+v", store.record, manager.owned)
	}
}

func TestExitedChildDiagnosticSurvivesLaterStatusAndReconcile(t *testing.T) {
	store := &flakyStore{record: &ownedProcess{SessionID: "session-1", PID: 4242}}
	runtime := &flakyRuntime{inspectFn: func(int) (bool, error) {
		return false, fmt.Errorf("%w: provider download failed", errOwnedProcessExited)
	}}
	manager := newSessionManager(runtime, store)
	first := manager.Handle(serviceRequest{Operation: "reconcile"})
	if first.ValidationMessage == nil || !strings.Contains(*first.ValidationMessage, "provider download failed") {
		t.Fatalf("first reconcile lost diagnostic: %+v", first)
	}
	for _, operation := range []string{"status", "reconcile", "status"} {
		response := manager.Handle(serviceRequest{Operation: operation})
		if response.Outcome != "failed" {
			t.Fatalf("%s returned protocol-incompatible outcome: %+v", operation, response)
		}
		if response.ValidationMessage == nil || !strings.Contains(*response.ValidationMessage, "provider download failed") {
			t.Fatalf("%s consumed diagnostic: %+v", operation, response)
		}
	}
}

func TestStartAttemptsRecoveryBeforeRefusingWhileBlocked(t *testing.T) {
	store := &flakyStore{failReads: 1_000_000}
	runtime := &flakyRuntime{}
	manager := newSessionManager(runtime, store)
	// Latch blocked with a failing reconcile.
	latchResponse := serviceResponse{}
	_ = manager.reconcile(&latchResponse)
	if !manager.blocked {
		t.Fatal("precondition: blocked latched")
	}
	// The store recovers (empty record): the next start clears the latch and
	// proceeds instead of wedging until service restart.
	store.failReads = 0
	startResponse := serviceResponse{}
	if err := manager.start(serviceRequest{Profile: safeProfile, SessionID: "s-1"}, &startResponse); err != nil {
		t.Fatalf("start must recover through reconcile when the store is readable again: %v", err)
	}
	if startResponse.Outcome != "running" {
		t.Fatalf("expected running, got %q", startResponse.Outcome)
	}
	if manager.blocked {
		t.Fatal("a successful reconcile must clear the blocked latch")
	}
}

func TestStartStillRefusesWhileStoreRemainsBroken(t *testing.T) {
	store := &flakyStore{failReads: 1_000_000}
	manager := newSessionManager(&flakyRuntime{}, store)
	latchResponse := serviceResponse{}
	_ = manager.reconcile(&latchResponse)
	startResponse := serviceResponse{}
	if err := manager.start(serviceRequest{Profile: safeProfile, SessionID: "s-1"}, &startResponse); err == nil {
		t.Fatal("start must refuse while the store is still unreadable")
	}
	if startResponse.Outcome != "conflict" {
		t.Fatalf("expected conflict, got %q", startResponse.Outcome)
	}
	if manager.startedOwned() {
		t.Fatal("no child may start while recovery is blocked")
	}
}

func (manager *sessionManager) startedOwned() bool {
	return manager.owned != nil
}
