package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

const protocolVersion = 2
const maxProfileBytes = 64 * 1024

var (
	sha256Pattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	uuidPattern       = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	devicePattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$`)
	secretPattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	controllerPattern = regexp.MustCompile(`^127\.0\.0\.1:([1-9][0-9]*)$`)
)

type serviceRequest struct {
	ProtocolVersion int    `json:"protocolVersion"`
	RequestID       string `json:"requestId"`
	Operation       string `json:"operation"`
	SessionID       string `json:"sessionId,omitempty"`
	Profile         string `json:"profile,omitempty"`
	ProfileSHA256   string `json:"profileSha256,omitempty"`
}

type serviceResponse struct {
	ProtocolVersion int     `json:"protocolVersion"`
	RequestID       string  `json:"requestId"`
	Outcome         string  `json:"outcome"`
	SessionID       *string `json:"sessionId"`
	PID             *int    `json:"pid"`
	ErrorCode       *string `json:"errorCode"`
}

func decodeRequest(data []byte) (serviceRequest, error) {
	if len(data) == 0 || len(data) > maxProfileBytes+4096 {
		return serviceRequest{}, errors.New("request size is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var request serviceRequest
	if err := decoder.Decode(&request); err != nil {
		return serviceRequest{}, fmt.Errorf("invalid JSON envelope: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return serviceRequest{}, err
	}
	if request.ProtocolVersion != protocolVersion {
		return serviceRequest{}, errors.New("unsupported protocolVersion")
	}
	if err := validateUint64(request.RequestID); err != nil {
		return serviceRequest{}, fmt.Errorf("invalid requestId: %w", err)
	}
	switch request.Operation {
	case "start":
		if !uuidPattern.MatchString(request.SessionID) {
			return serviceRequest{}, errors.New("invalid start sessionId")
		}
		if len([]byte(request.Profile)) == 0 || len([]byte(request.Profile)) > maxProfileBytes {
			return serviceRequest{}, errors.New("profile byte size is invalid")
		}
		if !sha256Pattern.MatchString(request.ProfileSHA256) {
			return serviceRequest{}, errors.New("invalid profileSha256")
		}
		digest := sha256.Sum256([]byte(request.Profile))
		if hex.EncodeToString(digest[:]) != request.ProfileSHA256 {
			return serviceRequest{}, errors.New("profile digest mismatch")
		}
		if err := validateTunProfile(request.Profile); err != nil {
			return serviceRequest{}, fmt.Errorf("unsafe TUN profile: %w", err)
		}
	case "stop":
		if !uuidPattern.MatchString(request.SessionID) || request.Profile != "" || request.ProfileSHA256 != "" {
			return serviceRequest{}, errors.New("invalid stop request")
		}
	case "status", "reconcile":
		if request.SessionID != "" || request.Profile != "" || request.ProfileSHA256 != "" {
			return serviceRequest{}, errors.New("read operation contains forbidden fields")
		}
	default:
		return serviceRequest{}, errors.New("operation is not allowlisted")
	}
	return request, nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("multiple JSON values are forbidden")
		}
		return fmt.Errorf("invalid trailing JSON: %w", err)
	}
	return nil
}

func validateUint64(value string) error {
	if value == "" || (len(value) > 1 && value[0] == '0') || strings.HasPrefix(value, "-") {
		return errors.New("must be canonical unsigned decimal")
	}
	_, err := strconv.ParseUint(value, 10, 64)
	return err
}

type tunProfile struct {
	MixedPort          int      `yaml:"mixed-port"`
	AllowLAN           bool     `yaml:"allow-lan"`
	Mode               string   `yaml:"mode"`
	LogLevel           string   `yaml:"log-level"`
	IPv6               bool     `yaml:"ipv6"`
	ExternalController string   `yaml:"external-controller"`
	Secret             string   `yaml:"secret"`
	Tun                tunBlock `yaml:"tun"`
	DNS                dnsBlock `yaml:"dns"`
	Rules              []string `yaml:"rules"`
}

type tunBlock struct {
	Enable              bool     `yaml:"enable"`
	Device              string   `yaml:"device"`
	Stack               string   `yaml:"stack"`
	AutoRoute           bool     `yaml:"auto-route"`
	AutoDetectInterface bool     `yaml:"auto-detect-interface"`
	StrictRoute         bool     `yaml:"strict-route"`
	DNSHijack           []string `yaml:"dns-hijack"`
}

type dnsBlock struct {
	Enable       bool     `yaml:"enable"`
	EnhancedMode string   `yaml:"enhanced-mode"`
	FakeIPRange  string   `yaml:"fake-ip-range"`
	Nameserver   []string `yaml:"nameserver"`
}

func validateTunProfile(text string) error {
	var syntax yaml.Node
	if err := yaml.Unmarshal([]byte(text), &syntax); err != nil {
		return err
	}
	if err := rejectUnsafeYAML(&syntax); err != nil {
		return err
	}
	decoder := yaml.NewDecoder(strings.NewReader(text))
	decoder.KnownFields(true)
	var profile tunProfile
	if err := decoder.Decode(&profile); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("multiple YAML documents are forbidden")
	}
	if profile.MixedPort < 1024 || profile.MixedPort > 65535 {
		return errors.New("mixed-port is outside the allowed range")
	}
	if profile.AllowLAN || profile.Mode != "direct" || profile.IPv6 {
		return errors.New("top-level safety policy mismatch")
	}
	if profile.LogLevel != "silent" && profile.LogLevel != "error" && profile.LogLevel != "warn" && profile.LogLevel != "info" && profile.LogLevel != "debug" {
		return errors.New("invalid log-level")
	}
	controller := controllerPattern.FindStringSubmatch(profile.ExternalController)
	if controller == nil {
		return errors.New("external-controller must bind loopback")
	}
	controllerPort, _ := strconv.Atoi(controller[1])
	if controllerPort < 1024 || controllerPort > 65535 || controllerPort == profile.MixedPort {
		return errors.New("controller port is invalid")
	}
	if !secretPattern.MatchString(profile.Secret) {
		return errors.New("invalid controller secret")
	}
	if !profile.Tun.Enable || !profile.Tun.AutoRoute || !profile.Tun.AutoDetectInterface || profile.Tun.StrictRoute {
		return errors.New("TUN ownership policy mismatch")
	}
	if !devicePattern.MatchString(profile.Tun.Device) {
		return errors.New("invalid TUN device")
	}
	if profile.Tun.Stack != "mixed" && profile.Tun.Stack != "system" && profile.Tun.Stack != "gvisor" {
		return errors.New("invalid TUN stack")
	}
	if !equalStrings(profile.Tun.DNSHijack, []string{"any:53"}) {
		return errors.New("dns-hijack policy mismatch")
	}
	if !profile.DNS.Enable || profile.DNS.EnhancedMode != "fake-ip" || profile.DNS.FakeIPRange != "198.18.0.1/16" || !equalStrings(profile.DNS.Nameserver, []string{"system"}) {
		return errors.New("DNS policy mismatch")
	}
	if !equalStrings(profile.Rules, []string{"MATCH,DIRECT"}) {
		return errors.New("rules policy mismatch")
	}
	return nil
}

func rejectUnsafeYAML(node *yaml.Node) error {
	if node.Alias != nil || node.Kind == yaml.AliasNode {
		return errors.New("YAML aliases are forbidden")
	}
	if node.Tag != "" && !strings.HasPrefix(node.Tag, "!!") {
		return errors.New("custom YAML tags are forbidden")
	}
	for _, child := range node.Content {
		if err := rejectUnsafeYAML(child); err != nil {
			return err
		}
	}
	return nil
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
