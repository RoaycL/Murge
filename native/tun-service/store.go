package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

type fileOwnershipStore struct{ path string }

func (store fileOwnershipStore) Read() (*ownedProcess, error) {
	data, err := os.ReadFile(store.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var owned ownedProcess
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&owned); err != nil {
		return nil, err
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return nil, err
	}
	if !uuidPattern.MatchString(owned.SessionID) || owned.PID <= 0 {
		return nil, errors.New("invalid ownership record")
	}
	return &owned, nil
}

func (store fileOwnershipStore) Write(owned ownedProcess) error {
	data, err := json.Marshal(owned)
	if err != nil {
		return err
	}
	temporary := store.path + ".tmp"
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, os.ErrExist) {
		_ = os.Remove(temporary)
		file, err = os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	}
	if err != nil {
		return err
	}
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if closeErr != nil {
		_ = os.Remove(temporary)
		return closeErr
	}
	return os.Rename(temporary, store.path)
}

func (store fileOwnershipStore) Clear() error {
	err := os.Remove(store.path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	profileErr := os.Remove(filepath.Join(filepath.Dir(store.path), "session.yaml"))
	if errors.Is(profileErr, os.ErrNotExist) {
		return nil
	}
	return profileErr
}

func ownershipStoreFor(directory string) fileOwnershipStore {
	return fileOwnershipStore{path: filepath.Join(directory, "ownership.json")}
}
