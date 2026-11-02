//! Makes the downloaded Sub-Store frontend blend into Murge's content panel
//! when it is embedded in the Sub-Store page.
//!
//! The patch only takes effect inside an iframe (a tiny inline script adds the
//! `murge-embed` class), so opening Sub-Store in a real browser keeps its own
//! look. Embedded, the page background turns transparent so the frosted panel
//! shows through, the top bar uses Murge's panel tint, and scrollbars
//! are hidden.
//!
//! Sub-Store is a PWA: its service worker serves `index.html` from the
//! precache. Patching the file alone would be invisible to anyone whose
//! WebView already installed the worker, so the precache revision of
//! `index.html` in `sw.js` is bumped too; the changed `sw.js` makes the
//! browser install the new worker (it calls skipWaiting), which re-fetches
//! the patched `index.html`.

use std::path::Path;

/// Bump when the injected block changes, so already patched installs are
/// rewritten and the service worker refreshes its cached index.html.
const PATCH_VERSION: &str = "murge-embed-v2";
const BLOCK_START: &str = "<!-- murge-embed:start -->";
const BLOCK_END: &str = "<!-- murge-embed:end -->";

fn embed_block() -> String {
    format!(
        "{BLOCK_START}<meta name=\"murge-embed\" content=\"{PATCH_VERSION}\">\
<script>(function(){{var e;try{{e=window.top!==window.self}}catch(_){{e=true}}if(e)document.documentElement.classList.add('murge-embed')}})()</script>\
<style>\
html.murge-embed{{color-scheme:light dark;scrollbar-width:none;--nav-bar-color:rgba(251,252,254,.72)!important}}\
html.murge-embed *{{scrollbar-width:none}}\
html.murge-embed::-webkit-scrollbar,html.murge-embed *::-webkit-scrollbar{{display:none;width:0;height:0}}\
@media (prefers-color-scheme: dark){{html.murge-embed{{--nav-bar-color:rgba(32,35,44,.72)!important}}}}\
html.murge-embed,html.murge-embed body,html.murge-embed #app{{background:transparent!important}}\
</style>{BLOCK_END}"
    )
}

/// Returns the patched index.html, or None when it is already current.
pub fn patch_index_html(html: &str) -> Option<String> {
    let block = embed_block();
    if html.contains(&block) {
        return None;
    }
    // Drop an older version of the block before inserting the current one.
    let mut base = html.to_string();
    if let (Some(start), Some(end)) = (base.find(BLOCK_START), base.find(BLOCK_END)) {
        if end > start {
            base.replace_range(start..end + BLOCK_END.len(), "");
        }
    }
    let at = base.find("</head>")?;
    base.insert_str(at, &block);
    Some(base)
}

/// Returns sw.js with index.html's precache revision tied to the patch
/// version, or None when it already is (or the entry is not found).
pub fn patch_service_worker(sw: &str) -> Option<String> {
    let re = regex::Regex::new(r#"\{url:"index\.html",revision:"([^"]*)"\}"#).ok()?;
    let caps = re.captures(sw)?;
    let current = caps.get(1)?.as_str();
    let original = current.split("+murge-embed").next().unwrap_or(current);
    let wanted = format!("{original}+{PATCH_VERSION}");
    if current == wanted {
        return None;
    }
    let range = caps.get(1)?.range();
    let mut out = sw.to_string();
    out.replace_range(range, &wanted);
    Some(out)
}

/// Best-effort: a failure leaves Sub-Store working with its stock look.
pub async fn apply(frontend_dir: &Path) -> Result<(), String> {
    let index = frontend_dir.join("index.html");
    let html = tokio::fs::read_to_string(&index)
        .await
        .map_err(|error| error.to_string())?;
    if let Some(patched) = patch_index_html(&html) {
        tokio::fs::write(&index, patched)
            .await
            .map_err(|error| error.to_string())?;
    }
    let sw_path = frontend_dir.join("sw.js");
    if let Ok(sw) = tokio::fs::read_to_string(&sw_path).await {
        if let Some(patched) = patch_service_worker(&sw) {
            tokio::fs::write(&sw_path, patched)
                .await
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HTML: &str = "<html><head><title>Sub Store</title></head><body></body></html>";

    #[test]
    fn injects_once_before_head_end() {
        let patched = patch_index_html(HTML).expect("patched");
        assert!(patched.contains("murge-embed"));
        assert!(patched.find(BLOCK_END).unwrap() < patched.find("</head>").unwrap());
        assert_eq!(patch_index_html(&patched), None);
    }

    #[test]
    fn replaces_an_older_block() {
        let old = HTML.replace(
            "</head>",
            &format!("{BLOCK_START}<style>old</style>{BLOCK_END}</head>"),
        );
        let patched = patch_index_html(&old).expect("patched");
        assert!(!patched.contains("<style>old</style>"));
        assert_eq!(patched.matches(BLOCK_START).count(), 1);
    }

    #[test]
    fn leaves_html_without_head_alone() {
        assert_eq!(patch_index_html("<body></body>"), None);
    }

    #[test]
    fn bumps_index_revision_once() {
        let sw = r#"[{url:"index.js",revision:"aa"},{url:"index.html",revision:"c9aa"},{url:"x",revision:"1"}]"#;
        let patched = patch_service_worker(sw).expect("patched");
        assert!(patched.contains(r#"{url:"index.html",revision:"c9aa+murge-embed-v2"}"#));
        assert!(patched.contains(r#"{url:"index.js",revision:"aa"}"#));
        assert_eq!(patch_service_worker(&patched), None);
        let older = sw.replace("c9aa", "c9aa+murge-embed-v0");
        assert!(patch_service_worker(&older)
            .unwrap()
            .contains("c9aa+murge-embed-v2"));
    }

    #[test]
    fn ignores_unknown_service_worker() {
        assert_eq!(patch_service_worker("self.skipWaiting()"), None);
    }
}
