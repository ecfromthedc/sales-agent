//! Slack integration: file upload back to brief thread.
//!
//! Uses Slack's modern external-upload flow (the legacy `files.upload` endpoint
//! has been deprecated by Slack as of 2025):
//!
//!   1. `GET files.getUploadURLExternal` per file → returns `(upload_url, file_id)`
//!   2. `POST upload_url` with the file bytes (no auth header — the URL is presigned)
//!   3. `POST files.completeUploadExternal` once with all file ids + channel + thread_ts
//!
//! Phase 2 will add a Socket Mode listener (task #23) for incoming `/carousel-build`
//! slash commands.

use crate::config::Config;
use crate::types::{CarouselDraft, CarouselFormat, Intake, SeedField};
use anyhow::{anyhow, bail, Context, Result};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use std::path::PathBuf;

type HmacSha256 = Hmac<Sha256>;

/// Slack rejects requests older than 5 minutes — match that on our side so a
/// replayed payload can't be used past its window.
const SLACK_REQUEST_MAX_AGE_SECS: i64 = 60 * 5;

const SLACK_API: &str = "https://slack.com/api";

pub struct SlackClient<'a> {
    cfg: &'a Config,
    http: reqwest::Client,
}

#[derive(Debug, Deserialize)]
struct GetUploadUrlResponse {
    ok: bool,
    error: Option<String>,
    upload_url: Option<String>,
    file_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CompleteUploadResponse {
    ok: bool,
    error: Option<String>,
    files: Option<Vec<CompletedFile>>,
}

#[derive(Debug, Deserialize)]
struct CompletedFile {
    id: String,
}

/// Outcome of a successful upload — useful for downstream logging or follow-up
/// edits in the brief thread.
#[derive(Debug, Clone)]
pub struct UploadResult {
    pub file_ids: Vec<String>,
    pub channel: String,
    pub thread_ts: Option<String>,
}

impl<'a> SlackClient<'a> {
    pub fn new(cfg: &'a Config) -> Self {
        Self {
            cfg,
            http: reqwest::Client::new(),
        }
    }

    fn bot_token(&self) -> Result<&str> {
        self.cfg
            .slack_bot_token
            .as_deref()
            .ok_or_else(|| anyhow!("SLACK_BOT_TOKEN not configured — cannot upload files"))
    }

    /// Upload a carousel draft's PNG slides to a Slack thread. The initial
    /// comment is derived from the draft's metadata. Returns the file ids that
    /// were shared.
    pub async fn upload_carousel_draft(
        &self,
        draft: &CarouselDraft,
        png_paths: &[PathBuf],
        channel: &str,
        thread_ts: Option<&str>,
    ) -> Result<UploadResult> {
        let initial_comment = build_initial_comment(
            &draft.working_title,
            draft.vol,
            png_paths.len(),
            format_label(draft.format),
            seed_label(draft.seed_field),
        );
        self.upload_pngs_to_thread(channel, thread_ts, png_paths, &initial_comment)
            .await
    }

    /// Lower-level: upload arbitrary PNGs with a caller-supplied comment.
    pub async fn upload_pngs_to_thread(
        &self,
        channel: &str,
        thread_ts: Option<&str>,
        png_paths: &[PathBuf],
        initial_comment: &str,
    ) -> Result<UploadResult> {
        if png_paths.is_empty() {
            bail!("no PNG paths supplied — nothing to upload");
        }
        let token = self.bot_token()?;

        // Step 1+2: per-file upload-URL request, then PUT bytes.
        let mut uploaded: Vec<UploadedFile> = Vec::with_capacity(png_paths.len());
        for (idx, path) in png_paths.iter().enumerate() {
            let bytes = tokio::fs::read(path)
                .await
                .with_context(|| format!("read PNG at {}", path.display()))?;
            let filename = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("slide.png")
                .to_string();

            let (upload_url, file_id) = self
                .get_upload_url(token, &filename, bytes.len())
                .await
                .with_context(|| format!("getUploadURLExternal for slide {}", idx + 1))?;

            self.put_file_bytes(&upload_url, bytes, &filename)
                .await
                .with_context(|| format!("PUT bytes for slide {}", idx + 1))?;

            uploaded.push(UploadedFile {
                id: file_id,
                title: filename,
            });
        }

        // Step 3: single completeUploadExternal — shares all files to the thread.
        let file_ids = self
            .complete_upload(token, channel, thread_ts, initial_comment, &uploaded)
            .await
            .context("completeUploadExternal")?;

        Ok(UploadResult {
            file_ids,
            channel: channel.to_string(),
            thread_ts: thread_ts.map(str::to_string),
        })
    }

    async fn get_upload_url(
        &self,
        token: &str,
        filename: &str,
        length: usize,
    ) -> Result<(String, String)> {
        let resp: GetUploadUrlResponse = self
            .http
            .get(format!("{SLACK_API}/files.getUploadURLExternal"))
            .bearer_auth(token)
            .query(&[
                ("filename", filename),
                ("length", &length.to_string()),
            ])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        if !resp.ok {
            bail!(
                "slack getUploadURLExternal returned ok=false: {}",
                resp.error.unwrap_or_else(|| "unknown_error".into())
            );
        }
        let url = resp.upload_url.ok_or_else(|| anyhow!("missing upload_url in response"))?;
        let id = resp.file_id.ok_or_else(|| anyhow!("missing file_id in response"))?;
        Ok((url, id))
    }

    async fn put_file_bytes(&self, upload_url: &str, bytes: Vec<u8>, filename: &str) -> Result<()> {
        // Slack's external-upload URL accepts the raw file as POST body OR
        // multipart form-data. multipart works reliably with reqwest.
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(filename.to_string())
            .mime_str("image/png")?;
        let form = reqwest::multipart::Form::new().part("file", part);
        let status = self
            .http
            .post(upload_url)
            .multipart(form)
            .send()
            .await?
            .error_for_status()?
            .status();
        if !status.is_success() {
            bail!("upload PUT returned non-2xx: {status}");
        }
        Ok(())
    }

    async fn complete_upload(
        &self,
        token: &str,
        channel: &str,
        thread_ts: Option<&str>,
        initial_comment: &str,
        uploaded: &[UploadedFile],
    ) -> Result<Vec<String>> {
        let files_payload: Vec<_> = uploaded
            .iter()
            .map(|f| {
                serde_json::json!({
                    "id": f.id,
                    "title": f.title,
                })
            })
            .collect();

        let mut body = serde_json::json!({
            "files": files_payload,
            "channel_id": channel,
            "initial_comment": initial_comment,
        });
        if let Some(ts) = thread_ts {
            body["thread_ts"] = serde_json::Value::String(ts.to_string());
        }

        let resp: CompleteUploadResponse = self
            .http
            .post(format!("{SLACK_API}/files.completeUploadExternal"))
            .bearer_auth(token)
            .header("Content-Type", "application/json; charset=utf-8")
            .body(body.to_string())
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        if !resp.ok {
            bail!(
                "slack completeUploadExternal returned ok=false: {}",
                resp.error.unwrap_or_else(|| "unknown_error".into())
            );
        }
        Ok(resp
            .files
            .unwrap_or_default()
            .into_iter()
            .map(|f| f.id)
            .collect())
    }
}

struct UploadedFile {
    id: String,
    title: String,
}

/// Form payload Slack POSTs for a slash command (subset — Slack sends more
/// fields, but these are the ones we read).
#[derive(Debug, Deserialize)]
pub struct SlashCommand {
    pub command: String,
    pub text: String,
    pub user_id: String,
    pub user_name: String,
    pub channel_id: String,
    pub channel_name: String,
    pub team_id: String,
    pub response_url: String,
    pub trigger_id: String,
}

impl SlashCommand {
    /// Parse Slack's `application/x-www-form-urlencoded` body.
    pub fn parse(body: &[u8]) -> Result<Self> {
        serde_urlencoded::from_bytes(body)
            .map_err(|e| anyhow!("invalid slash-command form body: {e}"))
    }

    /// Convert the slash command into a carousel Intake. The `text` becomes
    /// Eric's "take" (the operator one-liner that anchors the draft), and the
    /// channel is preserved so the result lands back where the command fired.
    pub fn to_intake(&self) -> Intake {
        let take = self.text.trim();
        Intake {
            win: None,
            take: (!take.is_empty()).then(|| take.to_string()),
            insight: None,
            course_tease: None,
            contrarian: None,
            thread_ts: None,
            channel: Some(self.channel_id.clone()),
            voice_notes: Some(format!(
                "Slash command from @{} in #{}. Treat the take as the seed.",
                self.user_name, self.channel_name
            )),
            embargo: None,
        }
    }
}

/// Verify a Slack request signature using the documented v0 scheme:
///   `signature = "v0=" + hex(HMAC_SHA256(signing_secret, "v0:" + ts + ":" + body))`
///
/// Rejects:
/// - Missing / malformed signature or timestamp
/// - Stale timestamps (>5 min off `now`)
/// - HMAC mismatches (constant-time compare via the `hmac` crate)
pub fn verify_slack_signature(
    signing_secret: &str,
    timestamp_header: &str,
    body: &[u8],
    signature_header: &str,
    now_unix: i64,
) -> Result<()> {
    let ts: i64 = timestamp_header
        .parse()
        .context("X-Slack-Request-Timestamp is not an integer")?;
    if (now_unix - ts).abs() > SLACK_REQUEST_MAX_AGE_SECS {
        bail!("slack request timestamp is stale (>{SLACK_REQUEST_MAX_AGE_SECS}s)");
    }

    let expected_hex = signature_header
        .strip_prefix("v0=")
        .ok_or_else(|| anyhow!("X-Slack-Signature missing v0= prefix"))?;
    let expected_bytes = hex::decode(expected_hex).context("X-Slack-Signature is not hex")?;

    let mut mac = HmacSha256::new_from_slice(signing_secret.as_bytes())
        .map_err(|_| anyhow!("invalid signing secret"))?;
    mac.update(b"v0:");
    mac.update(timestamp_header.as_bytes());
    mac.update(b":");
    mac.update(body);
    mac.verify_slice(&expected_bytes)
        .map_err(|_| anyhow!("slack signature mismatch"))?;
    Ok(())
}

fn build_initial_comment(
    working_title: &str,
    vol: u32,
    slide_count: usize,
    format_label: &str,
    seed_label: &str,
) -> String {
    let plural = if slide_count == 1 { "" } else { "s" };
    format!(
        "*{working_title}* · vol. {vol:02} · {format_label}\n{slide_count} slide{plural} · seed: {seed_label}\n_draft — reply with edits or `:ship_it:` to approve_"
    )
}

fn format_label(format: CarouselFormat) -> &'static str {
    match format {
        CarouselFormat::Editorial => "editorial",
        CarouselFormat::Value => "value carousel",
    }
}

fn seed_label(seed: SeedField) -> &'static str {
    match seed {
        SeedField::Win => "win",
        SeedField::Take => "take",
        SeedField::Insight => "insight",
        SeedField::CourseTease => "course tease",
        SeedField::Contrarian => "contrarian",
        SeedField::AlexandriaSpawn => "alexandria spawn",
        SeedField::Manual => "manual",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_comment_includes_title_vol_count_and_seed() {
        let body = build_initial_comment("Pre-release curiosity", 2, 4, "value carousel", "take");
        assert!(body.contains("Pre-release curiosity"));
        assert!(body.contains("vol. 02"));
        assert!(body.contains("4 slides"));
        assert!(body.contains("seed: take"));
        assert!(body.contains("value carousel"));
        assert!(body.contains("draft"));
    }

    #[test]
    fn initial_comment_uses_singular_slide_for_editorial() {
        let body = build_initial_comment("Mon Rovia streams", 1, 1, "editorial", "win");
        assert!(body.contains("1 slide ·"), "expected singular slide: {body}");
        assert!(!body.contains("1 slides"));
    }

    /// Vector from Slack's signing-secret documentation:
    ///   signing_secret = "8f742231b10e8888abcd99yyyzzz85a5"
    ///   ts             = "1531420618"
    ///   body           = "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c"
    ///   expected sig   = "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503"
    #[test]
    fn verify_slack_signature_accepts_the_documented_test_vector() {
        let secret = "8f742231b10e8888abcd99yyyzzz85a5";
        let ts = "1531420618";
        let body = "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
        let sig = "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";
        // Use a `now` close to the ts so the staleness check passes.
        let now = 1531420618_i64 + 30;
        verify_slack_signature(secret, ts, body.as_bytes(), sig, now).expect("signature valid");
    }

    #[test]
    fn verify_slack_signature_rejects_stale_timestamp() {
        let secret = "secret";
        let ts = "1000000";
        let body = b"x=1";
        // Compute a valid signature so we know the failure is purely staleness.
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(b"v0:1000000:x=1");
        let sig_bytes = mac.finalize().into_bytes();
        let sig = format!("v0={}", hex::encode(sig_bytes));
        let err = verify_slack_signature(secret, ts, body, &sig, 2_000_000).unwrap_err();
        assert!(err.to_string().contains("stale"), "got: {err}");
    }

    #[test]
    fn verify_slack_signature_rejects_wrong_signature() {
        let secret = "secret";
        let ts = "1000000";
        let body = b"x=1";
        let bad = "v0=deadbeef".to_string() + &"0".repeat(56);
        let err = verify_slack_signature(secret, ts, body, &bad, 1_000_030).unwrap_err();
        assert!(err.to_string().contains("signature mismatch"), "got: {err}");
    }

    #[test]
    fn slash_command_parses_form_body_and_builds_intake() {
        let body = b"token=xyz&team_id=T1&team_domain=rt&channel_id=C0B5X88QQ0K&channel_name=carousels&user_id=U999&user_name=eric&command=%2Fcarousel-build&text=Mon+Rovia+just+hit+1.8M+listeners&response_url=https%3A%2F%2Fhooks.slack.com%2Fx&trigger_id=t.1.2";
        let cmd = SlashCommand::parse(body).expect("parses");
        assert_eq!(cmd.command, "/carousel-build");
        assert_eq!(cmd.channel_id, "C0B5X88QQ0K");
        assert_eq!(cmd.text, "Mon Rovia just hit 1.8M listeners");

        let intake = cmd.to_intake();
        assert_eq!(intake.channel.as_deref(), Some("C0B5X88QQ0K"));
        assert_eq!(intake.take.as_deref(), Some("Mon Rovia just hit 1.8M listeners"));
        assert!(intake.voice_notes.as_ref().unwrap().contains("@eric"));
        assert!(intake.voice_notes.as_ref().unwrap().contains("#carousels"));
    }

    #[test]
    fn slash_command_with_empty_text_yields_none_take() {
        let body = b"token=x&team_id=T1&team_domain=rt&channel_id=C1&channel_name=x&user_id=U1&user_name=u&command=%2Fcarousel-build&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fx&trigger_id=t";
        let cmd = SlashCommand::parse(body).unwrap();
        assert!(cmd.to_intake().take.is_none());
    }
}
