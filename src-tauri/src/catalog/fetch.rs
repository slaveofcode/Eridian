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

#[cfg(test)]
mod tests {
    use super::*;

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
