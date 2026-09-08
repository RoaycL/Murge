//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"

	"golang.org/x/sys/windows"
)

// fileIdentity uses the stable NTFS identity in addition to mutable size/time
// metadata. Replacing an executable and restoring its timestamp cannot reuse a
// cached digest because the volume/file index pair changes.
type fileIdentity struct {
	volumeSerial uint32
	fileIndex    uint64
	size         uint64
	lastWrite    int64
}

func identityForOpenFile(file *os.File) (fileIdentity, error) {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &info); err != nil {
		return fileIdentity{}, err
	}
	return fileIdentity{
		volumeSerial: info.VolumeSerialNumber,
		fileIndex:    uint64(info.FileIndexHigh)<<32 | uint64(info.FileIndexLow),
		size:         uint64(info.FileSizeHigh)<<32 | uint64(info.FileSizeLow),
		lastWrite:    info.LastWriteTime.Nanoseconds(),
	}, nil
}

func openFileIdentity(path string) (*os.File, fileIdentity, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fileIdentity{}, err
	}
	identity, err := identityForOpenFile(file)
	if err != nil {
		file.Close()
		return nil, fileIdentity{}, err
	}
	return file, identity, nil
}

func fileIdentityForPath(path string) (fileIdentity, error) {
	file, identity, err := openFileIdentity(path)
	if file != nil {
		_ = file.Close()
	}
	return identity, err
}

func hashOpenFile(file *os.File, expected fileIdentity) (string, error) {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	after, err := identityForOpenFile(file)
	if err != nil {
		return "", err
	}
	if after != expected {
		return "", errors.New("file identity changed while hashing")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func hashFileWithIdentity(path string) (string, fileIdentity, error) {
	file, identity, err := openFileIdentity(path)
	if err != nil {
		return "", fileIdentity{}, err
	}
	defer file.Close()
	digest, err := hashOpenFile(file, identity)
	return digest, identity, err
}
