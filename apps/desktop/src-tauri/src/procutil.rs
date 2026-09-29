//! Windows-safe process spawning.
//!
//! The packaged app is a GUI-subsystem binary (`windows_subsystem = "windows"`).
//! `CreateProcess` of a console program (`powershell`, `sc`, `net`, `pnputil`,
//! `nvidia-smi`, `tailscale`, `cmd`) then allocates a new console window for
//! every child. That is the flashing window users see at startup, on the
//! dashboard's refresh, and during diagnostics. `CREATE_NO_WINDOW` (0x08000000)
//! suppresses it. Redirecting stdout does not.
//!
//! Elevation is separate and explicit. Background probes never request it.
//! `run_elevated_wait` is only for an installer the user already asked for
//! (host setup, or the virtual display driver). It uses one hidden PowerShell
//! so the consent dialog can appear, and it does not elevate NodeDesk itself.

use std::ffi::OsStr;
use std::path::Path;
use std::process::Command;

/// Windows `CREATE_NO_WINDOW`.
pub const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Flags applied to background children. Zero off Windows.
pub fn background_creation_flags() -> u32 {
    if cfg!(windows) {
        CREATE_NO_WINDOW
    } else {
        0
    }
}

/// A child process that must not flash a console window.
pub fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new(program);
        cmd.creation_flags(background_creation_flags());
        cmd
    }
    #[cfg(not(windows))]
    {
        // Keep the flag helper live on every platform so a non-Windows build
        // cannot drop it as dead code.
        let _ = background_creation_flags();
        Command::new(program)
    }
}

/// PowerShell single-quoted literal. Newlines are rejected so a path cannot
/// break out of the string we generate.
///
/// Only Windows launches this script. The builder and its tests stay compiled
/// everywhere so a quoting bug is caught on Linux CI too.
#[cfg_attr(not(windows), allow(dead_code))]
fn ps_literal(value: &str) -> Result<String, String> {
    if value.chars().any(|c| c == '\n' || c == '\r' || c == '\0') {
        return Err("refusing to launch a path that contains a line break".into());
    }
    Ok(format!("'{}'", value.replace('\'', "''")))
}

/// Script for one UAC consent prompt (`Start-Process -Verb RunAs -Wait`).
///
/// `hide_installer_window` is for silent installers (`/S`). An interactive
/// installer (the virtual display driver) must stay visible after consent.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn elevated_launch_script(
    program: &Path,
    args: &[&str],
    hide_installer_window: bool,
) -> Result<String, String> {
    let file = ps_literal(&program.to_string_lossy())?;
    let mut script =
        format!("$ErrorActionPreference = 'Stop'; $p = Start-Process -FilePath {file}");
    if !args.is_empty() {
        let quoted = args
            .iter()
            .map(|a| ps_literal(a))
            .collect::<Result<Vec<_>, _>>()?
            .join(",");
        script.push_str(" -ArgumentList ");
        script.push_str(&quoted);
    }
    script.push_str(" -Verb RunAs -Wait -PassThru");
    if hide_installer_window {
        script.push_str(" -WindowStyle Hidden");
    }
    script.push_str("; exit $p.ExitCode");
    Ok(script)
}

/// Runs `program` with a single UAC consent prompt and waits until it exits.
/// The PowerShell helper itself has no window. Cancelling consent is an error
/// string, not a system dialog from NodeDesk.
#[cfg(windows)]
pub fn run_elevated_wait(
    program: &Path,
    args: &[&str],
    hide_installer_window: bool,
) -> Result<(), String> {
    run_elevated_wait_codes(program, args, hide_installer_window, &[])
}

/// Same as `run_elevated_wait`, but treats extra process exit codes as success.
///
/// `msiexec /norestart` returns 3010 when setup finished and a reboot is
/// pending. That is a successful install, not a failed consent prompt.
#[cfg(windows)]
pub fn run_elevated_wait_codes(
    program: &Path,
    args: &[&str],
    hide_installer_window: bool,
    extra_success: &[i32],
) -> Result<(), String> {
    if !program.is_file() {
        return Err("the installer file is missing, so setup did not start".into());
    }
    let script = elevated_launch_script(program, args, hide_installer_window)?;
    // `-ExecutionPolicy Bypass` applies only to this process. It stops Windows
    // from opening an execution-policy dialog for the one-shot helper. It does
    // not change the machine policy or the remote terminal.
    let out = hidden_command("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .output()
        .map_err(|e| format!("could not ask Windows to start setup: {e}"))?;
    let code = out.status.code();
    if code == Some(0) || code.is_some_and(|c| extra_success.contains(&c)) {
        return Ok(());
    }
    let detail = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if detail.to_lowercase().contains("cancel") {
        Err("Windows approval was declined, so setup stopped.".into())
    } else {
        Err("Windows did not finish the approved setup step.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn background_probes_request_no_console_window() {
        assert_eq!(CREATE_NO_WINDOW, 0x08000000);
        if cfg!(windows) {
            assert_eq!(background_creation_flags(), CREATE_NO_WINDOW);
        } else {
            assert_eq!(background_creation_flags(), 0);
        }
    }

    #[test]
    fn hidden_command_runs() {
        let mut cmd = hidden_command(if cfg!(windows) { "cmd" } else { "true" });
        if cfg!(windows) {
            cmd.args(["/C", "exit", "0"]);
        }
        let out = cmd.output().expect("spawn");
        assert!(out.status.success());
    }

    #[test]
    fn elevated_script_quotes_and_stays_a_single_consent() {
        let script =
            elevated_launch_script(Path::new(r"C:\Temp\node's setup.exe"), &["/S"], true).unwrap();
        assert!(script.contains("Verb RunAs"));
        assert!(script.contains("-WindowStyle Hidden"));
        assert!(script.contains(r"'C:\Temp\node''s setup.exe'"));
        assert!(script.contains("'/S'"));
        // The helper must not chain a second shell.
        assert!(!script.to_lowercase().contains("cmd.exe"));
        assert_eq!(script.matches("Verb RunAs").count(), 1);
    }

    #[test]
    fn interactive_installer_keeps_its_window() {
        let script =
            elevated_launch_script(Path::new(r"C:\Temp\vdd-setup.exe"), &[], false).unwrap();
        assert!(script.contains("Verb RunAs"));
        assert!(!script.contains("WindowStyle"));
        assert!(!script.contains("ArgumentList"));
    }

    #[test]
    fn elevated_script_rejects_a_path_that_breaks_the_string() {
        let path = PathBuf::from("C:\\Temp\\bad\nsetup.exe");
        assert!(elevated_launch_script(&path, &[], true).is_err());
    }

    #[test]
    fn raw_process_spawns_stay_inside_this_module() {
        // Reproduction: a GUI build that calls Command::new("sc") / powershell /
        // nvidia-smi / tailscale flashes a console on every call. Every spawn
        // has to go through hidden_command so the flag cannot be forgotten.
        let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        let mut files = Vec::new();
        collect_rs(&src, &mut files);
        for path in files {
            if path.file_name().and_then(|n| n.to_str()) == Some("procutil.rs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            if text.contains("Command::new") {
                offenders.push(path.display().to_string());
            }
        }
        assert!(
            offenders.is_empty(),
            "use procutil::hidden_command so Windows does not flash a console: {offenders:?}"
        );
    }

    fn collect_rs(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_rs(&path, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                out.push(path);
            }
        }
    }
}
