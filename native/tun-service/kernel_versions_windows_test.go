//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testCoreMarker(version, archiveDigit, binaryDigit string) cachedCoreMarker {
	return cachedCoreMarker{
		Version: version, ArchiveSHA: strings.Repeat(archiveDigit, 64),
		BinarySHA: strings.Repeat(binaryDigit, 64), AssetName: version + ".zip", ArchiveBytes: 1024,
	}
}

func TestTrustedPreviewAndSmartReleaseSpecs(t *testing.T) {
	preview, err := releaseSpec("preview")
	if err != nil {
		t.Fatal(err)
	}
	if preview.OwnerRepo != "MetaCubeX/mihomo" || preview.Tag != "Prerelease-Alpha" ||
		!strings.Contains(preview.AssetPrefix, "mihomo-windows-") || !strings.HasSuffix(preview.InnerName, ".exe") {
		t.Fatalf("unexpected preview spec: %+v", preview)
	}

	smart, err := releaseSpec("smart")
	if err != nil {
		t.Fatal(err)
	}
	if smart.OwnerRepo != "vernesong/mihomo" || smart.Tag != "Prerelease-Alpha" ||
		!strings.Contains(smart.AssetPrefix, "mihomo-windows-") || !strings.HasSuffix(smart.InnerName, ".exe") {
		t.Fatalf("unexpected smart spec: %+v", smart)
	}
}

func TestSpecificReleaseSpecRemainsExact(t *testing.T) {
	spec, err := releaseSpec("v1.19.30")
	if err != nil {
		t.Fatal(err)
	}
	if spec.OwnerRepo != "MetaCubeX/mihomo" || spec.Tag != "v1.19.30" || spec.AssetExact == "" || spec.AssetPrefix != "" {
		t.Fatalf("unexpected specific spec: %+v", spec)
	}
}

func TestRollingVersionTrustKeepsCurrentAndPreviousDigests(t *testing.T) {
	runtime := &windowsRuntime{config: serviceConfig{
		TrustDirectory: t.TempDir(), StateDirectory: t.TempDir(),
	}}
	first := testCoreMarker("preview", "1", "a")
	second := testCoreMarker("preview", "2", "b")
	third := testCoreMarker("preview", "3", "c")
	for _, marker := range []cachedCoreMarker{first, second, third} {
		if err := runtime.storeVersionTrust(marker); err != nil {
			t.Fatalf("store rolling trust %s: %v", marker.ArchiveSHA[:4], err)
		}
	}
	catalog, err := runtime.loadVersionTrust()
	if err != nil {
		t.Fatal(err)
	}
	ref := catalog.Channels["preview"]
	if ref.Current != trustKeyForMarker(third) || ref.Previous != trustKeyForMarker(second) {
		t.Fatalf("unexpected rolling refs: %+v", ref)
	}
	if _, exists := catalog.Versions[trustKeyForMarker(first)]; exists {
		t.Fatal("oldest rolling trust entry was not pruned")
	}
	if len(catalog.Versions) != 2 {
		t.Fatalf("expected two retained rolling generations, got %d", len(catalog.Versions))
	}
}

func TestSpecificVersionTrustStillRejectsDigestMutation(t *testing.T) {
	runtime := &windowsRuntime{config: serviceConfig{
		TrustDirectory: t.TempDir(), StateDirectory: t.TempDir(),
	}}
	first := testCoreMarker("v1.19.30", "1", "a")
	if err := runtime.storeVersionTrust(first); err != nil {
		t.Fatal(err)
	}
	changed := first
	changed.ArchiveSHA = strings.Repeat("2", 64)
	if err := runtime.storeVersionTrust(changed); err == nil {
		t.Fatal("specific version digest mutation was accepted")
	}
}

func TestLegacyRollingTrustMigratesAsPreviousGeneration(t *testing.T) {
	trustDirectory := t.TempDir()
	runtime := &windowsRuntime{config: serviceConfig{
		TrustDirectory: trustDirectory, StateDirectory: t.TempDir(),
	}}
	legacy := testCoreMarker("smart", "1", "a")
	encoded, err := json.Marshal(versionTrustCatalog{
		Versions: map[string]cachedCoreMarker{"smart": legacy},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(trustDirectory, versionTrustFilename), encoded, 0600); err != nil {
		t.Fatal(err)
	}
	next := testCoreMarker("smart", "2", "b")
	if err := runtime.storeVersionTrust(next); err != nil {
		t.Fatal(err)
	}
	catalog, err := runtime.loadVersionTrust()
	if err != nil {
		t.Fatal(err)
	}
	ref := catalog.Channels["smart"]
	if ref.Current != trustKeyForMarker(next) || ref.Previous != "smart" {
		t.Fatalf("legacy generation was not retained for rollback: %+v", ref)
	}
}

func TestRollingCacheFallsBackToPreviousVerifiedGeneration(t *testing.T) {
	runtime := &windowsRuntime{config: serviceConfig{
		TrustDirectory: t.TempDir(), StateDirectory: t.TempDir(),
	}}
	first := testCoreMarker("preview", "1", "a")
	second := testCoreMarker("preview", "2", "b")
	core := []byte("previous verified core")
	coreDigest := sha256.Sum256(core)
	first.BinarySHA = hex.EncodeToString(coreDigest[:])
	if err := runtime.storeVersionTrust(first); err != nil {
		t.Fatal(err)
	}
	if err := runtime.storeVersionTrust(second); err != nil {
		t.Fatal(err)
	}
	directory := runtime.versionDirectory("preview", trustKeyForMarker(first))
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	marker, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "verified.json"), marker, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "core.exe"), core, 0700); err != nil {
		t.Fatal(err)
	}
	catalog, err := runtime.loadVersionTrust()
	if err != nil {
		t.Fatal(err)
	}
	path, digest, ok := runtime.currentCachedCore("preview", catalog)
	if !ok || path != filepath.Join(directory, "core.exe") || digest != first.BinarySHA {
		t.Fatalf("previous rolling generation was not used: path=%q digest=%q ok=%v", path, digest, ok)
	}
}
