package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeProviderSession(t *testing.T, root, document string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, "session.yaml"), []byte(document), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestResolveProviderContentReadsOnlyDeclaredCache(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "proxy-providers"), 0700); err != nil {
		t.Fatal(err)
	}
	cache := "proxies:\n  - name: HK\n    type: direct\n"
	if err := os.WriteFile(filepath.Join(root, "proxy-providers", "airport.yaml"), []byte(cache), 0600); err != nil {
		t.Fatal(err)
	}
	writeProviderSession(t, root, "proxy-providers:\n  Airport:\n    type: http\n    path: ./proxy-providers/airport.yaml\n")

	content, err := resolveProviderContent(root, "proxy", "Airport")
	if err != nil {
		t.Fatal(err)
	}
	if content.Text != cache || content.Source != "cache" || content.Format != "yaml" {
		t.Fatalf("unexpected content: %+v", content)
	}
	if _, err := resolveProviderContent(root, "proxy", "Not declared"); !errors.Is(err, errProviderNotFound) {
		t.Fatalf("undeclared provider was not rejected: %v", err)
	}
}

func TestResolveProviderContentRendersInlineAndIdentifiesMrs(t *testing.T) {
	root := t.TempDir()
	writeProviderSession(t, root, "rule-providers:\n  InlineRules:\n    type: inline\n    behavior: domain\n    payload: [example.com]\n  BinaryRules:\n    type: http\n    behavior: domain\n    format: mrs\n    path: rules/example.mrs\n")
	inline, err := resolveProviderContent(root, "rule", "InlineRules")
	if err != nil || inline.Source != "inline" || !strings.Contains(inline.Text, "example.com") {
		t.Fatalf("inline provider was not rendered: content=%+v err=%v", inline, err)
	}
	if err := os.MkdirAll(filepath.Join(root, "rules"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "rules", "example.mrs"), []byte("mrs"), 0600); err != nil {
		t.Fatal(err)
	}
	mrs, err := resolveProviderContent(root, "rule", "BinaryRules")
	if err != nil || mrs.Format != "mrs" || mrs.Behavior != "domain" || mrs.Path == "" {
		t.Fatalf("MRS provider metadata was not resolved: content=%+v err=%v", mrs, err)
	}
}

func TestResolveProviderContentRejectsEscapesAndOversizeFiles(t *testing.T) {
	root := t.TempDir()
	writeProviderSession(t, root, "rule-providers:\n  Escape:\n    type: file\n    path: ../outside.yaml\n  Huge:\n    type: file\n    path: huge.yaml\n")
	if _, err := resolveProviderContent(root, "rule", "Escape"); !errors.Is(err, errProviderPathUnavailable) {
		t.Fatalf("path escape was not rejected: %v", err)
	}
	file, err := os.Create(filepath.Join(root, "huge.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(maxProviderContentBytes + 1); err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	if _, err := resolveProviderContent(root, "rule", "Huge"); !errors.Is(err, errProviderContentTooLarge) {
		t.Fatalf("oversize provider was not rejected: %v", err)
	}
}
