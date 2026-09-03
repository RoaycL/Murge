package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
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

// forbiddenTopKeys are the top-level keys a profile may never carry into the
// elevated child:
//
//   - extra inbounds beyond the single authorized mixed-port (`port`,
//     `socks-port`, `redir-port`, `tproxy-port`, `listeners`, and `tunnels`,
//     which binds arbitrary local ports and forwards them to arbitrary hosts);
//   - controller surfaces that `secret` does not authenticate (mihomo's Unix
//     socket, Windows named pipe, TLS controller and external DoH endpoint all
//     bypass it) and `external-controller-cors`, which widens who may reach the
//     controller from a browser;
//   - remote-archive download/extract: the `external-ui*` family makes mihomo
//     fetch a ZIP and unpack it under the configured directory, then serve it.
//     This product ships its own UI, so these are never legitimate;
//   - `ntp`, whose `write-to-system: true` lets this SYSTEM-privileged process
//     set the machine clock — which can invalidate certificate validity windows
//     and Kerberos tickets host-wide.
//
// None of these are needed to proxy traffic, so refusing them keeps a compromised
// main process from reaching them without depending on mihomo's own checks.
var forbiddenTopKeys = []string{
	"port", "socks-port", "redir-port", "tproxy-port", "listeners", "tunnels",
	"external-controller-unix", "external-controller-pipe", "external-controller-tls",
	"external-controller-routing-mark", "external-controller-cors", "external-doh-server",
	"external-ui", "external-ui-url", "external-ui-name",
	"ntp",
	"ss-config", "vmess-config", "tuic-server",
}

// providerSections name the profile sections whose entries carry a `path` that
// mihomo WRITES downloaded content to. An absolute path or a `..` escape would be
// an arbitrary file write performed by a SYSTEM-privileged process, so the paths
// are confined to the service's own state directory here. mihomo enforces its own
// "subpath of home directory" rule, but this service must not have to trust that:
// it is the boundary, not a second opinion.
var providerSections = []string{"proxy-providers", "rule-providers"}

func validateProviderPaths(profile map[string]any) error {
	for _, section := range providerSections {
		raw, present := profile[section]
		if !present {
			continue
		}
		entries, ok := raw.(map[string]any)
		if !ok {
			return fmt.Errorf("%s must be a mapping", section)
		}
		for name, entryRaw := range entries {
			entry, ok := entryRaw.(map[string]any)
			if !ok {
				return fmt.Errorf("%s.%s must be a mapping", section, name)
			}
			pathRaw, present := entry["path"]
			if !present {
				continue
			}
			path, ok := pathRaw.(string)
			if !ok {
				return fmt.Errorf("%s.%s.path must be a string", section, name)
			}
			if err := ensureContainedPath(path); err != nil {
				return fmt.Errorf("%s.%s.path %w", section, name, err)
			}
		}
	}
	return nil
}

// ensureContainedPath accepts only a relative path with no parent traversal, so
// the resolved target cannot leave the state directory mihomo runs in.
func ensureContainedPath(path string) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("must not be empty")
	}
	if filepath.IsAbs(path) || strings.HasPrefix(path, "/") || strings.HasPrefix(path, `\`) {
		return errors.New("must be relative to the state directory")
	}
	// A Windows drive-relative path (`C:x`) or an NTFS stream both contain a colon.
	if strings.Contains(path, ":") {
		return errors.New("must not name a drive or alternate stream")
	}
	for _, segment := range strings.Split(strings.ReplaceAll(path, `\`, "/"), "/") {
		if segment == ".." {
			return errors.New("must not traverse outside the state directory")
		}
	}
	return nil
}

// validateTunProfile is the service's INDEPENDENT re-validation of the profile.
// The ordinary main process is not trusted: even if it were compromised it must
// not be able to make this SYSTEM-privileged child bind a public port, expose an
// unauthenticated controller or run anything but the pinned packaged mihomo.
//
// It deliberately does NOT constrain proxy CONTENT (`proxies`, `proxy-groups`,
// `proxy-providers`, `rules`, `rule-providers`, resolver splits under `dns`) —
// that content is the whole purpose of a TUN proxy and is the user's routing
// intent. What it enforces is the structural boundary: loopback-only controller
// with a real secret, no extra inbounds, no unauthenticated API surface, TUN
// actually enabled with a well-formed adapter identity, and none of the YAML
// tricks (aliases, custom tags, multiple documents) that could smuggle a value
// past this check.
func validateTunProfile(text string) error {
	var syntax yaml.Node
	if err := yaml.Unmarshal([]byte(text), &syntax); err != nil {
		return err
	}
	if err := rejectUnsafeYAML(&syntax); err != nil {
		return err
	}

	// A permissive map decode (no KnownFields): unknown keys are legitimate mihomo
	// sections, so they are allowed through while the blacklist below still
	// actively rejects the dangerous ones.
	decoder := yaml.NewDecoder(strings.NewReader(text))
	var profile map[string]any
	if err := decoder.Decode(&profile); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("multiple YAML documents are forbidden")
	}
	if profile == nil {
		return errors.New("profile must be a YAML mapping")
	}

	for _, key := range forbiddenTopKeys {
		if _, present := profile[key]; present {
			return fmt.Errorf("forbidden key for a privileged profile: %s", key)
		}
	}
	if err := validateProviderPaths(profile); err != nil {
		return err
	}

	// --- Inbound / authentication boundary (non-negotiable) ---
	if allowLAN, present := profile["allow-lan"]; present {
		enabled, ok := allowLAN.(bool)
		if !ok || enabled {
			return errors.New("allow-lan must be false")
		}
	}
	mixedPort, err := intValue(profile, "mixed-port")
	if err != nil {
		return err
	}
	if mixedPort < 1024 || mixedPort > 65535 {
		return errors.New("mixed-port is outside the allowed range")
	}
	controllerText, ok := profile["external-controller"].(string)
	if !ok {
		return errors.New("external-controller must be a string")
	}
	controller := controllerPattern.FindStringSubmatch(controllerText)
	if controller == nil {
		return errors.New("external-controller must bind loopback")
	}
	controllerPort, _ := strconv.Atoi(controller[1])
	if controllerPort < 1024 || controllerPort > 65535 || controllerPort == mixedPort {
		return errors.New("controller port is invalid")
	}
	secret, ok := profile["secret"].(string)
	if !ok || !secretPattern.MatchString(secret) {
		return errors.New("invalid controller secret")
	}
	if bindAddress, present := profile["bind-address"]; present {
		address, ok := bindAddress.(string)
		if !ok || (address != "127.0.0.1" && address != "localhost") {
			return errors.New("bind-address must stay on loopback")
		}
	}

	// --- TUN ownership boundary (non-negotiable) ---
	tunRaw, present := profile["tun"]
	if !present {
		return errors.New("tun block is required")
	}
	tunMap, ok := tunRaw.(map[string]any)
	if !ok {
		return errors.New("tun must be a mapping")
	}
	if enable, ok := tunMap["enable"].(bool); !ok || !enable {
		return errors.New("tun.enable must be true")
	}
	device, ok := tunMap["device"].(string)
	if !ok || !devicePattern.MatchString(device) {
		return errors.New("invalid TUN device")
	}
	stack, ok := tunMap["stack"].(string)
	if !ok || (stack != "mixed" && stack != "system" && stack != "gvisor") {
		return errors.New("invalid TUN stack")
	}
	hijack, ok := tunMap["dns-hijack"].([]any)
	if !ok || len(hijack) == 0 {
		return errors.New("tun.dns-hijack must be a non-empty sequence")
	}

	// --- DNS boundary: fake-ip required; a public DNS bind is refused ---
	dnsRaw, present := profile["dns"]
	if !present {
		return errors.New("dns block is required")
	}
	dnsMap, ok := dnsRaw.(map[string]any)
	if !ok {
		return errors.New("dns must be a mapping")
	}
	if _, listens := dnsMap["listen"]; listens {
		return errors.New("forbidden key for a privileged profile: dns.listen")
	}
	if enable, ok := dnsMap["enable"].(bool); !ok || !enable {
		return errors.New("dns.enable must be true")
	}
	if mode, ok := dnsMap["enhanced-mode"].(string); !ok || mode != "fake-ip" {
		return errors.New("dns.enhanced-mode must be fake-ip")
	}
	return nil
}

func intValue(profile map[string]any, key string) (int, error) {
	raw, present := profile[key]
	if !present {
		return 0, fmt.Errorf("missing key: %s", key)
	}
	switch value := raw.(type) {
	case int:
		return value, nil
	case int64:
		return int(value), nil
	case float64:
		if value != float64(int(value)) {
			return 0, fmt.Errorf("%s must be an integer", key)
		}
		return int(value), nil
	default:
		return 0, fmt.Errorf("%s must be an integer", key)
	}
}

// standardYAMLTags is the exact set yaml.v3 auto-assigns while resolving a plain
// document. Anything else is an explicitly authored tag.
var standardYAMLTags = map[string]bool{
	"!!map": true, "!!seq": true, "!!str": true,
	"!!int": true, "!!float": true, "!!bool": true,
	"!!null": true, "!!merge": true, "!!timestamp": true,
}

func rejectUnsafeYAML(node *yaml.Node) error {
	if node.Alias != nil || node.Kind == yaml.AliasNode {
		return errors.New("YAML aliases are forbidden")
	}
	// Match against the known-good set rather than the `!!` prefix: a prefix test
	// admits any `!!`-namespaced tag, so a deserializer-directed tag such as
	// `!!python/object` would pass while still being an author-supplied tag.
	if node.Tag != "" && !standardYAMLTags[node.Tag] {
		return errors.New("custom YAML tags are forbidden")
	}
	for _, child := range node.Content {
		if err := rejectUnsafeYAML(child); err != nil {
			return err
		}
	}
	return nil
}
