use super::archive::{Result, MAX_ARCHIVE};
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Deserialize)]
pub struct Target {
    url: String,
    username: String,
    password: String,
}

pub fn validate(value: &Value) -> Result<Target> {
    let mut target: Target =
        serde_json::from_value(value.clone()).map_err(|_| "WebDAV 参数无效")?;
    if target.url.encode_utf16().count() > 2048
        || target.username.encode_utf16().count() > 256
        || target.password.encode_utf16().count() > 1024
    {
        return Err("WebDAV 参数无效".into());
    }
    let url = url::Url::parse(&target.url).map_err(|_| "请输入有效的 WebDAV 文件地址")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().to_lowercase().ends_with(".murge-backup")
    {
        return Err(
            "WebDAV 地址须为 HTTPS 且指向 .murge-backup 文件，不能包含账号、查询参数或片段".into(),
        );
    }
    if !target.password.is_empty() && target.username.is_empty() {
        return Err("请填写 WebDAV 用户名".into());
    }
    target.url = url.into();
    Ok(target)
}

fn status(code: u16, expected: &[u16]) -> Result<()> {
    if expected.contains(&code) {
        return Ok(());
    }
    Err(match code {
        401 | 403 => "WebDAV 认证失败或没有权限".into(),
        404 => "WebDAV 备份文件不存在".into(),
        300..=399 => "WebDAV 服务要求重定向，请填写最终 HTTPS 文件地址".into(),
        _ => format!("WebDAV 请求失败（HTTP {code}）"),
    })
}

async fn request(target: Target, body: Option<Vec<u8>>) -> Result<reqwest::Response> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "WebDAV 网络连接失败或超时")?;
    let mut request = if let Some(bytes) = body {
        if bytes.len() > MAX_ARCHIVE {
            return Err("备份文件超过上限".into());
        }
        client
            .put(&target.url)
            .header("Content-Type", "application/octet-stream")
            .body(bytes)
    } else {
        client.get(&target.url)
    }
    .header("Cache-Control", "no-store");
    if !target.username.is_empty() {
        request = request.basic_auth(target.username, Some(target.password));
    }
    // Never stringify reqwest errors: they can contain the complete URL.
    request
        .send()
        .await
        .map_err(|_| "WebDAV 网络连接失败或超时".into())
}

pub async fn upload(target: &Value, archive: Vec<u8>) -> Result<()> {
    let response = request(validate(target)?, Some(archive)).await?;
    status(response.status().as_u16(), &[200, 201, 204])
}

pub async fn download(target: &Value) -> Result<Vec<u8>> {
    let mut response = request(validate(target)?, None).await?;
    status(response.status().as_u16(), &[200])?;
    if response
        .content_length()
        .is_some_and(|size| size > MAX_ARCHIVE as u64)
    {
        return Err("WebDAV 备份文件超过上限".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "WebDAV 网络连接失败或超时")?
    {
        if bytes.len() + chunk.len() > MAX_ARCHIVE {
            return Err("WebDAV 备份文件超过上限".into());
        }
        bytes.extend(chunk);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn target_validation_rejects_redirectable_or_credential_urls() {
        for url in [
            "http://example.com/a.murge-backup",
            "https://u:p@example.com/a.murge-backup",
            "https://example.com/a.murge-backup?token=secret",
            "https://example.com/a.murge-backup#x",
            "https://example.com/a.zip",
        ] {
            assert!(validate(&json!({"url":url,"username":"","password":""})).is_err());
        }
        assert!(validate(
            &json!({"url":"https://example.com/a.murge-backup","username":"","password":"secret"})
        )
        .is_err());
        assert!(validate(
            &json!({"url":"https://example.com/a.murge-backup","username":"u","password":"secret"})
        )
        .is_ok());
    }
    #[test]
    fn maps_auth_missing_redirect_and_http_errors() {
        assert!(status(204, &[200, 201, 204]).is_ok());
        assert!(status(401, &[200]).unwrap_err().contains("认证"));
        assert!(status(404, &[200]).unwrap_err().contains("不存在"));
        assert!(status(302, &[200]).unwrap_err().contains("重定向"));
        assert_eq!(
            status(500, &[200]).unwrap_err(),
            "WebDAV 请求失败（HTTP 500）"
        );
    }
    #[tokio::test]
    async fn upload_and_preview_validate_in_rust_before_network_access() {
        assert!(upload(&Value::Null, vec![]).await.is_err());
        assert!(download(&Value::Null).await.is_err());
    }
}
