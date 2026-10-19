//! Session readiness and reconnect policy (SESSION-02, SESSION-07, SESSION-08).
//!
//! Process spawn is not a connected session. Moonlight-Qt logs
//! `Video stream is <width>x<height>x<fps>` from `Session::drSetup` only after
//! the video stream parameters are negotiated. That line is the readiness
//! marker. Reconnect after a drop uses three attempts at 1s, 2s, and 4s, and
//! stops immediately when the grant is revoked.

/// Bounded reconnect delays. Attempt 0 waits 1s, then 2s, then 4s.
pub const RECONNECT_DELAYS_MS: [u64; 3] = [1_000, 2_000, 4_000];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamSignal {
    /// Startup noise, SDL version lines, and everything that is not evidence.
    Ignore,
    /// Upstream video-stream negotiation log. This is the only Ready signal.
    Ready,
    /// The viewer reported that the connection died.
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recovery {
    /// User disconnect, or revocation. Do not launch another viewer.
    Stop,
    /// Exit before the stream was ever ready. That is a failure, not a drop.
    GiveUp,
    /// Wait `delay_ms`, then launch the same target again. `attempt` is 1-based.
    Retry { delay_ms: u64, attempt: u8 },
}

/// Classify one Moonlight stdout/stderr line.
///
/// Ready requires the upstream shape `Video stream is <w>x<h>x<fps>`, with
/// three decimal dimensions. A process-start line never matches.
pub fn classify_stream_line(line: &str) -> StreamSignal {
    if video_stream_ready(line) {
        return StreamSignal::Ready;
    }
    if line.contains("Connection terminated") {
        return StreamSignal::Failed;
    }
    StreamSignal::Ignore
}

fn video_stream_ready(line: &str) -> bool {
    let Some(rest) = line.split("Video stream is ").nth(1) else {
        return false;
    };
    let dims = rest.split_whitespace().next().unwrap_or("");
    let parts: Vec<&str> = dims.split('x').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

/// Next step after the viewer process exits.
///
/// `attempt_index` is how many retries have already been consumed (0 on the
/// first drop). Revocation and an explicit user stop both return [`Recovery::Stop`].
/// A clean exit that never logged a connection failure is the user closing the
/// viewer (SESSION-11), not a drop. An exit before [`StreamSignal::Ready`]
/// returns [`Recovery::GiveUp`].
pub fn on_process_exit(
    was_ready: bool,
    clean_exit: bool,
    saw_failure: bool,
    attempt_index: u8,
    revoked: bool,
    user_stop: bool,
) -> Recovery {
    if revoked || user_stop || (clean_exit && !saw_failure) {
        return Recovery::Stop;
    }
    if !was_ready {
        return Recovery::GiveUp;
    }
    let Some(delay_ms) = RECONNECT_DELAYS_MS.get(usize::from(attempt_index)).copied() else {
        return Recovery::GiveUp;
    };
    Recovery::Retry {
        delay_ms,
        attempt: attempt_index + 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_upstream_video_line_is_readiness() {
        assert_eq!(
            classify_stream_line("Video stream is 1920x1080x60 (format 0x1)"),
            StreamSignal::Ready
        );
        assert_eq!(
            classify_stream_line("INFO: Video stream is 1280x720x30 (format 0x100)"),
            StreamSignal::Ready
        );
        // Process spawn, SDL banners, and invented copy are not readiness.
        assert_eq!(
            classify_stream_line("Compiled with SDL 2.28.5"),
            StreamSignal::Ignore
        );
        assert_eq!(classify_stream_line("Starting Moonlight"), StreamSignal::Ignore);
        assert_eq!(
            classify_stream_line("Video stream is WIDTHxHEIGHTxFPS"),
            StreamSignal::Ignore
        );
        assert_eq!(
            classify_stream_line("Connection terminated: -1"),
            StreamSignal::Failed
        );
    }

    #[test]
    fn reconnect_schedule_is_bounded_and_revocation_stops_it() {
        // Dirty exit after readiness: 1s, then 2s, then 4s, then stop.
        assert_eq!(
            on_process_exit(true, false, true, 0, false, false),
            Recovery::Retry {
                delay_ms: 1_000,
                attempt: 1
            }
        );
        assert_eq!(
            on_process_exit(true, false, true, 1, false, false),
            Recovery::Retry {
                delay_ms: 2_000,
                attempt: 2
            }
        );
        assert_eq!(
            on_process_exit(true, false, true, 2, false, false),
            Recovery::Retry {
                delay_ms: 4_000,
                attempt: 3
            }
        );
        assert_eq!(on_process_exit(true, false, true, 3, false, false), Recovery::GiveUp);
        // The user closed the viewer. That is not a drop.
        assert_eq!(on_process_exit(true, true, false, 0, false, false), Recovery::Stop);
        // Exit before readiness is a failed connect, not a reconnect.
        assert_eq!(on_process_exit(false, false, true, 0, false, false), Recovery::GiveUp);
        // SESSION-08: revocation defeats a retry that would otherwise run.
        assert_eq!(on_process_exit(true, false, true, 0, true, false), Recovery::Stop);
        assert_eq!(on_process_exit(true, false, true, 1, false, true), Recovery::Stop);
    }
}
