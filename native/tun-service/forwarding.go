package main

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// 网关模式 needs Windows IPv4 forwarding on the LAN adapter (where the other
// devices' packets arrive) and on the TUN adapter (where mihomo picks them up).
// Doing that by hand takes an elevated `Set-NetIPInterface`, and it is lost
// every time mihomo recreates the TUN adapter. The keeper does it from this
// already-elevated service instead, and keeps it true while the GUI wants it.
//
// The GUI only says "on" or "off". It cannot name an adapter: the TUN adapter is
// the one from the last profile this service started, and the LAN adapters are
// the physical (Ethernet / Wi-Fi) adapters that are up and have a default
// gateway. Forwarding is switched back off only on adapters the keeper itself
// switched on, so a setting the user made by hand is never undone.

const forwardingInterval = 3 * time.Second

type netAdapter struct {
	Name       string
	LUID       uint64
	Up         bool
	Physical   bool
	HasGateway bool
}

// forwardingHost is the OS surface: list adapters, read and write the IPv4
// forwarding flag of one adapter.
type forwardingHost interface {
	Adapters() ([]netAdapter, error)
	Forwarding(luid uint64) (bool, error)
	SetForwarding(luid uint64, enabled bool) error
	// AllowInbound (re)creates the one firewall rule that lets devices on the
	// local subnet reach program; RemoveInbound deletes it.
	AllowInbound(program string) error
	RemoveInbound() error
}

type forwardingInterface struct {
	Name       string `json:"name"`
	Role       string `json:"role"`
	Forwarding bool   `json:"forwarding"`
	Managed    bool   `json:"managed"`
}

type forwardingStatus struct {
	Desired    bool                  `json:"desired"`
	Device     string                `json:"device"`
	TunPresent bool                  `json:"tunPresent"`
	Interfaces []forwardingInterface `json:"interfaces"`
	Firewall   bool                  `json:"firewall"`
	Error      string                `json:"error"`
}

type forwardingKeeper struct {
	mu      sync.Mutex
	host    forwardingHost
	desired bool
	// lanProxy: allow-lan is on, so LAN devices dial mihomo's HTTP / SOCKS5
	// listeners directly and need the same firewall rule.
	lanProxy bool
	device   string
	// managed holds the adapters this keeper switched forwarding ON for, so
	// that only those are switched back off.
	managed map[uint64]string
	lastErr string
	targets []forwardingInterface
	tun     bool
	// program is the mihomo executable of the running core; firewall is the
	// program the inbound rule currently allows ("" = no rule).
	program  string
	firewall string
}

func newForwardingKeeper(host forwardingHost) *forwardingKeeper {
	return &forwardingKeeper{host: host, managed: map[uint64]string{}}
}

// SetDevice records the TUN adapter name and the mihomo executable of the
// profile that was just started.
func (keeper *forwardingKeeper) SetDevice(device string, program string) {
	if keeper == nil {
		return
	}
	keeper.mu.Lock()
	defer keeper.mu.Unlock()
	keeper.device = device
	keeper.program = program
	keeper.ensureLocked()
}

// SetDesired turns 网关模式 forwarding on or off and applies it at once.
func (keeper *forwardingKeeper) SetDesired(desired bool) forwardingStatus {
	keeper.mu.Lock()
	defer keeper.mu.Unlock()
	keeper.desired = desired
	keeper.ensureLocked()
	return keeper.statusLocked()
}

// SetLANProxy records whether allow-lan is on, which also needs the inbound
// firewall rule while a core runs.
func (keeper *forwardingKeeper) SetLANProxy(enabled bool) forwardingStatus {
	keeper.mu.Lock()
	defer keeper.mu.Unlock()
	keeper.lanProxy = enabled
	keeper.ensureLocked()
	return keeper.statusLocked()
}

func (keeper *forwardingKeeper) Status() forwardingStatus {
	keeper.mu.Lock()
	defer keeper.mu.Unlock()
	keeper.ensureLocked()
	return keeper.statusLocked()
}

// Tick re-applies the desired state. The TUN adapter comes and goes with the
// TUN switch and with every core restart, and a new adapter starts with
// forwarding off.
func (keeper *forwardingKeeper) Tick() {
	if keeper == nil {
		return
	}
	keeper.mu.Lock()
	defer keeper.mu.Unlock()
	if !keeper.desired && len(keeper.managed) == 0 {
		return
	}
	keeper.ensureLocked()
}

// ClearDevice forgets the TUN adapter and switches off everything the keeper
// switched on, while remembering whether the GUI wants 网关模式: the core that
// owned the adapter stopped (or the service is shutting down).
func (keeper *forwardingKeeper) ClearDevice() {
	if keeper == nil {
		return
	}
	keeper.mu.Lock()
	defer keeper.mu.Unlock()
	keeper.device = ""
	keeper.program = ""
	keeper.restoreLocked(nil)
	keeper.syncFirewallLocked()
	keeper.targets = nil
	keeper.tun = false
}

func (keeper *forwardingKeeper) Run(stop <-chan struct{}) {
	ticker := time.NewTicker(forwardingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			keeper.Tick()
		}
	}
}

func (keeper *forwardingKeeper) ensureLocked() {
	keeper.lastErr = ""
	keeper.targets = nil
	keeper.tun = false
	keeper.syncFirewallLocked()
	wanted := map[uint64]string{}
	roles := map[uint64]string{}
	if keeper.desired && keeper.device != "" {
		adapters, err := keeper.host.Adapters()
		if err != nil {
			keeper.lastErr = "list adapters: " + err.Error()
			return
		}
		var tun *netAdapter
		for index := range adapters {
			if adapters[index].Up && strings.EqualFold(adapters[index].Name, keeper.device) {
				tun = &adapters[index]
				break
			}
		}
		if tun != nil {
			keeper.tun = true
			wanted[tun.LUID] = tun.Name
			roles[tun.LUID] = "tun"
			for _, adapter := range adapters {
				if adapter.LUID == tun.LUID || !adapter.Up || !adapter.Physical || !adapter.HasGateway {
					continue
				}
				wanted[adapter.LUID] = adapter.Name
				roles[adapter.LUID] = "lan"
			}
		}
	}
	keeper.restoreLocked(wanted)
	luids := make([]uint64, 0, len(wanted))
	for luid := range wanted {
		luids = append(luids, luid)
	}
	sort.Slice(luids, func(a, b int) bool {
		if roles[luids[a]] != roles[luids[b]] {
			return roles[luids[a]] == "lan"
		}
		return wanted[luids[a]] < wanted[luids[b]]
	})
	var failures []string
	for _, luid := range luids {
		name := wanted[luid]
		enabled, err := keeper.host.Forwarding(luid)
		if err == nil && !enabled {
			if err = keeper.host.SetForwarding(luid, true); err == nil {
				enabled = true
				keeper.managed[luid] = name
			}
		}
		if err != nil {
			failures = append(failures, name+": "+err.Error())
		}
		_, managed := keeper.managed[luid]
		keeper.targets = append(keeper.targets, forwardingInterface{Name: name, Role: roles[luid], Forwarding: enabled, Managed: managed})
	}
	if len(failures) > 0 {
		if keeper.lastErr != "" {
			keeper.lastErr += "; "
		}
		keeper.lastErr += strings.Join(failures, "; ")
	}
}

// syncFirewallLocked keeps the inbound rule exactly while 网关模式 or allow-lan
// is wanted and a core is running: forwarded devices reach mihomo from the LAN, which
// Windows Firewall otherwise blocks on a network marked Public. The rule is
// limited to the local subnet and to the running mihomo executable, so the
// network does not need to be switched to Private.
func (keeper *forwardingKeeper) syncFirewallLocked() {
	want := ""
	if keeper.desired || keeper.lanProxy {
		want = keeper.program
	}
	if want == keeper.firewall {
		return
	}
	var err error
	if want == "" {
		err = keeper.host.RemoveInbound()
	} else {
		err = keeper.host.AllowInbound(want)
	}
	if err != nil {
		if keeper.lastErr != "" {
			keeper.lastErr += "; "
		}
		keeper.lastErr += "firewall: " + err.Error()
		return
	}
	keeper.firewall = want
}

// restoreLocked switches forwarding back off on every managed adapter that is
// not in keep. An adapter that has disappeared is simply forgotten.
func (keeper *forwardingKeeper) restoreLocked(keep map[uint64]string) {
	for luid, name := range keeper.managed {
		if _, kept := keep[luid]; kept {
			continue
		}
		if err := keeper.host.SetForwarding(luid, false); err != nil && !errors.Is(err, errAdapterGone) {
			if keeper.lastErr != "" {
				keeper.lastErr += "; "
			}
			keeper.lastErr += "restore " + name + ": " + err.Error()
		}
		delete(keeper.managed, luid)
	}
}

func (keeper *forwardingKeeper) statusLocked() forwardingStatus {
	interfaces := keeper.targets
	if interfaces == nil {
		interfaces = []forwardingInterface{}
	}
	return forwardingStatus{
		Desired:    keeper.desired,
		Device:     keeper.device,
		TunPresent: keeper.tun,
		Interfaces: interfaces,
		Firewall:   keeper.firewall != "",
		Error:      keeper.lastErr,
	}
}

var errAdapterGone = errors.New("adapter is gone")

func encodeForwardingStatus(status forwardingStatus) string {
	data, _ := json.Marshal(status)
	return string(data)
}

// tunDeviceFromProfile reads tun.device from a profile validateTunProfile has
// already accepted.
func tunDeviceFromProfile(profile string) string {
	var document struct {
		Tun struct {
			Device string `yaml:"device"`
		} `yaml:"tun"`
	}
	if err := yaml.Unmarshal([]byte(profile), &document); err != nil {
		return ""
	}
	if !devicePattern.MatchString(document.Tun.Device) {
		return ""
	}
	return document.Tun.Device
}
