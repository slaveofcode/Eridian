//! The single choke-point for catalog network access: GET-only, https-only, and
//! restricted to a compiled-in host allowlist. Every remote catalog read goes
//! through `fetch_allowlisted`; there is no other outbound path in this module.

use anyhow::{ensure, Context, Result};

/// The ONLY hosts Eridian may fetch catalog data from. GET-only, https-only.
pub const ALLOWLIST: &[&str] = &[
    "registry.modelcontextprotocol.io",
    "api.github.com",
    "raw.githubusercontent.com",
];

/// Validate a catalog URL: must be https and land on an allowlisted host.
/// Pure — used both before a fetch and (via the redirect policy) per hop.
pub fn check_url(url: &str) -> Result<reqwest::Url> {
    let parsed = reqwest::Url::parse(url).with_context(|| format!("bad catalog url: {url}"))?;
    ensure!(parsed.scheme() == "https", "catalog fetch must be https");
    let host = parsed.host_str().unwrap_or_default();
    ensure!(ALLOWLIST.contains(&host), "host not allowlisted: {host}");
    Ok(parsed)
}

/// GET a catalog document. No cookies, no auth, generic UA; redirects must stay
/// on the allowlist (checked per hop by the custom policy).
pub async fn fetch_allowlisted(url: &str) -> Result<String> {
    let parsed = check_url(url)?;
    let client = reqwest::Client::builder()
        .user_agent("eridian-catalog")
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let on_list = attempt.url().scheme() == "https"
                && attempt
                    .url()
                    .host_str()
                    .is_some_and(|h| ALLOWLIST.contains(&h));
            if on_list && attempt.previous().len() < 5 {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()?;
    let resp = client.get(parsed).send().await?.error_for_status()?;
    Ok(resp.text().await?)
}

// ── local cache (app-data only; never touches agent dirs) ───────────────────

/// How long a cached catalog document is considered fresh.
const CACHE_TTL_HOURS: i64 = 24;

/// A cached catalog document plus when it was fetched (RFC3339 UTC).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct CacheEntry {
    pub fetched_at: String,
    pub body: String,
}

/// The catalog cache directory (`<app-data>/market_cache`). `None` for in-memory
/// stores (tests use an explicit dir instead).
pub fn cache_dir(store: &crate::store::Store) -> Option<std::path::PathBuf> {
    store.app_data_dir().map(|d| d.join("market_cache"))
}

/// Read a cache entry by key. Tolerant: any error (missing/corrupt) → `None`.
pub fn read_cache(dir: &std::path::Path, key: &str) -> Option<CacheEntry> {
    let raw = std::fs::read_to_string(dir.join(format!("{key}.json"))).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Write a cache entry by key, stamping `now`. Creates the dir if needed.
pub fn write_cache(
    dir: &std::path::Path,
    key: &str,
    body: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("create cache dir {}", dir.display()))?;
    let entry = CacheEntry {
        fetched_at: now.to_rfc3339(),
        body: body.to_string(),
    };
    let path = dir.join(format!("{key}.json"));
    std::fs::write(&path, serde_json::to_string(&entry)?)
        .with_context(|| format!("write cache {}", path.display()))?;
    Ok(())
}

/// Whether a cache entry is still within the TTL. Unparseable stamp → not fresh
/// (forces a re-fetch rather than trusting a bad timestamp).
pub fn is_fresh(entry: &CacheEntry, now: chrono::DateTime<chrono::Utc>) -> bool {
    match chrono::DateTime::parse_from_rfc3339(&entry.fetched_at) {
        Ok(t) => now.signed_duration_since(t.with_timezone(&chrono::Utc))
            < chrono::Duration::hours(CACHE_TTL_HOURS),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_roundtrip_and_ttl() {
        use chrono::{Duration, Utc};
        let dir = std::env::temp_dir().join(format!("eridian-cache-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let t0 = Utc::now();
        write_cache(&dir, "mcp-registry", "{\"servers\":[]}", t0).unwrap();
        let e = read_cache(&dir, "mcp-registry").unwrap();
        assert_eq!(e.body, "{\"servers\":[]}");
        assert!(is_fresh(&e, t0 + Duration::hours(23)));
        assert!(!is_fresh(&e, t0 + Duration::hours(25)));
        assert!(read_cache(&dir, "missing").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn check_url_enforces_https_and_allowlist() {
        assert!(check_url("https://registry.modelcontextprotocol.io/v0/servers").is_ok());
        assert!(check_url("https://api.github.com/repos/anthropics/skills/git/trees/main").is_ok());
        assert!(
            check_url("https://raw.githubusercontent.com/anthropics/skills/main/x/SKILL.md").is_ok()
        );
        assert!(check_url("http://registry.modelcontextprotocol.io/x").is_err()); // not https
        assert!(check_url("https://evil.example.com/x").is_err()); // off-list host
        assert!(check_url("https://registry.modelcontextprotocol.io.evil.com/x").is_err()); // suffix trick
        assert!(check_url("not a url").is_err());
    }

    #[tokio::test]
    #[ignore] // network; run: cargo test fetch_live -- --ignored
    async fn fetch_live_registry_responds() {
        let body =
            fetch_allowlisted("https://registry.modelcontextprotocol.io/v0/servers?limit=1")
                .await
                .unwrap();
        assert!(body.contains("servers"));
    }
}
