//go:build windows

package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const githubAPIBase = "https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/"

type coreReleaseSpec struct {
	APIBase     string
	OwnerRepo   string
	Tag         string
	AssetPrefix string
	AssetExact  string
	InnerName   string
}

type githubReleaseAsset struct {
	Name               string `json:"name"`
	Digest             string `json:"digest"`
	Size               int64  `json:"size"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

type githubRelease struct {
	TagName string               `json:"tag_name"`
	Assets  []githubReleaseAsset `json:"assets"`
}

type cachedCoreMarker struct {
	Version      string `json:"version"`
	ArchiveSHA   string `json:"archiveSha256"`
	BinarySHA    string `json:"binarySha256"`
	AssetName    string `json:"assetName"`
	ArchiveBytes int64  `json:"archiveBytes"`
}

type versionTrustCatalog struct {
	Versions map[string]cachedCoreMarker  `json:"versions"`
	Channels map[string]rollingChannelRef `json:"channels,omitempty"`
}

type rollingChannelRef struct {
	Current  string `json:"current"`
	Previous string `json:"previous,omitempty"`
}

const versionTrustFilename = "version-trust.json"

func validTrustedMarker(version string, marker cachedCoreMarker) bool {
	return marker.Version == version &&
		sha256Pattern.MatchString(marker.ArchiveSHA) &&
		sha256Pattern.MatchString(marker.BinarySHA) &&
		filepath.Base(marker.AssetName) == marker.AssetName &&
		marker.ArchiveBytes > 0 && marker.ArchiveBytes <= maxCoreBytes
}

func isRollingVersion(version string) bool {
	return version == "preview" || version == "smart"
}

func trustKeyForMarker(marker cachedCoreMarker) string {
	if isRollingVersion(marker.Version) {
		return marker.Version + "@" + marker.ArchiveSHA
	}
	return marker.Version
}

func validTrustEntry(key string, marker cachedCoreMarker) bool {
	if !validTrustedMarker(marker.Version, marker) {
		return false
	}
	// Accept the fixed-key preview/smart layout written by v0.9.4 so an existing
	// verified cache remains usable until the first digest-keyed refresh.
	return key == trustKeyForMarker(marker) || (isRollingVersion(marker.Version) && key == marker.Version)
}

func (runtime *windowsRuntime) loadVersionTrust() (versionTrustCatalog, error) {
	path := filepath.Join(runtime.config.TrustDirectory, versionTrustFilename)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return versionTrustCatalog{
			Versions: make(map[string]cachedCoreMarker),
			Channels: make(map[string]rollingChannelRef),
		}, nil
	}
	if err != nil {
		return versionTrustCatalog{}, err
	}
	if len(data) == 0 || len(data) > 1024*1024 {
		return versionTrustCatalog{}, errors.New("version trust catalog size is invalid")
	}
	var catalog versionTrustCatalog
	if err := json.Unmarshal(data, &catalog); err != nil || catalog.Versions == nil {
		return versionTrustCatalog{}, errors.New("version trust catalog is invalid")
	}
	if catalog.Channels == nil {
		catalog.Channels = make(map[string]rollingChannelRef)
	}
	for key, marker := range catalog.Versions {
		if !validTrustEntry(key, marker) {
			return versionTrustCatalog{}, errors.New("version trust catalog contains an invalid entry")
		}
	}
	for channel, ref := range catalog.Channels {
		if !isRollingVersion(channel) || ref.Current == "" {
			return versionTrustCatalog{}, errors.New("version trust catalog contains an invalid channel")
		}
		for _, key := range []string{ref.Current, ref.Previous} {
			if key == "" {
				continue
			}
			marker, exists := catalog.Versions[key]
			if !exists || marker.Version != channel || !validTrustEntry(key, marker) {
				return versionTrustCatalog{}, errors.New("version trust catalog channel target is invalid")
			}
		}
	}
	return catalog, nil
}

func (runtime *windowsRuntime) storeVersionTrust(marker cachedCoreMarker) error {
	if !validTrustedMarker(marker.Version, marker) {
		return errors.New("refusing invalid version trust entry")
	}
	catalog, err := runtime.loadVersionTrust()
	if err != nil {
		return err
	}
	key := trustKeyForMarker(marker)
	if pinned, exists := catalog.Versions[key]; exists {
		if pinned != marker {
			return errors.New("official asset no longer matches the pinned version trust entry")
		}
	} else {
		catalog.Versions[key] = marker
	}
	if isRollingVersion(marker.Version) {
		ref := catalog.Channels[marker.Version]
		if ref.Current == "" {
			// Preserve the legacy fixed-key generation as the first rollback target.
			if _, exists := catalog.Versions[marker.Version]; exists {
				ref.Current = marker.Version
			}
		}
		if ref.Current != key {
			ref.Previous = ref.Current
			ref.Current = key
		}
		catalog.Channels[marker.Version] = ref
		// Keep the active and immediately previous immutable generations. Entries
		// older than that no longer have a live rollback purpose.
		for candidate, trusted := range catalog.Versions {
			if trusted.Version == marker.Version && candidate != ref.Current && candidate != ref.Previous {
				delete(catalog.Versions, candidate)
			}
		}
	}
	encoded, err := json.Marshal(catalog)
	if err != nil {
		return err
	}
	if err := writePrivateFile(filepath.Join(runtime.config.TrustDirectory, versionTrustFilename), encoded); err != nil {
		return err
	}
	if isRollingVersion(marker.Version) {
		runtime.pruneRollingDirectories(marker.Version, catalog.Channels[marker.Version])
	}
	return nil
}

func rollingDigest(channel, key string) (string, bool) {
	prefix := channel + "@"
	if !strings.HasPrefix(key, prefix) {
		return "", false
	}
	digest := strings.TrimPrefix(key, prefix)
	return digest, sha256Pattern.MatchString(digest)
}

func (runtime *windowsRuntime) versionDirectory(version, trustKey string) string {
	root := filepath.Join(runtime.config.StateDirectory, "versions", version)
	if digest, ok := rollingDigest(version, trustKey); ok {
		return filepath.Join(root, digest)
	}
	return root
}

func (runtime *windowsRuntime) cachedTrustedCore(version, trustKey string, catalog versionTrustCatalog) (string, string, bool) {
	trusted, exists := catalog.Versions[trustKey]
	if !exists || trusted.Version != version || !validTrustEntry(trustKey, trusted) {
		return "", "", false
	}
	directory := runtime.versionDirectory(version, trustKey)
	data, err := os.ReadFile(filepath.Join(directory, "verified.json"))
	if err != nil {
		return "", "", false
	}
	var marker cachedCoreMarker
	if json.Unmarshal(data, &marker) != nil || marker != trusted {
		return "", "", false
	}
	corePath := filepath.Join(directory, "core.exe")
	digest, err := hashFile(corePath)
	if err != nil || digest != marker.BinarySHA {
		return "", "", false
	}
	return corePath, digest, true
}

func (runtime *windowsRuntime) currentCachedCore(version string, catalog versionTrustCatalog) (string, string, bool) {
	if isRollingVersion(version) {
		if ref, exists := catalog.Channels[version]; exists {
			for _, key := range []string{ref.Current, ref.Previous} {
				if key == "" {
					continue
				}
				if path, digest, ok := runtime.cachedTrustedCore(version, key, catalog); ok {
					return path, digest, true
				}
			}
			return "", "", false
		}
	}
	return runtime.cachedTrustedCore(version, version, catalog)
}

func (runtime *windowsRuntime) pruneRollingDirectories(channel string, ref rollingChannelRef) {
	keep := make(map[string]bool)
	for _, key := range []string{ref.Current, ref.Previous} {
		if digest, ok := rollingDigest(channel, key); ok {
			keep[digest] = true
		}
	}
	root := filepath.Join(runtime.config.StateDirectory, "versions", channel)
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() && sha256Pattern.MatchString(entry.Name()) && !keep[entry.Name()] {
			_ = os.RemoveAll(filepath.Join(root, entry.Name()))
		}
	}
}

func mihomoWindowsArch() (string, error) {
	switch runtime.GOARCH {
	case "amd64":
		return "amd64", nil
	case "arm64":
		return "arm64", nil
	case "386":
		return "386", nil
	default:
		return "", fmt.Errorf("unsupported Windows architecture: %s", runtime.GOARCH)
	}
}

func releaseSpec(version string) (coreReleaseSpec, error) {
	arch, err := mihomoWindowsArch()
	if err != nil {
		return coreReleaseSpec{}, err
	}
	standardArch := arch
	if arch == "amd64" {
		standardArch = "amd64-compatible"
	}
	if version == "preview" {
		prefix := fmt.Sprintf("mihomo-windows-%s", standardArch)
		return coreReleaseSpec{
			APIBase: githubAPIBase, OwnerRepo: "MetaCubeX/mihomo", Tag: "Prerelease-Alpha",
			AssetPrefix: prefix + "-", InnerName: prefix + ".exe",
		}, nil
	}
	if version == "smart" {
		smartArch := arch
		if arch == "amd64" {
			smartArch = "amd64-v2-go120"
		}
		if arch == "386" {
			smartArch = "386-go120"
		}
		prefix := fmt.Sprintf("mihomo-windows-%s", smartArch)
		return coreReleaseSpec{
			APIBase:   "https://api.github.com/repos/vernesong/mihomo/releases/tags/",
			OwnerRepo: "vernesong/mihomo", Tag: "Prerelease-Alpha",
			AssetPrefix: prefix + "-", InnerName: prefix + ".exe",
		}, nil
	}
	name := fmt.Sprintf("mihomo-windows-%s-%s.zip", arch, version)
	return coreReleaseSpec{
		APIBase: githubAPIBase, OwnerRepo: "MetaCubeX/mihomo", Tag: version,
		AssetExact: name, InnerName: fmt.Sprintf("mihomo-windows-%s.exe", arch),
	}, nil
}

func officialHTTPClient(timeout time.Duration, proxyPort int) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if proxyPort > 0 {
		proxyURL, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", proxyPort))
		transport.Proxy = http.ProxyURL(proxyURL)
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 8 {
				return errors.New("too many redirects")
			}
			if request.URL.Scheme != "https" || !officialDownloadHost(request.URL.Hostname()) {
				return errors.New("mihomo download redirected outside GitHub")
			}
			return nil
		},
	}
}

func officialDownloadHost(host string) bool {
	return host == "github.com" || strings.HasSuffix(host, ".githubusercontent.com")
}

func fetchOfficialAsset(version string, proxyPort int) (githubReleaseAsset, error) {
	asset, err := fetchOfficialAssetWithClient(version, officialHTTPClient(30*time.Second, proxyPort))
	if err != nil && proxyPort > 0 {
		return fetchOfficialAssetWithClient(version, officialHTTPClient(30*time.Second, 0))
	}
	return asset, err
}

func fetchOfficialAssetWithClient(version string, client *http.Client) (githubReleaseAsset, error) {
	spec, err := releaseSpec(version)
	if err != nil {
		return githubReleaseAsset{}, err
	}
	request, err := http.NewRequest(http.MethodGet, spec.APIBase+url.PathEscape(spec.Tag), nil)
	if err != nil {
		return githubReleaseAsset{}, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "murge-tun-service")
	response, err := client.Do(request)
	if err != nil {
		return githubReleaseAsset{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return githubReleaseAsset{}, fmt.Errorf("GitHub release metadata returned HTTP %d", response.StatusCode)
	}
	var release githubRelease
	decoder := json.NewDecoder(io.LimitReader(response.Body, 2*1024*1024))
	if err := decoder.Decode(&release); err != nil {
		return githubReleaseAsset{}, err
	}
	if release.TagName != spec.Tag {
		return githubReleaseAsset{}, errors.New("GitHub release tag mismatch")
	}
	for _, asset := range release.Assets {
		matches := asset.Name == spec.AssetExact
		if spec.AssetPrefix != "" {
			matches = strings.HasPrefix(asset.Name, spec.AssetPrefix) && strings.HasSuffix(asset.Name, ".zip")
		}
		if !matches {
			continue
		}
		digest := strings.TrimPrefix(asset.Digest, "sha256:")
		parsed, parseErr := url.Parse(asset.BrowserDownloadURL)
		if parseErr != nil || parsed.Scheme != "https" || parsed.Hostname() != "github.com" ||
			!strings.HasPrefix(parsed.Path, "/"+spec.OwnerRepo+"/releases/download/"+spec.Tag+"/") {
			return githubReleaseAsset{}, errors.New("unsafe mihomo release URL")
		}
		if !sha256Pattern.MatchString(digest) || asset.Size <= 0 || asset.Size > maxCoreBytes {
			return githubReleaseAsset{}, errors.New("mihomo release lacks a valid digest or size")
		}
		asset.Digest = digest
		return asset, nil
	}
	return githubReleaseAsset{}, fmt.Errorf("official mihomo asset for %s was not found", version)
}

func downloadOfficialAsset(asset githubReleaseAsset, destination string, proxyPort int) error {
	err := downloadOfficialAssetWithClient(asset, destination, officialHTTPClient(2*time.Minute, proxyPort))
	if err != nil && proxyPort > 0 {
		return downloadOfficialAssetWithClient(asset, destination, officialHTTPClient(2*time.Minute, 0))
	}
	return err
}

func downloadOfficialAssetWithClient(asset githubReleaseAsset, destination string, client *http.Client) error {
	response, err := client.Get(asset.BrowserDownloadURL)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("mihomo download returned HTTP %d", response.StatusCode)
	}
	temporary := destination + ".tmp"
	_ = os.Remove(temporary)
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, maxCoreBytes+1))
	if copyErr == nil {
		copyErr = file.Sync()
	}
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil || written != asset.Size || written > maxCoreBytes || hex.EncodeToString(hash.Sum(nil)) != asset.Digest {
		_ = os.Remove(temporary)
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		return errors.New("downloaded mihomo archive failed digest or size verification")
	}
	_ = os.Remove(destination)
	return os.Rename(temporary, destination)
}

func extractVersionCore(archivePath, innerName, destination string) (string, error) {
	archive, err := zip.OpenReader(archivePath)
	if err != nil {
		return "", err
	}
	defer archive.Close()
	var entry *zip.File
	for _, candidate := range archive.File {
		if candidate.Name == innerName {
			if entry != nil {
				return "", errors.New("duplicate mihomo archive entry")
			}
			entry = candidate
		}
	}
	if entry == nil || entry.FileInfo().IsDir() || entry.UncompressedSize64 == 0 || entry.UncompressedSize64 > maxCoreBytes {
		return "", errors.New("mihomo archive entry is invalid")
	}
	reader, err := entry.Open()
	if err != nil {
		return "", err
	}
	defer reader.Close()
	temporary := destination + ".tmp"
	_ = os.Remove(temporary)
	output, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(output, hash), io.LimitReader(reader, maxCoreBytes+1))
	if copyErr == nil {
		copyErr = output.Sync()
	}
	closeErr := output.Close()
	if copyErr != nil || closeErr != nil || written <= 0 || written > maxCoreBytes {
		_ = os.Remove(temporary)
		if copyErr != nil {
			return "", copyErr
		}
		if closeErr != nil {
			return "", closeErr
		}
		return "", errors.New("extracted mihomo size is invalid")
	}
	_ = os.Remove(destination)
	if err := os.Rename(temporary, destination); err != nil {
		_ = os.Remove(temporary)
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func (runtime *windowsRuntime) versionCore(version string, proxyPort int, refreshRolling bool) (string, string, error) {
	if !versionPattern.MatchString(version) {
		return "", "", errors.New("invalid mihomo version")
	}
	versionRoot := filepath.Join(runtime.config.StateDirectory, "versions", version)
	if err := os.MkdirAll(versionRoot, 0700); err != nil {
		return "", "", err
	}
	if err := secureStateDirectory(versionRoot); err != nil {
		return "", "", err
	}
	catalog, trustErr := runtime.loadVersionTrust()
	if trustErr != nil {
		return "", "", trustErr
	}
	cachedPath, cachedDigest, cached := runtime.currentCachedCore(version, catalog)
	if cached && (!isRollingVersion(version) || !refreshRolling) {
		return cachedPath, cachedDigest, nil
	}
	asset, err := fetchOfficialAsset(version, proxyPort)
	if err != nil {
		// A failed rolling refresh must not destroy a previously verified core.
		// This also preserves offline startup and offline channel switching.
		if cached {
			return cachedPath, cachedDigest, nil
		}
		return "", "", err
	}
	trustKey := version
	if isRollingVersion(version) {
		trustKey = version + "@" + asset.Digest
		if trusted, exists := catalog.Versions[trustKey]; exists &&
			trusted.AssetName == asset.Name && trusted.ArchiveBytes == asset.Size {
			if path, digest, ok := runtime.cachedTrustedCore(version, trustKey, catalog); ok {
				if err := runtime.storeVersionTrust(trusted); err != nil {
					return "", "", err
				}
				return path, digest, nil
			}
		}
	}
	directory := runtime.versionDirectory(version, trustKey)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", "", err
	}
	if err := secureStateDirectory(directory); err != nil {
		return "", "", err
	}
	markerPath := filepath.Join(directory, "verified.json")
	corePath := filepath.Join(directory, "core.exe")
	archivePath := filepath.Join(directory, asset.Name)
	if digest, hashErr := hashFile(archivePath); hashErr != nil || digest != asset.Digest {
		if err := downloadOfficialAsset(asset, archivePath, proxyPort); err != nil {
			return "", "", err
		}
	}
	spec, err := releaseSpec(version)
	if err != nil {
		return "", "", err
	}
	binaryDigest, err := extractVersionCore(archivePath, spec.InnerName, corePath)
	if err != nil {
		return "", "", err
	}
	trustedMarker := cachedCoreMarker{
		Version: version, ArchiveSHA: asset.Digest, BinarySHA: binaryDigest,
		AssetName: asset.Name, ArchiveBytes: asset.Size,
	}
	// Persist the trust anchor outside the service-writable mihomo state tree.
	// A forged core.exe + verified.json pair can no longer certify itself.
	if err := runtime.storeVersionTrust(trustedMarker); err != nil {
		return "", "", err
	}
	marker, err := json.Marshal(trustedMarker)
	if err != nil {
		return "", "", err
	}
	if err := writePrivateFile(markerPath, marker); err != nil {
		return "", "", err
	}
	return corePath, binaryDigest, nil
}

func (runtime *windowsRuntime) Install(version string, proxyPort int) error {
	runtime.versionMu.Lock()
	defer runtime.versionMu.Unlock()
	_, _, err := runtime.versionCore(version, proxyPort, true)
	return err
}
