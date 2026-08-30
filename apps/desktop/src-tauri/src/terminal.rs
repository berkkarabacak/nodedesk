//! Remote terminal: executes a command on a paired host and returns output.
//!
//! Security note: this is intentionally powerful (it is a remote shell).
//! Every request requires the host's access code. 30 s execution cap.

use serde::{Deserialize, Serialize};

const CWD_MARKER: &str = "__NODEDESK_CWD__";
const TIMEOUT_SECS: u64 = 30;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResult {
    pub ok: bool,
    pub output: String,
    pub cwd: String,
}

/// Server-side execution. Runs the command inside `cwd`, captures output,
/// and reports the resulting working directory so `cd` behaves as expected.
pub fn execute(cmd: &str, cwd: &str) -> TerminalResult {
    let start_dir = if cwd.is_empty() {
        dirs::home_dir()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".into())
    } else {
        cwd.to_string()
    };

    #[cfg(windows)]
    let (shell, args) = {
        let escaped = start_dir.replace('\'', "''");
        let wrapped = format!(
            "Set-Location -Path '{escaped}'; {cmd}; Write-Output \"`n{CWD_MARKER}$((Get-Location).Path)\""
        );
        ("powershell", vec!["-NoProfile", "-NonInteractive", "-Command", &wrapped])
    };
    #[cfg(not(windows))]
    let (shell, args) = {
        let escaped = start_dir.replace('\'', "'\\''");
        let wrapped = format!("cd '{escaped}'; {cmd}; printf '\\n{CWD_MARKER}%s' \"$PWD\"");
        ("sh", vec!["-c", &wrapped])
    };

    let spawn = std::process::Command::new(shell)
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    let mut child = match spawn {
        Ok(c) => c,
        Err(e) => {
            return TerminalResult {
                ok: false,
                output: format!("failed to start shell: {e}"),
                cwd: start_dir,
            }
        }
    };

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let out = child.wait_with_output();
        let _ = tx.send(out);
    });

    match rx.recv_timeout(std::time::Duration::from_secs(TIMEOUT_SECS)) {
        Ok(Ok(out)) => {
            let mut text = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            let mut new_cwd = start_dir.clone();
            if let Some(pos) = text.rfind(CWD_MARKER) {
                let after = &text[pos + CWD_MARKER.len()..];
                new_cwd = after.trim().to_string();
                text = text[..pos].trim_end().to_string();
            }
            TerminalResult {
                ok: out.status.success(),
                output: text,
                cwd: new_cwd,
            }
        }
        Ok(Err(e)) => TerminalResult {
            ok: false,
            output: e.to_string(),
            cwd: start_dir,
        },
        Err(_) => TerminalResult {
            ok: false,
            output: format!("command timed out after {TIMEOUT_SECS} seconds"),
            cwd: start_dir,
        },
    }
}
