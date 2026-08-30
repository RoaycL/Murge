package main

import (
	"errors"
	"fmt"
	"sync"
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
		response.Outcome = "conflict"
		return errors.New("service recovery is blocked")
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
	recorded, err := manager.store.Read()
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
