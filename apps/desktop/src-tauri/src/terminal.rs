//! Remote terminal: executes a command on a paired host and returns output.
//!
//! Security note: this is intentionally powerful (it is a remote shell).
//! Every request is signed with the host's access code. Commands are capped at
//! 30 s — and the cap is enforced by killing the process, not by giving up on
//! waiting for it.

use serde::{Deserialize, Serialize};
use std::sync::mpsc;

const CWD_MARKER: &str = "__NODEDESK_CWD__";
const TIMEOUT_SECS: u64 = 30;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResult {
    pub ok: bool,
    pub output: String,
    pub cwd: String,
}

/// Reads a child pipe to end on its own thread, so stdout and stderr are
/// drained concurrently. Reading them in sequence deadlocks as soon as the
/// command fills the buffer of whichever pipe is not being read.
fn drain<R: std::io::Read + Send + 'static>(pipe: Option<R>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut buf);
        }
        let _ = tx.send(buf);
    });
    rx
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
    let (shell, args): (&str, Vec<String>) = {
        let escaped = start_dir.replace('\'', "''");
        let wrapped = format!(
            "Set-Location -Path '{escaped}'; {cmd}; Write-Output \"`n{CWD_MARKER}$((Get-Location).Path)\""
        );
        (
            "powershell",
            vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), wrapped],
        )
    };
    #[cfg(not(windows))]
    let (shell, args): (&str, Vec<String>) = {
        let escaped = start_dir.replace('\'', "'\\''");
        let wrapped = format!("cd '{escaped}'; {cmd}; printf '\\n{CWD_MARKER}%s' \"$PWD\"");
        ("sh", vec!["-c".into(), wrapped])
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

    let out_rx = drain(child.stdout.take());
    let err_rx = drain(child.stderr.take());

    // Poll for exit so the deadline can actually stop the process. A hung
    // command must not outlive the request that started it.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(TIMEOUT_SECS);
    let mut status = None;
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(exit)) => {
                status = Some(exit);
                break;
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => break,
        }
    }

    if timed_out {
        return TerminalResult {
            ok: false,
            output: format!("command timed out after {TIMEOUT_SECS} seconds and was stopped"),
            cwd: start_dir,
        };
    }

    // The pipes close when the process exits, so these are already resolved.
    let grace = std::time::Duration::from_secs(5);
    let out = out_rx.recv_timeout(grace).unwrap_or_default();
    let err = err_rx.recv_timeout(grace).unwrap_or_default();

    let mut text = format!(
        "{}{}",
        String::from_utf8_lossy(&out),
        String::from_utf8_lossy(&err)
    );
    let mut new_cwd = start_dir.clone();
    if let Some(pos) = text.rfind(CWD_MARKER) {
        let after = &text[pos + CWD_MARKER.len()..];
        new_cwd = after.trim().to_string();
        text = text[..pos].trim_end().to_string();
    }
    TerminalResult {
        ok: status.map(|s| s.success()).unwrap_or(false),
        output: text,
        cwd: new_cwd,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_a_command_and_reports_the_directory() {
        let result = execute("echo nodedesk-terminal-ok", "");
        assert!(result.output.contains("nodedesk-terminal-ok"));
        assert!(!result.cwd.is_empty());
    }

    #[test]
    fn reports_failure_for_a_command_that_exits_nonzero() {
        let result = execute("exit 3", "");
        assert!(!result.ok, "a non-zero exit must not report success");
    }

    #[test]
    fn a_hung_command_is_killed_and_does_not_block_forever() {
        // Sleeps well past the cap; the call must still return, and promptly.
        let started = std::time::Instant::now();
        let result = execute(
            if cfg!(windows) { "Start-Sleep -Seconds 90" } else { "sleep 90" },
            "",
        );
        let elapsed = started.elapsed();
        assert!(!result.ok);
        assert!(
            result.output.contains("timed out"),
            "expected a timeout result, got: {}",
            result.output
        );
        assert!(
            elapsed < std::time::Duration::from_secs(TIMEOUT_SECS + 20),
            "execute should return at the cap, took {elapsed:?}"
        );
    }
}
