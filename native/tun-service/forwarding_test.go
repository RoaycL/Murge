package main

import (
	"encoding/json"
	"errors"
	"testing"
)

type fakeForwardingHost struct {
	adapters   []netAdapter
	forwarding map[uint64]bool
	failSet    map[uint64]bool
	sets       []string
}

func newFakeForwardingHost(adapters ...netAdapter) *fakeForwardingHost {
	return &fakeForwardingHost{adapters: adapters, forwarding: map[uint64]bool{}, failSet: map[uint64]bool{}}
}

func (host *fakeForwardingHost) Adapters() ([]netAdapter, error) { return host.adapters, nil }

func (host *fakeForwardingHost) present(luid uint64) bool {
	for _, adapter := range host.adapters {
		if adapter.LUID == luid {
			return true
		}
	}
	return false
}

func (host *fakeForwardingHost) Forwarding(luid uint64) (bool, error) {
	if !host.present(luid) {
		return false, errAdapterGone
	}
	return host.forwarding[luid], nil
}

func (host *fakeForwardingHost) SetForwarding(luid uint64, enabled bool) error {
	if !host.present(luid) {
		return errAdapterGone
	}
	if host.failSet[luid] {
		return errors.New("access denied")
	}
	host.forwarding[luid] = enabled
	state := "off"
	if enabled {
		state = "on"
	}
	host.sets = append(host.sets, state)
	return nil
}

var (
	ethernet = netAdapter{Name: "以太网", LUID: 1, Up: true, Physical: true, HasGateway: true}
	wifiDown = netAdapter{Name: "WLAN", LUID: 2, Up: false, Physical: true, HasGateway: true}
	hyperV   = netAdapter{Name: "vEthernet", LUID: 3, Up: true, Physical: true, HasGateway: false}
	tunCard  = netAdapter{Name: "Murge TUN", LUID: 9, Up: true}
)

func TestForwardingNeedsDesireDeviceAndAdapter(t *testing.T) {
	host := newFakeForwardingHost(ethernet, wifiDown, hyperV)
	keeper := newForwardingKeeper(host)
	keeper.SetDevice("Murge TUN")
	if status := keeper.SetDesired(true); status.TunPresent || len(status.Interfaces) != 0 || len(host.sets) != 0 {
		t.Fatalf("forwarding applied without a TUN adapter: %+v %v", status, host.sets)
	}
	host.adapters = append(host.adapters, tunCard)
	keeper.Tick()
	if !host.forwarding[1] || !host.forwarding[9] || host.forwarding[2] || host.forwarding[3] {
		t.Fatalf("wrong adapters forwarded: %v", host.forwarding)
	}
	status := keeper.Status()
	if !status.TunPresent || len(status.Interfaces) != 2 || status.Interfaces[0].Role != "lan" || !status.Interfaces[1].Managed {
		t.Fatalf("unexpected status: %+v", status)
	}
}

func TestForwardingReappliesToARecreatedAdapterAndRestores(t *testing.T) {
	host := newFakeForwardingHost(ethernet, tunCard)
	keeper := newForwardingKeeper(host)
	keeper.SetDevice("murge tun")
	keeper.SetDesired(true)
	// mihomo recreated the adapter: forwarding starts off again.
	host.forwarding[9] = false
	keeper.Tick()
	if !host.forwarding[9] {
		t.Fatal("recreated TUN adapter was not re-enabled")
	}
	// TUN switched off: the adapter disappears, the LAN side is restored.
	host.adapters = []netAdapter{ethernet}
	keeper.Tick()
	if host.forwarding[1] {
		t.Fatal("LAN forwarding was left on without a TUN adapter")
	}
	if len(keeper.managed) != 0 {
		t.Fatalf("managed adapters left behind: %v", keeper.managed)
	}
}

func TestForwardingNeverUndoesAManualSetting(t *testing.T) {
	host := newFakeForwardingHost(ethernet, tunCard)
	host.forwarding[1] = true // the user ran Set-NetIPInterface before
	keeper := newForwardingKeeper(host)
	keeper.SetDevice("Murge TUN")
	keeper.SetDesired(true)
	keeper.SetDesired(false)
	if !host.forwarding[1] {
		t.Fatal("a forwarding flag the keeper did not set was switched off")
	}
	if host.forwarding[9] {
		t.Fatal("the keeper's own TUN forwarding was not restored")
	}
}

func TestForwardingClearDeviceRestoresButKeepsDesire(t *testing.T) {
	host := newFakeForwardingHost(ethernet, tunCard)
	keeper := newForwardingKeeper(host)
	keeper.SetDevice("Murge TUN")
	keeper.SetDesired(true)
	keeper.ClearDevice()
	if host.forwarding[1] || host.forwarding[9] {
		t.Fatalf("forwarding survived the stop: %v", host.forwarding)
	}
	keeper.SetDevice("Murge TUN")
	if !host.forwarding[1] || !host.forwarding[9] {
		t.Fatal("next session did not re-apply the remembered 网关模式")
	}
}

func TestForwardingReportsFailures(t *testing.T) {
	host := newFakeForwardingHost(ethernet, tunCard)
	host.failSet[1] = true
	keeper := newForwardingKeeper(host)
	keeper.SetDevice("Murge TUN")
	status := keeper.SetDesired(true)
	if status.Error == "" || status.Interfaces[0].Forwarding {
		t.Fatalf("failure not reported: %+v", status)
	}
}

func TestForwardingOperationRoundTrip(t *testing.T) {
	host := newFakeForwardingHost(ethernet, tunCard)
	manager := newSessionManager(&fakeRuntime{}, &memoryStore{})
	unsupported := manager.Handle(serviceRequest{ProtocolVersion: protocolVersion, RequestID: "1", Operation: "forwarding", Forwarding: "enable"})
	if unsupported.Outcome != "failed" {
		t.Fatalf("expected failure without a keeper, got %+v", unsupported)
	}
	manager.forwarding = newForwardingKeeper(host)
	manager.forwarding.SetDevice("Murge TUN")
	response := manager.Handle(serviceRequest{ProtocolVersion: protocolVersion, RequestID: "2", Operation: "forwarding", Forwarding: "enable"})
	if response.Outcome != "forwarding" || response.Content == nil || response.ContentFormat == nil || *response.ContentFormat != "json" {
		t.Fatalf("unexpected response: %+v", response)
	}
	var status forwardingStatus
	if err := json.Unmarshal([]byte(*response.Content), &status); err != nil || !status.Desired || len(status.Interfaces) != 2 {
		t.Fatalf("bad status payload %q: %v", *response.Content, err)
	}
}

func TestForwardingRequestDecoding(t *testing.T) {
	for _, row := range []struct {
		body string
		ok   bool
	}{
		{`{"protocolVersion":8,"requestId":"1","operation":"forwarding","forwarding":"enable"}`, true},
		{`{"protocolVersion":8,"requestId":"1","operation":"forwarding","forwarding":"status"}`, true},
		{`{"protocolVersion":8,"requestId":"1","operation":"forwarding"}`, false},
		{`{"protocolVersion":8,"requestId":"1","operation":"forwarding","forwarding":"以太网"}`, false},
		{`{"protocolVersion":8,"requestId":"1","operation":"status","forwarding":"enable"}`, false},
		{`{"protocolVersion":8,"requestId":"1","operation":"forwarding","forwarding":"enable","providerName":"x"}`, false},
	} {
		_, err := decodeRequest([]byte(row.body))
		if (err == nil) != row.ok {
			t.Fatalf("%s: err=%v", row.body, err)
		}
	}
}

func TestTunDeviceFromProfile(t *testing.T) {
	if got := tunDeviceFromProfile("tun:\n  enable: false\n  device: Murge TUN\n"); got != "Murge TUN" {
		t.Fatalf("got %q", got)
	}
	if got := tunDeviceFromProfile("tun:\n  device: \"../x\"\n"); got != "" {
		t.Fatalf("unsafe device accepted: %q", got)
	}
}
