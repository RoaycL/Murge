//go:build windows

package main

import (
	"strings"
	"testing"
)

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
