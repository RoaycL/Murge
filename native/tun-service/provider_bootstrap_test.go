package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSeedMissingProviderCachesPrimesColdHttpProvidersAndPreservesRealCache(t *testing.T) {
	root := t.TempDir()
	existing := filepath.Join(root, "rules", "existing.yaml")
	if err := os.MkdirAll(filepath.Dir(existing), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(existing, []byte("payload:\n  - DOMAIN,example.com\n"), 0600); err != nil {
		t.Fatal(err)
	}
	profile := `proxy-providers:
  Nodes:
    type: http
    path: ./providers/nodes.yaml
    url: https://example.invalid/nodes
rule-providers:
  MissingYaml:
    type: http
    behavior: classical
    path: ./rules/missing.yaml
    url: https://example.invalid/rules
  MissingText:
    type: http
    behavior: domain
    format: text
    path: ./rules/missing.txt
    url: https://example.invalid/domains
  Existing:
    type: http
    behavior: classical
    path: ./rules/existing.yaml
    url: https://example.invalid/existing
  Binary:
    type: http
    behavior: domain
    format: mrs
    path: ./rules/binary.mrs
    url: https://example.invalid/binary
`
	seeded, err := seedMissingProviderCaches(profile, root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(seeded) != 3 {
		t.Fatalf("expected 3 placeholders, got %v", seeded)
	}
	nodes, _ := os.ReadFile(filepath.Join(root, "providers", "nodes.yaml"))
	if !strings.Contains(string(nodes), "Murge Bootstrap") || !strings.Contains(string(nodes), "127.0.0.1") {
		t.Fatalf("proxy placeholder is not a valid deterministic provider: %s", nodes)
	}
	yamlRules, _ := os.ReadFile(filepath.Join(root, "rules", "missing.yaml"))
	if string(yamlRules) != "payload: []\n" {
		t.Fatalf("unexpected YAML rule placeholder: %q", yamlRules)
	}
	textRules, _ := os.ReadFile(filepath.Join(root, "rules", "missing.txt"))
	if !strings.HasPrefix(string(textRules), "# Murge cold-start") {
		t.Fatalf("unexpected text rule placeholder: %q", textRules)
	}
	preserved, _ := os.ReadFile(existing)
	if !strings.Contains(string(preserved), "example.com") {
		t.Fatalf("existing provider cache was overwritten: %q", preserved)
	}
	if _, err := os.Stat(filepath.Join(root, "rules", "binary.mrs")); !os.IsNotExist(err) {
		t.Fatalf("binary MRS placeholder must not be fabricated: %v", err)
	}
}

func TestSeedMissingProviderCachesRejectsEscapingPath(t *testing.T) {
	_, err := seedMissingProviderCaches(`proxy-providers:
  Bad:
    type: http
    path: ../outside.yaml
`, t.TempDir(), nil)
	if err == nil || !strings.Contains(err.Error(), "must not traverse") {
		t.Fatalf("expected traversal rejection, got %v", err)
	}
}
