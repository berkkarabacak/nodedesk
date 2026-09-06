//! Headless support: machines without monitors get a virtual display so the
//! Sunshine host always has something to capture.
//!
//! Windows uses the community Virtual Display Driver (VDD). Driver
//! installation is security-sensitive: it always goes through a UAC consent
//! prompt (Start-Process -Verb RunAs) — never silent.
//!
//! Linux: Sunshine supports headless capture via its own docs (X11/Wayland
//! specifics); automated driver management lands in a later release.

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessStatus {
    pub supported: bool,
    pub vdd_installed: bool,
    pub display_count: u32,
}

/// Number of currently attached/active displays (best effort).
pub fn display_count() -> u32 {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens.Count",
            ])
            .output();
        if let Ok(o) = out {
            return String::from_utf8_lossy(&o.stdout).trim().parse().unwrap_or(1);
        }
        1
    }
    #[cfg(not(windows))]
    {
        1
    }
}

#[cfg(windows)]
pub fn vdd_installed() -> bool {
    // Common install markers used by the Virtual Display Driver project.
    let markers = [
        r"C:\VirtualDisplayDriver",
        r"C:\IddSampleDriver",
    ];
    let marker_hit = markers.iter().any(|m| std::path::Path::new(m).exists());
    if marker_hit {
        return true;
    }
    // Fallback: ask the driver store.
    std::process::Command::new("pnputil")
        .args(["/enum-drivers"])
        .output()
        .map(|o| {
            let text = String::from_utf8_lossy(&o.stdout).to_lowercase();
            text.contains("virtualdisplaydriver") || text.contains("iddsampledriver") || text.contains("virtual display")
        })
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn vdd_installed() -> bool {
    false
}

pub fn status() -> HeadlessStatus {
    HeadlessStatus {
        supported: cfg!(windows),
        vdd_installed: vdd_installed(),
        display_count: display_count(),
    }
}

/// Downloads and launches the VDD installer with UAC elevation. Returns after
/// the installer exits; success is verified by re-checking the driver store.
#[cfg(windows)]
pub async fn install_vdd(client: &reqwest::Client) -> Result<(), String> {
    #[derive(serde::Deserialize)]
    struct Release {
        assets: Vec<Asset>,
    }
    #[derive(serde::Deserialize)]
    struct Asset {
        name: String,
        browser_download_url: String,
    }

    let release: Release = client
        .get("https://api.github.com/repos/itsmikethetech/Virtual-Display-Driver/releases/latest")
        .send()
        .await
        .map_err(|e| format!("cannot reach GitHub: {e}"))?
        .json()
        .await
        .map_err(|e| format!("cannot parse VDD release info: {e}"))?;

    // Prefer a setup/installer executable; fall back to the driver zip.
    let exe_asset = release.assets.iter().find(|a| {
        let n = a.name.to_lowercase();
        n.ends_with(".exe") && (n.contains("setup") || n.contains("install"))
    });
    let zip_asset = release
        .assets
        .iter()
        .find(|a| a.name.to_lowercase().ends_with(".zip"));

    if let Some(asset) = exe_asset {
        // This installer is run elevated and loads a kernel-mode driver.
        // Verify its origin, and never let a remote name shape the path.
        crate::release::verify_asset_url(
            &asset.browser_download_url,
            "itsmikethetech",
            "Virtual-Display-Driver",
        )?;
        let name = crate::release::safe_asset_name(&asset.name)?;
        let installer = std::env::temp_dir().join(name);
        let bytes = client
            .get(&asset.browser_download_url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .bytes()
            .await
            .map_err(|e| e.to_string())?;
        std::fs::write(&installer, &bytes).map_err(|e| e.to_string())?;

        // UAC prompt appears here — explicit user consent for a driver.
        let status = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Start-Process -FilePath '{}' -Verb RunAs -Wait",
                    installer.to_string_lossy().replace('\'', "''")
                ),
            ])
            .status()
            .map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&installer);
        if !status.success() {
            return Err("installer was cancelled or failed".into());
        }
    } else if zip_asset.is_some() {
        return Err(
            "This VDD release needs manual setup — download it from the link in docs/development.md and run its installer"
                .into(),
        );
    } else {
        return Err("no usable installer found in the latest VDD release".into());
    }

    if vdd_installed() {
        Ok(())
    } else {
        Err("installer finished but the driver was not detected — a reboot may be required".into())
    }
}

#[cfg(not(windows))]
pub async fn install_vdd(_client: &reqwest::Client) -> Result<(), String> {
    Err("Automated virtual-display setup is Windows-only in this release".into())
}
