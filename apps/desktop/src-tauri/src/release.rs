//! Shared guards for fetching upstream release artifacts.
//!
//! NodeDesk downloads and then *executes* third-party installers, including a
//! kernel-mode display driver. HTTPS protects the connection, not the choice
//! of artifact: the download URL comes out of a JSON response, and a redirect
//! or a tampered field could point it anywhere. Two things are checked before
//! anything is written or run — that the asset really comes from the expected
//! GitHub repository, and that its name is a plain filename.

/// Confirms a release asset URL belongs to `owner/repo` on GitHub.
///
/// GitHub serves release assets from `github.com` and `objects.githubusercontent.com`;
/// anything else means the response was not what we expected.
pub fn verify_asset_url(url: &str, owner: &str, repo: &str) -> Result<(), String> {
    let expected = format!("https://github.com/{owner}/{repo}/releases/download/");
    if url.starts_with(&expected) {
        return Ok(());
    }
    Err(format!(
        "refusing to download {url}: not an official {owner}/{repo} release asset"
    ))
}

/// Confirms an asset name is a bare filename, safe to join onto a directory.
///
/// The name is attacker-influenced input used to build a local path; a value
/// containing separators or `..` would write outside the intended folder.
///
/// Only the Windows virtual-display installer currently derives a local path
/// from a remote name, so on other platforms this has no call site — but the
/// rule belongs with the other release guards, and its tests run everywhere.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn safe_asset_name(name: &str) -> Result<&str, String> {
    let bad = name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains(':')
        || name.contains('\0');
    if bad {
        return Err(format!("refusing to use unsafe asset name: {name}"));
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_genuine_release_asset() {
        assert!(verify_asset_url(
            "https://github.com/LizardByte/Sunshine/releases/download/v0.23.1/sunshine-windows-installer.exe",
            "LizardByte",
            "Sunshine"
        )
        .is_ok());
    }

    #[test]
    fn rejects_a_foreign_host() {
        assert!(verify_asset_url(
            "https://evil.example.com/sunshine-windows-installer.exe",
            "LizardByte",
            "Sunshine"
        )
        .is_err());
    }

    #[test]
    fn rejects_another_repository() {
        assert!(verify_asset_url(
            "https://github.com/attacker/Sunshine/releases/download/v1/setup.exe",
            "LizardByte",
            "Sunshine"
        )
        .is_err());
    }

    #[test]
    fn rejects_a_lookalike_host_prefix() {
        assert!(verify_asset_url(
            "https://github.com.evil.example/LizardByte/Sunshine/releases/download/v1/x.exe",
            "LizardByte",
            "Sunshine"
        )
        .is_err());
    }

    #[test]
    fn rejects_plain_http() {
        assert!(verify_asset_url(
            "http://github.com/LizardByte/Sunshine/releases/download/v1/x.exe",
            "LizardByte",
            "Sunshine"
        )
        .is_err());
    }

    #[test]
    fn accepts_a_plain_filename() {
        assert!(safe_asset_name("VDD-Setup-1.2.3.exe").is_ok());
    }

    #[test]
    fn rejects_names_that_escape_the_directory() {
        assert!(safe_asset_name("../../evil.exe").is_err());
        assert!(safe_asset_name("sub/dir/evil.exe").is_err());
        assert!(safe_asset_name(r"..\..\evil.exe").is_err());
        assert!(safe_asset_name("C:/Windows/System32/evil.exe").is_err());
        assert!(safe_asset_name("").is_err());
    }
}
