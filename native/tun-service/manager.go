package main

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

type ownedProcess struct {
	SessionID string `json:"sessionId"`
	PID       int    `json:"pid"`
}

type processRuntime interface {
	Start(profile string, sessionID string) (int, error)
	Stop(pid int) error
	Inspect(pid int) (bool, error)
}

type ownershipStore interface {
	Read() (*ownedProcess, error)
	Write(ownedProcess) error
	Clear() error
}

type sessionManager struct {
	mu       sync.Mutex
	runtime  processRuntime
	store    ownershipStore
	owned    *ownedProcess
	conflict bool
	blocked  bool
}

func newSessionManager(runtime processRuntime, store ownershipStore) *sessionManager {
	return &sessionManager{runtime: runtime, store: store}
}

func (manager *sessionManager) Handle(request serviceRequest) serviceResponse {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	response := serviceResponse{ProtocolVersion: protocolVersion, RequestID: request.RequestID}
	var err error
	switch request.Operation {
	case "start":
		err = manager.start(request, &response)
	case "stop":
		err = manager.stop(request, &response)
	case "status":
		manager.status(&response)
	case "reconcile":
		err = manager.reconcile(&response)
	default:
		err = errors.New("operation is not allowlisted")
	}
	if err != nil {
		code := "TUN_SERVICE_OPERATION_FAILED"
		response.ErrorCode = &code
		if response.Outcome == "" {
			response.Outcome = "failed"
		}
	}
	return response
}

func (manager *sessionManager) start(request serviceRequest, response *serviceResponse) error {
	if manager.blocked {
		// One recovery attempt before refusing: a reconcile that can read the
		// store (and finds no record or a live match) clears the latch, so a
		// transient store error never wedges enable until service restart.
		probe := serviceResponse{}
		if err := manager.reconcile(&probe); err != nil {
			response.Outcome = "conflict"
			return errors.New("service recovery is blocked")
		}
		if manager.blocked {
			response.Outcome = "conflict"
			return errors.New("service recovery is blocked")
		}
	}
	if manager.owned != nil {
		response.Outcome = "conflict"
		response.SessionID = &manager.owned.SessionID
		response.PID = &manager.owned.PID
		return errors.New("a child is already owned")
	}
	pid, err := manager.runtime.Start(request.Profile, request.SessionID)
	if err != nil {
		response.Outcome = "failed"
		return err
	}
	owned := ownedProcess{SessionID: request.SessionID, PID: pid}
	if err := manager.store.Write(owned); err != nil {
		if stopErr := manager.runtime.Stop(pid); stopErr != nil {
			manager.owned = &owned
			response.Outcome = "stopping"
			response.SessionID = &owned.SessionID
			response.PID = &owned.PID
			return fmt.Errorf("persist ownership: %v; emergency stop: %w", err, stopErr)
		}
		response.Outcome = "failed"
		return fmt.Errorf("persist ownership: %w", err)
	}
	manager.owned = &owned
	response.Outcome = "running"
	response.SessionID = &owned.SessionID
	response.PID = &owned.PID
	return nil
}

func (manager *sessionManager) stop(request serviceRequest, response *serviceResponse) error {
	if manager.blocked || manager.conflict {
		response.Outcome = "conflict"
		if manager.owned != nil {
			response.SessionID = &manager.owned.SessionID
			response.PID = &manager.owned.PID
		}
		return errors.New("refusing to stop an unverified process")
	}
	if manager.owned == nil {
		response.Outcome = "stopped"
		return nil
	}
	if request.SessionID != manager.owned.SessionID {
		response.Outcome = "conflict"
		response.SessionID = &manager.owned.SessionID
		response.PID = &manager.owned.PID
		return errors.New("session ownership mismatch")
	}
	if err := manager.runtime.Stop(manager.owned.PID); err != nil {
		response.Outcome = "stopping"
		response.SessionID = &manager.owned.SessionID
		response.PID = &manager.owned.PID
		return err
	}
	if err := manager.store.Clear(); err != nil {
		response.Outcome = "failed"
		return err
	}
	manager.owned = nil
	response.Outcome = "stopped"
	return nil
}

func (manager *sessionManager) status(response *serviceResponse) {
	if manager.blocked || manager.conflict {
		response.Outcome = "conflict"
		if manager.owned != nil {
			response.SessionID = &manager.owned.SessionID
			response.PID = &manager.owned.PID
		}
		return
	}
	if manager.owned == nil {
		response.Outcome = "stopped"
		return
	}
	response.Outcome = "running"
	response.SessionID = &manager.owned.SessionID
	response.PID = &manager.owned.PID
}

func (manager *sessionManager) reconcile(response *serviceResponse) error {
	recorded, err := manager.readStoreResilient()
	if err != nil {
		manager.blocked = true
		response.Outcome = "failed"
		return err
	}
	if recorded == nil {
		manager.owned = nil
		manager.blocked = false
		manager.conflict = false
		response.Outcome = "stopped"
		return nil
	}
	live, err := manager.runtime.Inspect(recorded.PID)
	if err != nil {
		manager.owned = recorded
		manager.conflict = true
		response.Outcome = "conflict"
		response.SessionID = &recorded.SessionID
		response.PID = &recorded.PID
		return err
	}
	if !live {
		if err := manager.store.Clear(); err != nil {
			response.Outcome = "failed"
			return err
		}
		manager.owned = nil
		manager.blocked = false
		manager.conflict = false
		response.Outcome = "stopped"
		return nil
	}
	manager.owned = recorded
	manager.blocked = false
	manager.conflict = false
	response.Outcome = "running"
	response.SessionID = &recorded.SessionID
	response.PID = &recorded.PID
	return nil
}

// readStoreResilient reads the ownership store with a short bounded retry so a
// TRANSIENT filesystem error (antivirus scan, backup reader, page fault storm)
// does not latch the fail-closed `blocked` state and wedge the service until
// restart. A persistent failure still returns the error and latches exactly as
// before — fail-closed is preserved, only single-shot blips are absorbed.
func (manager *sessionManager) readStoreResilient() (*ownedProcess, error) {
	const attempts = 3
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		recorded, err := manager.store.Read()
		if err == nil {
			return recorded, nil
		}
		lastErr = err
		time.Sleep(50 * time.Millisecond)
	}
	return nil, lastErr
}
