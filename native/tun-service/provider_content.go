package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

var (
	errProviderNotFound        = errors.New("provider not found")
	errProviderCacheMissing    = errors.New("provider cache missing")
	errProviderPathUnavailable = errors.New("provider path unavailable")
	errProviderContentTooLarge = errors.New("provider content too large")
	errProviderContentInvalid  = errors.New("provider content invalid")
	errProviderMRSConvert      = errors.New("provider MRS conversion failed")
)

type providerContent struct {
	Text     string
	Format   string
	Source   string
	Path     string
	Behavior string
}

func providerErrorCode(err error) string {
	switch {
	case errors.Is(err, errProviderNotFound):
		return "PROVIDER_NOT_FOUND"
	case errors.Is(err, errProviderCacheMissing):
		return "PROVIDER_CACHE_MISSING"
	case errors.Is(err, errProviderPathUnavailable):
		return "PROVIDER_PATH_UNAVAILABLE"
	case errors.Is(err, errProviderContentTooLarge):
		return "PROVIDER_CONTENT_TOO_LARGE"
	case errors.Is(err, errProviderContentInvalid):
		return "PROVIDER_CONTENT_INVALID"
	case errors.Is(err, errProviderMRSConvert):
		return "PROVIDER_MRS_CONVERT_FAILED"
	default:
		return "TUN_SERVICE_OPERATION_FAILED"
	}
}

// resolveProviderContent binds the requested name to session.yaml before it
// touches disk. This is deliberately not an arbitrary service-side file reader.
func resolveProviderContent(stateDirectory, kind, name string) (providerContent, error) {
	profile, err := os.ReadFile(filepath.Join(stateDirectory, "session.yaml"))
	if err != nil {
		return providerContent{}, errProviderCacheMissing
	}
	var document map[string]any
	if err := yaml.Unmarshal(profile, &document); err != nil {
		return providerContent{}, errProviderContentInvalid
	}
	section := "proxy-providers"
	if kind == "rule" {
		section = "rule-providers"
	}
	entries, ok := document[section].(map[string]any)
	if !ok {
		return providerContent{}, errProviderNotFound
	}
	entry, ok := entries[name].(map[string]any)
	if !ok {
		return providerContent{}, errProviderNotFound
	}
	vehicle, _ := entry["type"].(string)
	if strings.EqualFold(vehicle, "inline") {
		payload, present := entry["payload"]
		if !present {
			return providerContent{}, errProviderContentInvalid
		}
		key := "proxies"
		if kind == "rule" {
			key = "payload"
		}
		encoded, err := yaml.Marshal(map[string]any{key: payload})
		if err != nil || len(encoded) > maxProviderContentBytes {
			return providerContent{}, errProviderContentTooLarge
		}
		return providerContent{Text: string(encoded), Format: "yaml", Source: "inline"}, nil
	}

	path, ok := entry["path"].(string)
	if !ok || ensureContainedPath(path) != nil {
		return providerContent{}, errProviderPathUnavailable
	}
	target := filepath.Join(stateDirectory, filepath.Clean(path))
	relative, err := filepath.Rel(stateDirectory, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return providerContent{}, errProviderPathUnavailable
	}
	info, err := os.Lstat(target)
	if errors.Is(err, os.ErrNotExist) {
		return providerContent{}, errProviderCacheMissing
	}
	if err != nil || info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return providerContent{}, errProviderContentInvalid
	}
	if info.Size() > maxProviderContentBytes {
		return providerContent{}, errProviderContentTooLarge
	}
	format, _ := entry["format"].(string)
	if strings.EqualFold(format, "mrs") || strings.EqualFold(filepath.Ext(target), ".mrs") {
		behavior, _ := entry["behavior"].(string)
		return providerContent{Format: "mrs", Source: "cache", Path: target, Behavior: behavior}, nil
	}
	data, err := os.ReadFile(target)
	if err != nil || !utf8.Valid(data) {
		return providerContent{}, errProviderContentInvalid
	}
	displayFormat := "yaml"
	if strings.EqualFold(format, "text") || strings.EqualFold(filepath.Ext(target), ".txt") {
		displayFormat = "text"
	}
	return providerContent{Text: string(data), Format: displayFormat, Source: "cache"}, nil
}
