//! 活动页「网络」: what the primary network is, the way Surge labels it —
//! 以太网 for a wired link, the SSID for Wi-Fi, 蜂窝网络 for a WWAN modem,
//! 无网络 when nothing usable is up.
//!
//! "Primary" is the up adapter with a default gateway and the lowest IPv4
//! metric, skipping mihomo's own TUN and other virtual adapters so turning
//! TUN on does not relabel the network. Read-only: one adapter-table read and,
//! for Wi-Fi, one WLAN connection query.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetworkKind {
    Ethernet,
    /// Wi-Fi with its SSID when Windows lets us read it (24H2+ hides it from
    /// apps without location permission; then the label is plain "Wi-Fi").
    WiFi(Option<String>),
    Cellular,
    /// Anything else with a default route, labelled by its adapter name.
    Other(String),
    Offline,
}

impl NetworkKind {
    pub fn display_name(&self) -> String {
        match self {
            NetworkKind::Ethernet => "以太网".to_string(),
            NetworkKind::WiFi(Some(ssid)) if !ssid.trim().is_empty() => ssid.trim().to_string(),
            NetworkKind::WiFi(_) => "Wi-Fi".to_string(),
            NetworkKind::Cellular => "蜂窝网络".to_string(),
            NetworkKind::Other(name) if !name.trim().is_empty() => name.trim().to_string(),
            NetworkKind::Other(_) => "以太网".to_string(),
            NetworkKind::Offline => "无网络".to_string(),
        }
    }
}

/// IANA ifType values Windows reports in `IP_ADAPTER_ADDRESSES.IfType`.
pub const IF_TYPE_ETHERNET_CSMACD: u32 = 6;
pub const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;
pub const IF_TYPE_PROP_VIRTUAL: u32 = 53;
pub const IF_TYPE_IEEE80211: u32 = 71;
pub const IF_TYPE_TUNNEL: u32 = 131;
pub const IF_TYPE_WWANPP: u32 = 243;
pub const IF_TYPE_WWANPP2: u32 = 244;

/// One candidate adapter, platform-neutral so selection is unit-testable.
#[derive(Debug, Clone)]
pub struct AdapterInfo {
    pub if_type: u32,
    pub friendly_name: String,
    pub description: String,
    pub has_gateway: bool,
    pub is_up: bool,
    pub metric: u32,
    /// `{GUID}` adapter name, used to match the WLAN interface.
    pub adapter_id: String,
    /// First default-gateway address as text (empty when unknown). Part of
    /// the network identity: a new Wi-Fi on the same adapter usually brings a
    /// new gateway even when the SSID cannot be read.
    pub gateway: String,
}

fn is_virtual(adapter: &AdapterInfo) -> bool {
    matches!(
        adapter.if_type,
        IF_TYPE_SOFTWARE_LOOPBACK | IF_TYPE_PROP_VIRTUAL | IF_TYPE_TUNNEL
    ) || crate::network_detector::is_ignored_interface_name(&adapter.friendly_name)
        || crate::network_detector::is_ignored_interface_name(&adapter.description)
        || adapter.description.to_lowercase().contains("wintun")
}

/// The adapter that carries the default route for real traffic.
pub fn pick_primary(adapters: &[AdapterInfo]) -> Option<&AdapterInfo> {
    adapters
        .iter()
        .filter(|adapter| adapter.is_up && adapter.has_gateway && !is_virtual(adapter))
        .min_by_key(|adapter| adapter.metric)
}

pub fn classify(adapter: &AdapterInfo) -> NetworkKind {
    match adapter.if_type {
        IF_TYPE_ETHERNET_CSMACD => NetworkKind::Ethernet,
        IF_TYPE_IEEE80211 => NetworkKind::WiFi(None),
        IF_TYPE_WWANPP | IF_TYPE_WWANPP2 => NetworkKind::Cellular,
        _ => NetworkKind::Other(adapter.friendly_name.clone()),
    }
}

/// Detect the primary network now.
pub fn detect() -> NetworkKind {
    let adapters = platform::adapters();
    let Some(primary) = pick_primary(&adapters) else {
        return NetworkKind::Offline;
    };
    match classify(primary) {
        NetworkKind::WiFi(_) => NetworkKind::WiFi(platform::wifi_ssid(&primary.adapter_id)),
        other => other,
    }
}

/// Display label for the Activity page.
pub fn detect_display_name() -> String {
    detect().display_name()
}

/// Which network the machine is on, for change detection: the primary
/// adapter plus its gateway, and the SSID when it is Wi-Fi and readable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkSnapshot {
    pub identity: String,
    pub wifi: bool,
    pub ssid: Option<String>,
}

impl NetworkSnapshot {
    /// Same network? An SSID that could be read once and not the next time
    /// (WLAN query hiccup) is not a change.
    pub fn same_network(&self, other: &NetworkSnapshot) -> bool {
        self.identity == other.identity
            && match (&self.ssid, &other.ssid) {
                (Some(left), Some(right)) => left == right,
                _ => true,
            }
    }
}

pub fn snapshot_of(
    adapters: &[AdapterInfo],
    ssid: impl FnOnce(&str) -> Option<String>,
) -> Option<NetworkSnapshot> {
    let primary = pick_primary(adapters)?;
    let wifi = primary.if_type == IF_TYPE_IEEE80211;
    Some(NetworkSnapshot {
        identity: format!("{}|{}", primary.adapter_id, primary.gateway),
        wifi,
        ssid: if wifi {
            ssid(&primary.adapter_id)
        } else {
            None
        },
    })
}

/// The primary network now; `None` when offline.
pub fn snapshot() -> Option<NetworkSnapshot> {
    snapshot_of(&platform::adapters(), platform::wifi_ssid)
}

/// Whether an up adapter with this name exists (the TUN device check after a
/// resume; Windows names the wintun adapter after `tun.device`).
pub fn adapter_present(name: &str) -> bool {
    let wanted = name.trim().to_lowercase();
    if wanted.is_empty() {
        return true;
    }
    platform::adapters().iter().any(|adapter| {
        adapter.friendly_name.to_lowercase() == wanted
            || adapter.description.to_lowercase() == wanted
    })
}

#[cfg(windows)]
mod platform {
    use super::AdapterInfo;
    use windows::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, HANDLE, NO_ERROR};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_SKIP_ANYCAST,
        GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
        IP_ADAPTER_GATEWAY_ADDRESS_LH,
    };
    use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows::Win32::NetworkManagement::WiFi::{
        wlan_interface_state_connected, wlan_intf_opcode_current_connection, WlanCloseHandle,
        WlanEnumInterfaces, WlanFreeMemory, WlanOpenHandle, WlanQueryInterface,
        WLAN_CONNECTION_ATTRIBUTES, WLAN_INTERFACE_INFO_LIST,
    };
    use windows::Win32::Networking::WinSock::{
        AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR_IN, SOCKADDR_IN6,
    };

    pub fn adapters() -> Vec<AdapterInfo> {
        let flags = GAA_FLAG_INCLUDE_GATEWAYS
            | GAA_FLAG_SKIP_ANYCAST
            | GAA_FLAG_SKIP_MULTICAST
            | GAA_FLAG_SKIP_DNS_SERVER;
        let mut size: u32 = 16 * 1024;
        let mut buffer: Vec<u64>;
        let mut attempts = 0;
        loop {
            // u64 storage keeps the struct array 8-byte aligned.
            buffer = vec![0u64; (size as usize).div_ceil(8)];
            let rc = unsafe {
                GetAdaptersAddresses(
                    AF_UNSPEC.0 as u32,
                    flags,
                    None,
                    Some(buffer.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH),
                    &mut size,
                )
            };
            if rc == ERROR_BUFFER_OVERFLOW.0 && attempts < 3 {
                attempts += 1;
                continue;
            }
            if rc != NO_ERROR.0 {
                return Vec::new();
            }
            break;
        }
        let mut out = Vec::new();
        let mut cursor = buffer.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        while !cursor.is_null() {
            let adapter = unsafe { &*cursor };
            let friendly_name = unsafe { adapter.FriendlyName.to_string() }.unwrap_or_default();
            let description = unsafe { adapter.Description.to_string() }.unwrap_or_default();
            let adapter_id = unsafe { adapter.AdapterName.to_string() }.unwrap_or_default();
            let gateway = unsafe { gateway_text(adapter.FirstGatewayAddress) };
            out.push(AdapterInfo {
                if_type: adapter.IfType,
                friendly_name,
                description,
                has_gateway: !adapter.FirstGatewayAddress.is_null(),
                is_up: adapter.OperStatus == IfOperStatusUp,
                metric: adapter.Ipv4Metric,
                adapter_id,
                gateway,
            });
            cursor = adapter.Next;
        }
        out
    }

    /// The first gateway's address as text; empty when absent or unparsable.
    ///
    /// # Safety
    /// `first` comes from a live `GetAdaptersAddresses` buffer.
    unsafe fn gateway_text(first: *mut IP_ADAPTER_GATEWAY_ADDRESS_LH) -> String {
        if first.is_null() {
            return String::new();
        }
        let sockaddr = (*first).Address.lpSockaddr;
        if sockaddr.is_null() {
            return String::new();
        }
        match (*sockaddr).sa_family {
            AF_INET => {
                let v4 = &*(sockaddr as *const SOCKADDR_IN);
                std::net::Ipv4Addr::from(u32::from_be(v4.sin_addr.S_un.S_addr)).to_string()
            }
            AF_INET6 => {
                let v6 = &*(sockaddr as *const SOCKADDR_IN6);
                std::net::Ipv6Addr::from(v6.sin6_addr.u.Byte).to_string()
            }
            _ => String::new(),
        }
    }

    fn guid_text(guid: &windows::core::GUID) -> String {
        format!("{guid:?}")
            .trim_matches(|c| c == '{' || c == '}')
            .to_ascii_lowercase()
    }

    pub fn wifi_ssid(adapter_id: &str) -> Option<String> {
        let wanted = adapter_id
            .trim_matches(|c| c == '{' || c == '}')
            .to_ascii_lowercase();
        let mut negotiated = 0u32;
        let mut handle = HANDLE::default();
        if unsafe { WlanOpenHandle(2, None, &mut negotiated, &mut handle) } != NO_ERROR.0 {
            return None;
        }
        let mut result = None;
        let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
        if unsafe { WlanEnumInterfaces(handle, None, &mut list) } == NO_ERROR.0 && !list.is_null() {
            let count = unsafe { (*list).dwNumberOfItems } as usize;
            let items =
                unsafe { std::slice::from_raw_parts((*list).InterfaceInfo.as_ptr(), count) };
            let pick = items
                .iter()
                .filter(|item| item.isState == wlan_interface_state_connected)
                .max_by_key(|item| guid_text(&item.InterfaceGuid) == wanted);
            if let Some(item) = pick {
                let mut size = 0u32;
                let mut data: *mut core::ffi::c_void = std::ptr::null_mut();
                let rc = unsafe {
                    WlanQueryInterface(
                        handle,
                        &item.InterfaceGuid,
                        wlan_intf_opcode_current_connection,
                        None,
                        &mut size,
                        &mut data,
                        None,
                    )
                };
                if rc == NO_ERROR.0 && !data.is_null() {
                    let attributes = unsafe { &*(data as *const WLAN_CONNECTION_ATTRIBUTES) };
                    let ssid = &attributes.wlanAssociationAttributes.dot11Ssid;
                    let len = (ssid.uSSIDLength as usize).min(ssid.ucSSID.len());
                    let text = String::from_utf8_lossy(&ssid.ucSSID[..len])
                        .trim()
                        .to_string();
                    if !text.is_empty() {
                        result = Some(text);
                    }
                    unsafe { WlanFreeMemory(data) };
                }
            }
            unsafe { WlanFreeMemory(list as *const core::ffi::c_void) };
        }
        unsafe { WlanCloseHandle(handle, None) };
        result
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    /// Dev/CI hosts: a best-effort guess from interface names; the product
    /// only ships on Windows.
    pub fn adapters() -> Vec<AdapterInfo> {
        let Ok(interfaces) = if_addrs::get_if_addrs() else {
            return Vec::new();
        };
        interfaces
            .into_iter()
            .filter(|interface| !interface.is_loopback() && interface.ip().is_ipv4())
            .map(|interface| {
                let name = interface.name.clone();
                let lower = name.to_lowercase();
                let if_type = if lower.starts_with("wl") {
                    IF_TYPE_IEEE80211
                } else if lower.starts_with("en") || lower.starts_with("eth") {
                    IF_TYPE_ETHERNET_CSMACD
                } else {
                    0
                };
                AdapterInfo {
                    if_type,
                    friendly_name: name.clone(),
                    description: String::new(),
                    has_gateway: true,
                    is_up: true,
                    metric: 0,
                    adapter_id: name,
                    gateway: String::new(),
                }
            })
            .collect()
    }

    pub fn wifi_ssid(_adapter_id: &str) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter(if_type: u32, name: &str, description: &str, metric: u32) -> AdapterInfo {
        AdapterInfo {
            if_type,
            friendly_name: name.to_string(),
            description: description.to_string(),
            has_gateway: true,
            is_up: true,
            metric,
            adapter_id: format!("{{{name}}}"),
            gateway: "192.168.1.1".to_string(),
        }
    }

    #[test]
    fn snapshot_tracks_adapter_gateway_and_ssid() {
        let wifi = vec![adapter(IF_TYPE_IEEE80211, "WLAN", "Intel", 1)];
        let home = snapshot_of(&wifi, |_| Some("Home".into())).unwrap();
        assert!(home.wifi);
        assert_eq!(home.ssid.as_deref(), Some("Home"));
        let office = snapshot_of(&wifi, |_| Some("Office".into())).unwrap();
        assert!(!home.same_network(&office));
        // An SSID read that failed once is not a network change.
        let unreadable = snapshot_of(&wifi, |_| None).unwrap();
        assert!(home.same_network(&unreadable));
        let mut moved = wifi.clone();
        moved[0].gateway = "10.0.0.1".into();
        assert!(!unreadable.same_network(&snapshot_of(&moved, |_| None).unwrap()));
        let wired = vec![adapter(IF_TYPE_ETHERNET_CSMACD, "以太网", "Realtek", 1)];
        let ethernet = snapshot_of(&wired, |_| Some("ignored".into())).unwrap();
        assert!(!ethernet.wifi);
        assert_eq!(ethernet.ssid, None);
        assert!(snapshot_of(&[], |_| None).is_none());
    }

    #[test]
    fn picks_the_lowest_metric_real_adapter_and_skips_tun() {
        let adapters = vec![
            adapter(IF_TYPE_PROP_VIRTUAL, "Meta", "Meta Tunnel", 0),
            adapter(
                IF_TYPE_ETHERNET_CSMACD,
                "以太网 2",
                "Wintun Userspace Tunnel",
                1,
            ),
            adapter(IF_TYPE_IEEE80211, "WLAN", "Intel Wi-Fi 6", 35),
            adapter(IF_TYPE_ETHERNET_CSMACD, "以太网", "Realtek PCIe GbE", 25),
        ];
        let primary = pick_primary(&adapters).expect("primary");
        assert_eq!(primary.friendly_name, "以太网");
        assert_eq!(classify(primary), NetworkKind::Ethernet);
    }

    #[test]
    fn ignores_adapters_without_a_gateway_or_down() {
        let mut no_gateway = adapter(IF_TYPE_ETHERNET_CSMACD, "以太网", "Realtek", 1);
        no_gateway.has_gateway = false;
        let mut down = adapter(IF_TYPE_IEEE80211, "WLAN", "Intel", 1);
        down.is_up = false;
        assert!(pick_primary(&[no_gateway, down]).is_none());
    }

    #[test]
    fn labels_match_surge() {
        assert_eq!(NetworkKind::Ethernet.display_name(), "以太网");
        assert_eq!(
            NetworkKind::WiFi(Some("Home-5G".into())).display_name(),
            "Home-5G"
        );
        assert_eq!(NetworkKind::WiFi(None).display_name(), "Wi-Fi");
        assert_eq!(NetworkKind::Cellular.display_name(), "蜂窝网络");
        assert_eq!(NetworkKind::Offline.display_name(), "无网络");
        assert_eq!(
            classify(&adapter(IF_TYPE_WWANPP2, "手机网络", "", 1)),
            NetworkKind::Cellular
        );
    }
}
