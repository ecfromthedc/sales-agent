//! iMessage-to-self send via macOS Messages.app + `osascript`.
//!
//! When Eric reacts `:ship_it:` to a draft, we want the 4 PNGs on his phone
//! with minimum friction. AirDrop scripting is flaky; iCloud Drive lacks a
//! notification. iMessage is the sweet spot — a single conversation with all
//! the slides + caption, push notification fires, and tap-and-hold → Save All
//! moves the lot to Photos in 2 taps.
//!
//! We shell out to `osascript` because Messages.app exposes no programmatic
//! API; AppleScript dispatch is the only documented path. Each call:
//!
//! 1. Resolves the target buddy (a phone number or AppleID email)
//! 2. Sends each PNG as its own message
//! 3. Optionally appends a final text message with the caption
//!
//! Failure modes:
//! - `osascript` exits non-zero → bubbled up as anyhow error
//! - First run on a new Mac: macOS will prompt the user to grant Messages.app
//!   automation permission to Terminal/iTerm/Claude Code. Without that, the
//!   send silently no-ops at the OS level. The handoff doc walks through it.
//! - `RT_IMESSAGE_RECIPIENT` env var unset: we skip and log; this is not an
//!   error (Eric may not have configured a target yet).

use anyhow::{Context, Result, bail};
use std::path::Path;
use tokio::process::Command;
use tracing::{info, warn};

/// AppleScript template for sending a file via Messages.app's iMessage service.
/// `{path}` is replaced with an absolute file path; `{recipient}` with a phone
/// number or email registered with iMessage.
const SEND_FILE_SCRIPT: &str = r#"
tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set targetBuddy to participant "{recipient}" of targetService
    send (POSIX file "{path}") to targetBuddy
end tell
"#;

/// AppleScript template for sending a plain text message. Used for the caption.
const SEND_TEXT_SCRIPT: &str = r#"
tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set targetBuddy to participant "{recipient}" of targetService
    send "{text}" to targetBuddy
end tell
"#;

/// Send `pngs` (and optional `caption`) to `recipient` via iMessage.
///
/// `recipient` should be a phone number with `+` country code (e.g.
/// `+12025551234`) or an iCloud email. The number must already be registered
/// to a buddy in Messages.app.
///
/// Returns the number of attachments successfully sent (excludes the caption
/// message). Logs and continues on per-file failure rather than aborting.
pub async fn send_carousel(
    recipient: &str,
    pngs: &[impl AsRef<Path>],
    caption: Option<&str>,
) -> Result<usize> {
    if recipient.trim().is_empty() {
        bail!("iMessage recipient is empty");
    }
    let mut sent = 0_usize;
    for (idx, path) in pngs.iter().enumerate() {
        let p = path.as_ref();
        let abs = p
            .canonicalize()
            .with_context(|| format!("canonicalize {}", p.display()))?;
        let abs_str = abs.to_string_lossy().to_string();
        let script = SEND_FILE_SCRIPT
            .replace("{recipient}", recipient)
            .replace("{path}", &applescript_escape(&abs_str));
        match run_osascript(&script).await {
            Ok(()) => {
                sent += 1;
                info!(
                    recipient = %redact(recipient),
                    idx = idx + 1,
                    "iMessage attachment sent"
                );
            }
            Err(e) => warn!(
                recipient = %redact(recipient),
                idx = idx + 1,
                error = %e,
                "iMessage attachment failed — continuing"
            ),
        }
    }
    if let Some(text) = caption.filter(|t| !t.trim().is_empty()) {
        let script = SEND_TEXT_SCRIPT
            .replace("{recipient}", recipient)
            .replace("{text}", &applescript_escape(text));
        if let Err(e) = run_osascript(&script).await {
            warn!(recipient = %redact(recipient), error = %e, "iMessage caption text failed");
        }
    }
    Ok(sent)
}

/// Escape characters that would break AppleScript string literals:
/// backslash and double-quote. Newlines are mapped to `\n` so the script
/// stays on its intended line.
fn applescript_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 8);
    for c in input.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            _ => out.push(c),
        }
    }
    out
}

/// Mask all but the last 4 digits/chars of a recipient so logs don't leak
/// the full phone number. `+12025551234` → `+******1234`.
fn redact(recipient: &str) -> String {
    let n = recipient.chars().count();
    if n <= 4 {
        return "*".repeat(n);
    }
    let tail: String = recipient.chars().skip(n - 4).collect();
    format!("{}{tail}", "*".repeat(n - 4))
}

async fn run_osascript(script: &str) -> Result<()> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .await
        .context("spawning osascript")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("osascript exited {} — {}", output.status, stderr.trim());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_handles_quotes_and_backslashes() {
        assert_eq!(applescript_escape(r#"a"b\c"#), r#"a\"b\\c"#);
    }

    #[test]
    fn escape_converts_newlines() {
        assert_eq!(applescript_escape("a\nb"), "a\\nb");
    }

    #[test]
    fn escape_drops_carriage_returns() {
        assert_eq!(applescript_escape("a\r\nb"), "a\\nb");
    }

    #[test]
    fn escape_passes_through_unicode_and_safe_chars() {
        assert_eq!(applescript_escape("hello — 🌊 vol. 02"), "hello — 🌊 vol. 02");
    }

    #[test]
    fn redact_keeps_last_four() {
        // 12 chars: 8 masked + 4 trailing
        assert_eq!(redact("+12025551234"), "********1234");
        // 12 chars: 8 masked + ".com"
        assert_eq!(redact("alice@me.com"), "********.com");
    }

    #[test]
    fn redact_masks_short_strings_entirely() {
        assert_eq!(redact("123"), "***");
        assert_eq!(redact(""), "");
    }

    #[tokio::test]
    async fn send_carousel_with_empty_recipient_errors() {
        let pngs: Vec<&Path> = vec![];
        let err = send_carousel("", &pngs, None).await.unwrap_err();
        assert!(err.to_string().contains("empty"), "got: {err}");
    }
}
