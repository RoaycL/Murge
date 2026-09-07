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
	request, err := http.NewRequest(http.MethodGet, githubAPIBase+url.PathEscape(version), nil)
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
	if release.TagName != version {
		return githubReleaseAsset{}, errors.New("GitHub release tag mismatch")
	}
	arch, err := mihomoWindowsArch()
	if err != nil {
		return githubReleaseAsset{}, err
	}
	expectedName := fmt.Sprintf("mihomo-windows-%s-%s.zip", arch, version)
	for _, asset := range release.Assets {
		if asset.Name != expectedName {
			continue
		}
		digest := strings.TrimPrefix(asset.Digest, "sha256:")
		parsed, parseErr := url.Parse(asset.BrowserDownloadURL)
		if parseErr != nil || parsed.Scheme != "https" || parsed.Hostname() != "github.com" ||
			!strings.HasPrefix(parsed.Path, "/MetaCubeX/mihomo/releases/download/"+version+"/") {
			return githubReleaseAsset{}, errors.New("unsafe mihomo release URL")
		}
		if !sha256Pattern.MatchString(digest) || asset.Size <= 0 || asset.Size > maxCoreBytes {
			return githubReleaseAsset{}, errors.New("mihomo release lacks a valid digest or size")
		}
		asset.Digest = digest
		return asset, nil
	}
	return githubReleaseAsset{}, fmt.Errorf("official mihomo asset %s was not found", expectedName)
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

func (runtime *windowsRuntime) versionCore(version string, proxyPort int) (string, string, error) {
	if !versionPattern.MatchString(version) {
		return "", "", errors.New("invalid mihomo version")
	}
	directory := filepath.Join(runtime.config.StateDirectory, "versions", version)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", "", err
	}
	if err := secureStateDirectory(directory); err != nil {
		return "", "", err
	}
	markerPath := filepath.Join(directory, "verified.json")
	corePath := filepath.Join(directory, "core.exe")
	if data, err := os.ReadFile(markerPath); err == nil {
		var marker cachedCoreMarker
		if json.Unmarshal(data, &marker) == nil && marker.Version == version && sha256Pattern.MatchString(marker.BinarySHA) {
			if digest, hashErr := hashFile(corePath); hashErr == nil && digest == marker.BinarySHA {
				return corePath, digest, nil
			}
		}
	}
	asset, err := fetchOfficialAsset(version, proxyPort)
	if err != nil {
		return "", "", err
	}
	archivePath := filepath.Join(directory, asset.Name)
	if digest, hashErr := hashFile(archivePath); hashErr != nil || digest != asset.Digest {
		if err := downloadOfficialAsset(asset, archivePath, proxyPort); err != nil {
			return "", "", err
		}
	}
	arch, err := mihomoWindowsArch()
	if err != nil {
		return "", "", err
	}
	innerName := fmt.Sprintf("mihomo-windows-%s.exe", arch)
	binaryDigest, err := extractVersionCore(archivePath, innerName, corePath)
	if err != nil {
		return "", "", err
	}
	marker, err := json.Marshal(cachedCoreMarker{
		Version: version, ArchiveSHA: asset.Digest, BinarySHA: binaryDigest,
		AssetName: asset.Name, ArchiveBytes: asset.Size,
	})
	if err != nil {
		return "", "", err
	}
	if err := writePrivateFile(markerPath, marker); err != nil {
		return "", "", err
	}
	return corePath, binaryDigest, nil
}

func (runtime *windowsRuntime) Install(version string, proxyPort int) error {
	_, _, err := runtime.versionCore(version, proxyPort)
	return err
}
