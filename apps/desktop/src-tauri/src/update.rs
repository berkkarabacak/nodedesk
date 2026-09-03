//! Update checking against GitHub releases. v1 notifies and links to the
//! release page; in-place auto-update ships in a later release.

use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub update_available: bool,
    pub url: String,
}

pub fn version_newer(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u32> {
        v.trim_start_matches('v')
            .split('.')
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    };
    parse(latest) > parse(current)
}

pub async fn check(client: &reqwest::Client, current: &str) -> Result<UpdateInfo, String> {
    let release: GithubRelease = client
        .get("https://api.github.com/repos/berkkarabacak/nodedesk/releases/latest")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(UpdateInfo {
        current: current.to_string(),
        latest: release.tag_name.clone(),
        update_available: version_newer(&release.tag_name, current),
        url: release.html_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_compare() {
        assert!(version_newer("v1.0.1", "1.0.0"));
        assert!(version_newer("v2.0.0", "1.9.9"));
        assert!(version_newer("1.0.1", "v1.0.0"));
        assert!(!version_newer("v1.0.0", "1.0.0"));
        assert!(!version_newer("v0.9.0", "1.0.0"));
        assert!(!version_newer("v1.0", "1.0.1"));
    }
}
