package main

import (
	"errors"
	"testing"
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
	started   int
	stopped   []int
	startErr  error
	stopErr   error
	inspectFn func(pid int) (bool, error)
}

func (runtime *flakyRuntime) Start(_ string, _ string) (int, error) {
	if runtime.startErr != nil {
		return 0, runtime.startErr
	}
	runtime.started++
	return 4200 + runtime.started, nil
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
