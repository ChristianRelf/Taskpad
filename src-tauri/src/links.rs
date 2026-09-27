//! Link previews.
//!
//! The only network Pad ever does. A preview is a title (or bare hostname), the
//! domain, and a small favicon -- no thumbnails, no page scraping beyond `<head>`.
//! Everything fetched is treated as untrusted: bounded reads, bounded strings,
//! and the result is handed to the UI as text, never as markup.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::time::Duration;
use url::Url;

use crate::db::now_ms;
use crate::error::PadError;

const USER_AGENT: &str = "Pad/0.1 (+local link preview)";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_HTML_BYTES: usize = 256 * 1024;
const MAX_ICON_BYTES: usize = 48 * 1024;
const MAX_TITLE_CHARS: usize = 160;
/// Re-fetch a preview at most this often; until then the cached row answers.
const CACHE_TTL_MS: i64 = 14 * 24 * 60 * 60 * 1000;
/// Hard ceiling on cached previews; the oldest are pruned past this.
const CACHE_MAX_ROWS: i64 = 400;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreview {
    pub url: String,
    pub host: String,
    pub title: Option<String>,
    /// `data:` URL for the cached favicon, or `None` when retrieval failed.
    pub icon: Option<String>,
    /// `ok` (title + icon), `partial` (host only), `failed` (nothing reached).
    pub status: String,
}

/// Accept only the shapes we are willing to send a request to.
pub fn validate(raw: &str) -> Result<Url, PadError> {
    if raw.len() > 2048 {
        return Err(PadError::Invalid("link is too long".into()));
    }
    let url = Url::parse(raw).map_err(|e| PadError::Invalid(e.to_string()))?;
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(PadError::Invalid(format!("unsupported scheme: {other}"))),
    }
    let host = url
        .host_str()
        .ok_or_else(|| PadError::Invalid("link has no host".into()))?
        .to_ascii_lowercase();

    // Previews are for the public web. Refusing loopback and private ranges
    // keeps a pasted link from probing whatever is on this machine's network.
    let private = host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host == "0.0.0.0"
        || host.starts_with("127.")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || host.starts_with("169.254.")
        || host == "[::1]"
        || (17..=31).any(|n| host.starts_with(&format!("172.{n}.")));
    if private {
        return Err(PadError::Invalid("local addresses are not previewed".into()));
    }
    Ok(url)
}

pub fn display_host(url: &Url) -> String {
    let h = url.host_str().unwrap_or_default().to_ascii_lowercase();
    h.strip_prefix("www.").unwrap_or(&h).to_string()
}

fn cached(conn: &Connection, url: &str) -> Result<Option<LinkPreview>, PadError> {
    let row: Option<(String, Option<String>, Option<Vec<u8>>, Option<String>, String, i64)> = conn
        .query_row(
            "SELECT host, title, favicon, favicon_mime, status, fetched_at
             FROM link_cache WHERE url = ?1",
            params![url],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .optional()?;

    let Some((host, title, favicon, mime, status, fetched_at)) = row else {
        return Ok(None);
    };
    // A failed lookup is retried sooner than a good one, so a link added while
    // offline fixes itself on the next visit.
    let ttl = if status == "ok" { CACHE_TTL_MS } else { 60 * 60 * 1000 };
    if now_ms() - fetched_at > ttl {
        return Ok(None);
    }
    Ok(Some(LinkPreview {
        url: url.to_string(),
        host,
        title,
        icon: favicon.map(|b| to_data_url(mime.as_deref(), &b)),
        status,
    }))
}

fn to_data_url(mime: Option<&str>, bytes: &[u8]) -> String {
    format!(
        "data:{};base64,{}",
        mime.unwrap_or("image/png"),
        base64(bytes)
    )
}

fn base64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

fn store(
    conn: &Connection,
    url: &str,
    host: &str,
    title: Option<&str>,
    icon: Option<(&str, &[u8])>,
    status: &str,
) -> Result<(), PadError> {
    conn.execute(
        "INSERT INTO link_cache (url, host, title, favicon, favicon_mime, status, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(url) DO UPDATE SET
            host = excluded.host, title = excluded.title, favicon = excluded.favicon,
            favicon_mime = excluded.favicon_mime, status = excluded.status,
            fetched_at = excluded.fetched_at",
        params![
            url,
            host,
            title,
            icon.map(|(_, b)| b),
            icon.map(|(m, _)| m),
            status,
            now_ms()
        ],
    )?;
    conn.execute(
        "DELETE FROM link_cache WHERE url NOT IN (
            SELECT url FROM link_cache ORDER BY fetched_at DESC LIMIT ?1
         )",
        params![CACHE_MAX_ROWS],
    )?;
    Ok(())
}

fn client() -> Result<reqwest::Client, PadError> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| PadError::Network(e.to_string()))
}

/// Read at most `limit` bytes of a response body, so a huge or endless page
/// cannot pin memory.
async fn read_capped(mut resp: reqwest::Response, limit: usize) -> Result<Vec<u8>, PadError> {
    let mut out = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| PadError::Network(e.to_string()))?
    {
        let take = (limit - out.len()).min(chunk.len());
        out.extend_from_slice(&chunk[..take]);
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

/// Extract `<title>` from a `<head>`, decoded and length-capped.
fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let open = lower[start..].find('>')? + start + 1;
    let end = lower[open..].find("</title").map(|i| i + open)?;
    let raw = &html[open..end];
    let text = decode_entities(raw);
    let text = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>();
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(MAX_TITLE_CHARS).collect())
}

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        // `;` is ASCII, so scanning raw bytes cannot land mid-character.
        let Some(semi) = rest.as_bytes().iter().take(12).position(|&b| b == b';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let ent = &rest[1..semi];
        let replacement = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            _ => ent
                .strip_prefix('#')
                .and_then(|n| {
                    n.strip_prefix('x')
                        .or_else(|| n.strip_prefix('X'))
                        .and_then(|h| u32::from_str_radix(h, 16).ok())
                        .or_else(|| n.parse::<u32>().ok())
                })
                .and_then(char::from_u32),
        };
        match replacement {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// First `<link rel="...icon...">` href in the document, if any.
fn extract_icon_href(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0usize;
    while let Some(i) = lower[cursor..].find("<link") {
        let start = cursor + i;
        let end = lower[start..].find('>').map(|e| start + e)?;
        let tag = &html[start..end];
        let tag_lower = &lower[start..end];
        if tag_lower.contains("rel=") && tag_lower.contains("icon") {
            if let Some(href) = attr_value(tag, tag_lower, "href") {
                if !href.is_empty() {
                    return Some(href);
                }
            }
        }
        cursor = end + 1;
    }
    None
}

fn attr_value(tag: &str, tag_lower: &str, name: &str) -> Option<String> {
    let key = format!("{name}=");
    let at = tag_lower.find(&key)? + key.len();
    let rest = tag.get(at..)?;
    let quote = rest.chars().next()?;
    let value = if quote == '"' || quote == '\'' {
        rest[1..].split(quote).next()?
    } else {
        rest.split_whitespace().next()?
    };
    Some(decode_entities(value.trim()))
}

async fn fetch_icon(client: &reqwest::Client, url: &Url) -> Option<(String, Vec<u8>)> {
    let resp = client.get(url.clone()).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or("").trim().to_string())
        .filter(|m| m.starts_with("image/"))
        .unwrap_or_else(|| "image/x-icon".to_string());
    let bytes = read_capped(resp, MAX_ICON_BYTES).await.ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some((mime, bytes))
}

pub async fn preview(
    db: &crate::db::Db,
    raw: &str,
) -> Result<LinkPreview, PadError> {
    let url = validate(raw)?;
    let canonical = url.to_string();
    let host = display_host(&url);

    if let Some(hit) = cached(&db.lock(), &canonical)? {
        return Ok(hit);
    }

    let client = client()?;
    let page = client.get(url.clone()).send().await;

    let mut title = None;
    let mut icon: Option<(String, Vec<u8>)> = None;
    let mut reached = false;

    if let Ok(resp) = page {
        if resp.status().is_success() {
            reached = true;
            let is_html = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(|v| v.contains("html"))
                .unwrap_or(false);
            let final_url = resp.url().clone();
            if is_html {
                if let Ok(body) = read_capped(resp, MAX_HTML_BYTES).await {
                    let html = String::from_utf8_lossy(&body);
                    title = extract_title(&html);
                    if let Some(href) = extract_icon_href(&html) {
                        if let Ok(icon_url) = final_url.join(&href) {
                            if validate(icon_url.as_str()).is_ok() {
                                icon = fetch_icon(&client, &icon_url).await;
                            }
                        }
                    }
                }
            }
        }
    }

    if icon.is_none() {
        if let Ok(fallback) = url.join("/favicon.ico") {
            icon = fetch_icon(&client, &fallback).await;
        }
    }

    let status = if title.is_some() && icon.is_some() {
        "ok"
    } else if reached || icon.is_some() {
        "partial"
    } else {
        "failed"
    };

    {
        let conn = db.lock();
        store(
            &conn,
            &canonical,
            &host,
            title.as_deref(),
            icon.as_ref().map(|(m, b)| (m.as_str(), b.as_slice())),
            status,
        )?;
    }

    Ok(LinkPreview {
        url: canonical,
        host,
        title,
        icon: icon.map(|(m, b)| to_data_url(Some(&m), &b)),
        status: status.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_http_schemes() {
        assert!(validate("file:///etc/passwd").is_err());
        assert!(validate("javascript:alert(1)").is_err());
        assert!(validate("not a url").is_err());
    }

    #[test]
    fn rejects_local_addresses() {
        for u in [
            "http://localhost/x",
            "http://127.0.0.1:8080",
            "http://192.168.1.1",
            "http://10.0.0.5",
            "http://169.254.169.254/latest/meta-data",
            "http://172.17.0.2",
        ] {
            assert!(validate(u).is_err(), "should reject {u}");
        }
    }

    #[test]
    fn accepts_public_links() {
        assert!(validate("https://example.com/a?b=c#d").is_ok());
    }

    #[test]
    fn strips_www_for_display() {
        let u = validate("https://www.Example.com/path").unwrap();
        assert_eq!(display_host(&u), "example.com");
    }

    #[test]
    fn reads_and_decodes_title() {
        let html = "<html><head><TITLE>Docs &amp; Notes &#8212;\n  home</TITLE></head>";
        assert_eq!(
            extract_title(html).as_deref(),
            Some("Docs & Notes \u{2014} home")
        );
    }

    #[test]
    fn title_missing_is_none() {
        assert!(extract_title("<html><head></head></html>").is_none());
        assert!(extract_title("<html><head><title>   </title>").is_none());
    }

    #[test]
    fn finds_icon_href() {
        let html = r#"<link rel="stylesheet" href="a.css"><link rel="shortcut icon" href="/i.png">"#;
        assert_eq!(extract_icon_href(html).as_deref(), Some("/i.png"));
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
