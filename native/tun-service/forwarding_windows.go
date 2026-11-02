//go:build windows

package main

import (
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// x/sys/windows wraps GetIpInterfaceEntry but not its setter.
var procSetIpInterfaceEntry = windows.NewLazySystemDLL("iphlpapi.dll").NewProc("SetIpInterfaceEntry")

type windowsForwardingHost struct {
	// ruleName names the single inbound firewall rule this service owns.
	ruleName string
}

func (*windowsForwardingHost) Adapters() ([]netAdapter, error) {
	flags := uint32(windows.GAA_FLAG_INCLUDE_GATEWAYS | windows.GAA_FLAG_SKIP_ANYCAST | windows.GAA_FLAG_SKIP_MULTICAST | windows.GAA_FLAG_SKIP_DNS_SERVER)
	size := uint32(16 * 1024)
	var buffer []byte
	for attempt := 0; attempt < 4; attempt++ {
		buffer = make([]byte, size)
		err := windows.GetAdaptersAddresses(windows.AF_INET, flags, 0, (*windows.IpAdapterAddresses)(unsafe.Pointer(&buffer[0])), &size)
		if err == nil {
			break
		}
		if !errors.Is(err, windows.ERROR_BUFFER_OVERFLOW) || attempt == 3 {
			return nil, err
		}
	}
	var adapters []netAdapter
	for entry := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buffer[0])); entry != nil; entry = entry.Next {
		adapters = append(adapters, netAdapter{
			Name:       windows.UTF16PtrToString(entry.FriendlyName),
			LUID:       entry.Luid,
			Up:         entry.OperStatus == windows.IfOperStatusUp,
			Physical:   entry.IfType == windows.IF_TYPE_ETHERNET_CSMACD || entry.IfType == windows.IF_TYPE_IEEE80211,
			HasGateway: entry.FirstGatewayAddress != nil,
		})
	}
	return adapters, nil
}

func ipv4InterfaceRow(luid uint64) (*windows.MibIpInterfaceRow, error) {
	row := &windows.MibIpInterfaceRow{Family: windows.AF_INET, InterfaceLuid: luid}
	if err := windows.GetIpInterfaceEntry(row); err != nil {
		if errors.Is(err, windows.ERROR_NOT_FOUND) || errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			return nil, errAdapterGone
		}
		return nil, err
	}
	return row, nil
}

func (*windowsForwardingHost) Forwarding(luid uint64) (bool, error) {
	row, err := ipv4InterfaceRow(luid)
	if err != nil {
		return false, err
	}
	return row.ForwardingEnabled != 0, nil
}

func (*windowsForwardingHost) SetForwarding(luid uint64, enabled bool) error {
	row, err := ipv4InterfaceRow(luid)
	if err != nil {
		return err
	}
	if enabled {
		row.ForwardingEnabled = 1
	} else {
		row.ForwardingEnabled = 0
	}
	// SetIpInterfaceEntry rejects an IPv4 row whose SitePrefixLength is set.
	row.SitePrefixLength = 0
	result, _, _ := procSetIpInterfaceEntry.Call(uintptr(unsafe.Pointer(row)))
	if result != 0 {
		err := windows.Errno(result)
		if errors.Is(err, windows.ERROR_NOT_FOUND) || errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			return errAdapterGone
		}
		return err
	}
	return nil
}

func netsh(arguments ...string) (string, error) {
	system, err := windows.GetSystemDirectory()
	if err != nil {
		return "", err
	}
	command := exec.Command(filepath.Join(system, "netsh.exe"), arguments...)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := command.CombinedOutput()
	return strings.TrimSpace(string(output)), err
}

func (host *windowsForwardingHost) AllowInbound(program string) error {
	if !filepath.IsAbs(program) || strings.ContainsAny(program, "\"\r\n") {
		return errors.New("invalid program path")
	}
	_ = host.RemoveInbound()
	output, err := netsh("advfirewall", "firewall", "add", "rule",
		"name="+host.ruleName, "dir=in", "action=allow", "enable=yes",
		"profile=any", "remoteip=localsubnet", "program="+program)
	if err != nil {
		return fmt.Errorf("%v: %s", err, output)
	}
	return nil
}

// RemoveInbound deletes the rule. netsh fails (with localized text) when no
// rule matched, which is already the goal, so the result is not an error.
func (host *windowsForwardingHost) RemoveInbound() error {
	_, _ = netsh("advfirewall", "firewall", "delete", "rule", "name="+host.ruleName)
	return nil
}
