//! Live compatibility checks against real community modules and scripts
//! (BoxJs, Script Hub, YouTube Enhance). They need the network, so they only
//! run with `MURGE_LIVE_SCRIPTS=<dir with the downloaded .js files>`:
//!
//! ```text
//! MURGE_LIVE_SCRIPTS=/tmp/scripts cargo test --lib mitm::script_live -- --nocapture
//! ```

use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::script::*;

fn live_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("MURGE_LIVE_SCRIPTS").map(Into::into)
}

/// `$httpClient` over plain reqwest (honours HTTPS_PROXY / SSL_CERT_FILE).
fn net_fetcher() -> Fetcher {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5));
    if let Ok(path) = std::env::var("SSL_CERT_FILE") {
        if let Ok(pem) = std::fs::read(path) {
            for cert in reqwest::Certificate::from_pem_bundle(&pem).unwrap_or_default() {
                builder = builder.add_root_certificate(cert);
            }
        }
    }
    let client = builder.build().unwrap();
    Arc::new(move |call: HttpCall| {
        let client = client.clone();
        Box::pin(async move {
            let method =
                reqwest::Method::from_bytes(call.method.as_bytes()).map_err(|e| e.to_string())?;
            let mut request = client.request(method, &call.url);
            for (name, value) in &call.headers {
                request = request.header(name, value);
            }
            if let Some(body) = call.body {
                request = request.body(body);
            }
            let response = request.send().await.map_err(|e| e.to_string())?;
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_string())))
                .collect();
            let body = response.bytes().await.map_err(|e| e.to_string())?.to_vec();
            Ok(HttpReply {
                status,
                headers,
                body,
            })
        })
    })
}

fn host() -> ScriptHost {
    ScriptHost {
        store: Arc::new(PersistentStore::default()),
        fetcher: net_fetcher(),
        notifier: Arc::new(Mutex::new(None)),
    }
}

fn code(dir: &std::path::Path, name: &str) -> Arc<str> {
    Arc::from(std::fs::read_to_string(dir.join(name)).unwrap())
}

fn request(url: &str, kind: ScriptKind, name: &str, code: Arc<str>) -> ScriptCall {
    ScriptCall {
        name: name.into(),
        code,
        kind,
        argument: String::new(),
        timeout: Duration::from_secs(120),
        binary: false,
        qx: false,
        request: HttpMessage {
            url: url.into(),
            method: "GET".into(),
            status: 0,
            headers: vec![
                (
                    "Host".into(),
                    url::Url::parse(url).unwrap().host_str().unwrap().into(),
                ),
                (
                    "Accept".into(),
                    "text/html,application/xhtml+xml,*/*".into(),
                ),
                (
                    "User-Agent".into(),
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)".into(),
                ),
            ],
            body: None,
        },
        response: None,
    }
}

fn answer(report: &ScriptReport) -> (u16, String) {
    let ScriptOutcome::Done(done) = &report.outcome else {
        panic!("{:?}\n{}", report.outcome, report.logs.join("\n"));
    };
    let response = done.response.as_ref().unwrap_or_else(|| panic!("{done:?}"));
    (
        response.status.unwrap_or(200),
        String::from_utf8_lossy(response.body.as_deref().unwrap_or_default()).into_owned(),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn boxjs_serves_its_page() {
    let Some(dir) = live_dir() else { return };
    let report = run(
        host(),
        request(
            "http://boxjs.com/",
            ScriptKind::Request,
            "BoxJs",
            code(&dir, "chavy.boxjs.js"),
        ),
    )
    .await;
    let (status, body) = answer(&report);
    println!(
        "BoxJs: {status} {} bytes in {:?}\n{}",
        body.len(),
        report.elapsed,
        report.logs.join("\n")
    );
    assert_eq!(status, 200);
    assert!(
        body.contains("<html") || body.contains("<!DOCTYPE"),
        "{}",
        &body[..body.len().min(400)]
    );

    // The API BoxJs' own page calls.
    let report = run(
        host(),
        request(
            "http://boxjs.com/query/boxdata",
            ScriptKind::Request,
            "BoxJs",
            code(&dir, "chavy.boxjs.js"),
        ),
    )
    .await;
    let (status, body) = answer(&report);
    println!("boxdata: {status} {}", &body[..body.len().min(300)]);
    assert!(
        body.contains("\"usercfgs\"") || body.contains("\"sysapps\""),
        "{body}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn script_hub_front_page_and_conversion() {
    let Some(dir) = live_dir() else { return };
    let report = run(
        host(),
        request(
            "http://script.hub/",
            ScriptKind::Request,
            "Script Hub: 前端",
            code(&dir, "script-hub.js"),
        ),
    )
    .await;
    let (status, body) = answer(&report);
    println!(
        "Script Hub: {status} {} bytes in {:?}",
        body.len(),
        report.elapsed
    );
    assert_eq!(status, 200);
    assert!(
        body.contains("Script Hub"),
        "{}",
        &body[..body.len().min(400)]
    );

    let url = "http://script.hub/file/_start_/https://raw.githubusercontent.com/chavyleung/scripts/master/box/rewrite/boxjs.rewrite.surge.sgmodule/_end_/boxjs.plugin?type=surge-module&target=loon-plugin";
    let report = run(
        host(),
        request(
            url,
            ScriptKind::Request,
            "Script Hub: 重写转换",
            code(&dir, "Rewrite-Parser.js"),
        ),
    )
    .await;
    let (status, body) = answer(&report);
    println!(
        "conversion: {status} in {:?}\n{body}\n{}",
        report.elapsed,
        report.logs.join("\n")
    );
    assert_eq!(status, 200);
    assert!(body.contains("boxjs.com"), "{body}");
}

#[tokio::test(flavor = "multi_thread")]
async fn youtube_scripts_load_and_pass_unknown_bodies() {
    let Some(dir) = live_dir() else { return };
    for (name, kind) in [
        ("response.js", ScriptKind::Response),
        ("ump.js", ScriptKind::Response),
        ("request.js", ScriptKind::Request),
        ("key.js", ScriptKind::Response),
    ] {
        let mut call = request(
            "https://youtubei.googleapis.com/youtubei/v1/browse?prettyPrint=false",
            kind,
            name,
            code(&dir, name),
        );
        call.binary = true;
        call.argument = r#"{"blockUpload":true,"blockShorts":false,"blockGames":true,"blockVerticalLive":false,"jumpAhead":true,"autoHd":true,"blockStore":true,"blockAi":true,"onTheGo":true}"#.into();
        call.request.method = "POST".into();
        call.request.body = Some(Vec::new());
        if kind == ScriptKind::Response {
            call.response = Some(HttpMessage {
                status: 200,
                headers: vec![("Content-Type".into(), "application/x-protobuf".into())],
                body: Some(vec![0x0a, 0x00]),
                ..Default::default()
            });
        }
        let report = run(host(), call).await;
        println!(
            "{name}: {:?} in {:?}\n{}",
            report.outcome,
            report.elapsed,
            report.logs.join("\n")
        );
        assert!(
            !matches!(report.outcome, ScriptOutcome::Failed(_)),
            "{name}"
        );
    }
}
