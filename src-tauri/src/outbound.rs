//! Outbound HTTP routes shared by the app's own requests.
//!
//! reqwest picks up proxies on its own: `HTTP(S)_PROXY`/`ALL_PROXY`, and on
//! Windows the system proxy in the registry (hyper-util's
//! `client-proxy-system` is on for the whole build through the updater's
//! reqwest 0.13). While our own system proxy is on that silently routes
//! every "direct" request into mihomo's mixed-port. Every client here picks
//! its route explicitly instead.

use crate::subscription::ProxyUrlSource;
use std::sync::OnceLock;

static LIVE_PROXY: OnceLock<ProxyUrlSource> = OnceLock::new();

/// Wire the running core's live mixed-port (set once at app setup).
pub fn attach_live_proxy(source: ProxyUrlSource) {
    let _ = LIVE_PROXY.set(source);
}

/// `http://127.0.0.1:<mixed-port>` while a core is serving, else `None`.
pub async fn live_proxy_url() -> Option<String> {
    match LIVE_PROXY.get() {
        Some(source) => source().await,
        None => None,
    }
}

/// A builder that never uses any proxy: for services on this machine (the
/// mihomo controller, the local Sub-Store backend) and for the "direct"
/// attempt of a direct-then-proxy fetch.
pub fn direct_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().no_proxy()
}

/// A builder that sends everything (http and https) through `proxy_url`.
pub fn proxied_builder(proxy_url: &str) -> Option<reqwest::ClientBuilder> {
    reqwest::Proxy::all(proxy_url)
        .ok()
        .map(|proxy| reqwest::Client::builder().proxy(proxy))
}
