package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

// seedMissingProviderCaches makes a cold service home bootable without first
// reaching every remote provider. Mihomo treats an existing cache as the last
// known good value, so it can bind the controller/TUN listeners first and then
// refresh the deliberately stale placeholder through the restored data plane.
// Real caches are never replaced.
type mrsCacheSeeder func(target, behavior string) error

func seedMissingProviderCaches(profile, stateDirectory string, seedMRS mrsCacheSeeder) ([]string, error) {
	var document map[string]any
	if err := yaml.Unmarshal([]byte(profile), &document); err != nil {
		return nil, err
	}
	if err := validateProviderPaths(document); err != nil {
		return nil, err
	}
	seeded := make([]string, 0)
	for _, section := range providerSections {
		entries, ok := document[section].(map[string]any)
		if !ok {
			continue
		}
		for name, raw := range entries {
			entry, ok := raw.(map[string]any)
			if !ok || !strings.EqualFold(stringValue(entry, "type"), "http") {
				continue
			}
			path := stringValue(entry, "path")
			if path == "" {
				continue
			}
			target := filepath.Join(stateDirectory, filepath.Clean(path))
			if info, err := os.Lstat(target); err == nil {
				if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
					return nil, fmt.Errorf("provider cache target is not a regular file: %s", path)
				}
				continue
			} else if !errors.Is(err, os.ErrNotExist) {
				return nil, err
			}
			format := strings.ToLower(stringValue(entry, "format"))
			if format == "mrs" || strings.EqualFold(filepath.Ext(target), ".mrs") {
				if seedMRS == nil {
					// Unit callers without a pinned core cannot safely fabricate MRS.
					continue
				}
				if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
					return nil, err
				}
				if err := seedMRS(target, strings.ToLower(stringValue(entry, "behavior"))); err != nil {
					return nil, err
				}
				seeded = append(seeded, path)
				continue
			}
			if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
				return nil, err
			}
			var content []byte
			if section == "proxy-providers" {
				digest := sha256.Sum256([]byte(name))
				placeholder := map[string]any{"proxies": []any{map[string]any{
					"name": "Murge Bootstrap " + hex.EncodeToString(digest[:6]),
					"type": "socks5", "server": "127.0.0.1", "port": 1,
				}}}
				content, _ = yaml.Marshal(placeholder)
			} else if format == "text" || strings.EqualFold(filepath.Ext(target), ".txt") {
				content = []byte("# Murge cold-start bootstrap; replaced by provider refresh\n")
			} else {
				content = []byte("payload: []\n")
			}
			if err := writePrivateFile(target, content); err != nil {
				return nil, err
			}
			// Mark it stale so mihomo refreshes it as soon as the restored network
			// is usable instead of waiting for the configured interval.
			stale := time.Unix(1, 0)
			_ = os.Chtimes(target, stale, stale)
			seeded = append(seeded, path)
		}
	}
	return seeded, nil
}

func stringValue(entry map[string]any, key string) string {
	value, _ := entry[key].(string)
	return strings.TrimSpace(value)
}

var (
	errProviderNotFound          = errors.New("provider not found")
	errProviderCacheMissing      = errors.New("provider cache missing")
	errProviderPathUnavailable   = errors.New("provider path unavailable")
	errProviderContentTooLarge   = errors.New("provider content too large")
	errProviderContentInvalid    = errors.New("provider content invalid")
	errProviderContentRead       = errors.New("provider content read failed")
	errProviderMRSConvert        = errors.New("provider MRS conversion failed")
	errProviderMRSConvertTimeout = errors.New("provider MRS conversion timed out")
	errConfigInvalid             = errors.New("mihomo config validation failed")
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
	case errors.Is(err, errProviderContentRead):
		return "PROVIDER_CONTENT_READ_FAILED"
	case errors.Is(err, errProviderMRSConvertTimeout):
		return "PROVIDER_MRS_CONVERT_TIMEOUT"
	case errors.Is(err, errProviderMRSConvert):
		return "PROVIDER_MRS_CONVERT_FAILED"
	case errors.Is(err, errConfigInvalid):
		return "CONFIG_INVALID"
	default:
		return "TUN_SERVICE_OPERATION_FAILED"
	}
}

// resolveProviderContent binds the requested name to session.yaml before it
// touches disk. This is deliberately not an arbitrary service-side file reader.
func resolveProviderContent(stateDirectory, kind, name string) (providerContent, error) {
	profile, err := os.ReadFile(filepath.Join(stateDirectory, "session.yaml"))
	if errors.Is(err, os.ErrNotExist) {
		return providerContent{}, errProviderCacheMissing
	}
	if err != nil {
		return providerContent{}, fmt.Errorf("%w: session profile: %v", errProviderContentRead, err)
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
	if err != nil {
		return providerContent{}, fmt.Errorf("%w: provider cache metadata: %v", errProviderContentRead, err)
	}
	if info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
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
	if err != nil {
		return providerContent{}, fmt.Errorf("%w: provider cache: %v", errProviderContentRead, err)
	}
	if !utf8.Valid(data) {
		return providerContent{}, errProviderContentInvalid
	}
	displayFormat := "yaml"
	if strings.EqualFold(format, "text") || strings.EqualFold(filepath.Ext(target), ".txt") {
		displayFormat = "text"
	}
	return providerContent{Text: string(data), Format: displayFormat, Source: "cache"}, nil
}
