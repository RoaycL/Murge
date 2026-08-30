package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var sidPattern = regexp.MustCompile(`^S-1-[0-9-]+$`)
var safeNamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,96}$`)

type serviceConfig struct {
	ServiceName         string `json:"serviceName"`
	PipeName            string `json:"pipeName"`
	AllowedSID          string `json:"allowedSid"`
	ArchivePath         string `json:"archivePath"`
	ArchiveSHA256       string `json:"archiveSha256"`
	ArchiveInnerName    string `json:"archiveInnerName"`
	StateDirectory      string `json:"stateDirectory"`
	AllowedClientPath   string `json:"allowedClientPath"`
	AllowedClientSHA256 string `json:"allowedClientSha256"`
}

func loadServiceConfig(path string) (serviceConfig, error) {
	file, err := os.Open(path)
	if err != nil {
		return serviceConfig{}, err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	var config serviceConfig
	if err := decoder.Decode(&config); err != nil {
		return serviceConfig{}, err
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return serviceConfig{}, err
	}
	if !safeNamePattern.MatchString(config.ServiceName) || !safeNamePattern.MatchString(config.PipeName) {
		return serviceConfig{}, errors.New("unsafe service or pipe name")
	}
	if !sidPattern.MatchString(config.AllowedSID) {
		return serviceConfig{}, errors.New("invalid allowedSid")
	}
	if !filepath.IsAbs(config.ArchivePath) || !filepath.IsAbs(config.StateDirectory) || !filepath.IsAbs(config.AllowedClientPath) {
		return serviceConfig{}, errors.New("service paths must be absolute")
	}
	if !sha256Pattern.MatchString(config.ArchiveSHA256) || !sha256Pattern.MatchString(config.AllowedClientSHA256) {
		return serviceConfig{}, errors.New("invalid pinned digest")
	}
	if filepath.Base(config.ArchiveInnerName) != config.ArchiveInnerName || !strings.HasSuffix(strings.ToLower(config.ArchiveInnerName), ".exe") {
		return serviceConfig{}, errors.New("unsafe archiveInnerName")
	}
	return config, nil
}
