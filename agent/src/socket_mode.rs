//! Slack Socket Mode listener — outbound WebSocket trigger surface.
//!
//! When `SLACK_APP_TOKEN` (an `xapp-…` token) is configured, the agent opens
//! an outbound WebSocket to Slack and receives slash commands through it. This
//! removes the need for a public HTTP endpoint or a Cloudflare tunnel — Slack
//! pushes envelopes through the existing TCP connection and we ack inline.
//!
//! Protocol reference: https://api.slack.com/apis/socket-mode
//!
//! The HTTP `/slack/slash-command` endpoint stays available for manual testing
//! and as a fallback (forge a signed request via `/tmp/test-slash.sh`).
//!
//! Run shape:
//! ```text
//!   loop forever:
//!     POST apps.connections.open → wss URL
//!     connect WebSocket
//!     for envelope in stream:
//!       match envelope.type:
//!         hello       → log
//!         disconnect  → break inner loop (force reconnect)
//!         slash_cmds  → ack within 3s, spawn pipeline
//!         events_api  → not implemented yet
//!     backoff (1s, 2s, 4s, 8s, … capped at 60s) and reconnect
//! ```

use anyhow::{Context, Result, anyhow};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::config::Config;
use crate::pipeline;
use crate::slack::SlashCommand;
use crate::sources::SourceIndex;

const APPS_CONNECTIONS_OPEN: &str = "https://slack.com/api/apps.connections.open";
const BACKOFF_INITIAL: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);

/// Spawn the Socket Mode loop as a tokio task. Returns immediately.
///
/// The task reconnects forever on any failure (network blip, Slack-side
/// disconnect, transient parse error). Only a misconfigured `SLACK_APP_TOKEN`
/// (deleted, expired) will cause it to log and back off indefinitely.
pub fn spawn(cfg: Arc<Config>, sources: Arc<SourceIndex>) {
    tokio::spawn(async move {
        run_forever(cfg, sources).await;
    });
}

/// Infinite reconnect loop with exponential backoff.
async fn run_forever(cfg: Arc<Config>, sources: Arc<SourceIndex>) {
    let mut backoff = BACKOFF_INITIAL;
    loop {
        match run_once(&cfg, &sources).await {
            Ok(()) => {
                info!("socket-mode session ended cleanly — reconnecting");
                backoff = BACKOFF_INITIAL;
            }
            Err(e) => {
                error!(error = %e, backoff_s = backoff.as_secs(), "socket-mode session failed — reconnecting");
                tokio::time::sleep(backoff).await;
                backoff = next_backoff(backoff);
            }
        }
    }
}

/// One Socket Mode session: open URL → connect → process envelopes until disconnect.
async fn run_once(cfg: &Config, sources: &Arc<SourceIndex>) -> Result<()> {
    let app_token = cfg
        .slack_app_token
        .as_deref()
        .ok_or_else(|| anyhow!("SLACK_APP_TOKEN not configured"))?;

    let wss_url = open_connection(app_token).await?;
    info!("socket-mode WebSocket URL acquired");

    let (ws_stream, _) = tokio_tungstenite::connect_async(&wss_url)
        .await
        .context("connecting to Slack WebSocket")?;
    info!("socket-mode connected");

    let (mut sink, mut stream) = ws_stream.split();

    while let Some(msg) = stream.next().await {
        let msg = msg.context("reading from Slack WebSocket")?;
        match msg {
            Message::Text(txt) => {
                if let Err(e) = handle_text(&txt, &mut sink, cfg, sources).await {
                    warn!(error = %e, raw_len = txt.len(), "socket-mode envelope handling failed");
                }
            }
            Message::Ping(payload) => {
                debug!("socket-mode ping");
                sink.send(Message::Pong(payload))
                    .await
                    .context("replying to ping")?;
            }
            Message::Pong(_) => debug!("socket-mode pong"),
            Message::Close(frame) => {
                info!(?frame, "socket-mode close frame — reconnecting");
                return Ok(());
            }
            Message::Binary(_) | Message::Frame(_) => {
                debug!("socket-mode ignoring non-text frame");
            }
        }
    }

    Ok(())
}

/// Call `apps.connections.open` to get a single-use wss URL.
async fn open_connection(app_token: &str) -> Result<String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(APPS_CONNECTIONS_OPEN)
        .header("Authorization", format!("Bearer {app_token}"))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .send()
        .await
        .context("POST apps.connections.open")?
        .error_for_status()
        .context("apps.connections.open HTTP status")?;

    let body: AppsConnectionsOpen = resp
        .json()
        .await
        .context("parsing apps.connections.open response")?;

    if !body.ok {
        return Err(anyhow!(
            "apps.connections.open returned not-ok: {}",
            body.error.unwrap_or_else(|| "unknown".to_string())
        ));
    }
    body.url
        .ok_or_else(|| anyhow!("apps.connections.open returned ok=true but no url"))
}

/// Process one text frame (a JSON envelope).
async fn handle_text<S>(
    raw: &str,
    sink: &mut S,
    cfg: &Config,
    sources: &Arc<SourceIndex>,
) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::fmt::Display + Send + Sync + 'static,
{
    let envelope: Envelope = serde_json::from_str(raw)
        .with_context(|| format!("parsing envelope (raw={})", truncate(raw, 200)))?;

    match envelope.envelope_type.as_deref() {
        Some("hello") => {
            info!(
                num_connections = envelope.num_connections.unwrap_or(0),
                "socket-mode hello"
            );
            Ok(())
        }
        Some("disconnect") => {
            info!(
                reason = envelope.reason.as_deref().unwrap_or(""),
                "socket-mode disconnect — will reconnect"
            );
            Err(anyhow!("slack requested disconnect"))
        }
        Some("slash_commands") => handle_slash_command(envelope, sink, cfg, sources).await,
        Some("events_api") => handle_events_api(envelope, sink, cfg, sources).await,
        Some("interactive") => {
            if let Some(env_id) = envelope.envelope_id.as_deref() {
                send_ack(sink, env_id, None).await?;
            }
            debug!("socket-mode interactive envelope (ignored)");
            Ok(())
        }
        other => {
            warn!(?other, "socket-mode unknown envelope type");
            Ok(())
        }
    }
}

/// Events API envelope: ack immediately, then dispatch the inner event so
/// reaction_added and thread-reply messages can route into the drafts store.
/// The dispatch is spawned because the ack must land within 3s.
async fn handle_events_api<S>(
    envelope: Envelope,
    sink: &mut S,
    cfg: &Config,
    sources: &Arc<SourceIndex>,
) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::fmt::Display + Send + Sync + 'static,
{
    if let Some(env_id) = envelope.envelope_id.as_deref() {
        send_ack(sink, env_id, None).await?;
    }
    let payload = match envelope.payload {
        Some(p) => p,
        None => {
            debug!("events_api envelope has no payload — ignored");
            return Ok(());
        }
    };
    let cfg = Arc::new(cfg.clone());
    let sources = Arc::clone(sources);
    tokio::spawn(async move {
        if let Err(e) = crate::events::handle_event_callback(cfg, sources, payload).await {
            warn!(error = %e, "events_api dispatch failed");
        }
    });
    Ok(())
}

/// Slash-command envelope: ack inline within 3s, then spawn the pipeline.
async fn handle_slash_command<S>(
    envelope: Envelope,
    sink: &mut S,
    cfg: &Config,
    sources: &Arc<SourceIndex>,
) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::fmt::Display + Send + Sync + 'static,
{
    let envelope_id = envelope
        .envelope_id
        .as_deref()
        .ok_or_else(|| anyhow!("slash_commands envelope missing envelope_id"))?;
    let payload = envelope
        .payload
        .as_ref()
        .ok_or_else(|| anyhow!("slash_commands envelope missing payload"))?;

    let cmd: SlashCommand = serde_json::from_value(payload.clone())
        .context("decoding slash-command payload from envelope")?;

    let intake = cmd.to_intake();
    let task_id = Uuid::new_v4();
    info!(
        ?task_id,
        command = %cmd.command,
        user = %cmd.user_name,
        channel = %cmd.channel_name,
        text_len = cmd.text.len(),
        "socket-mode slash command accepted — acking + spawning pipeline"
    );

    // Ack with an in-channel message so the channel sees the agent picked it up.
    let ack_payload = serde_json::json!({
        "response_type": "in_channel",
        "text": format!(
            ":carousel_horse: working on a draft from `{}`. PNGs will land here when ready.",
            cmd.text.replace('`', "'")
        ),
    });
    send_ack(sink, envelope_id, Some(ack_payload)).await?;

    let cfg = Arc::new(cfg.clone());
    let sources = Arc::clone(sources);
    tokio::spawn(async move {
        if let Err(e) = pipeline::run_from_intake(task_id, cfg, sources, intake).await {
            error!(?task_id, error = %e, "socket-mode pipeline failed");
        }
    });

    Ok(())
}

/// Send `{"envelope_id": "...", "payload": {...}}` back through the socket.
/// Per Slack spec, the payload field is optional and only used for slash
/// command / interactive responses.
async fn send_ack<S>(
    sink: &mut S,
    envelope_id: &str,
    payload: Option<serde_json::Value>,
) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::fmt::Display + Send + Sync + 'static,
{
    let ack = match payload {
        Some(p) => serde_json::json!({ "envelope_id": envelope_id, "payload": p }),
        None => serde_json::json!({ "envelope_id": envelope_id }),
    };
    let msg = Message::Text(ack.to_string());
    sink.send(msg)
        .await
        .map_err(|e| anyhow!("sending socket-mode ack: {e}"))?;
    debug!(%envelope_id, "socket-mode ack sent");
    Ok(())
}

fn next_backoff(current: Duration) -> Duration {
    let doubled = current.saturating_mul(2);
    if doubled > BACKOFF_MAX {
        BACKOFF_MAX
    } else {
        doubled
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}

#[derive(Debug, Deserialize)]
struct AppsConnectionsOpen {
    ok: bool,
    url: Option<String>,
    error: Option<String>,
}

/// Slack Socket Mode envelope. Fields are optional because the same struct
/// covers `hello`, `disconnect`, `slash_commands`, `events_api`, and
/// `interactive` envelope types — each populates a different subset.
#[derive(Debug, Deserialize)]
struct Envelope {
    #[serde(rename = "type")]
    envelope_type: Option<String>,
    envelope_id: Option<String>,
    payload: Option<serde_json::Value>,
    num_connections: Option<u32>,
    reason: Option<String>,
    #[allow(dead_code)]
    accepts_response_payload: Option<bool>,
}

/// Outbound ack shape — serialized when the agent acks an envelope. Kept as
/// a struct (rather than an inline `json!`) so the contract is easy to test.
#[derive(Debug, Serialize)]
#[allow(dead_code)]
struct Ack<'a> {
    envelope_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<serde_json::Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_parses_hello() {
        let raw = r#"{"type":"hello","num_connections":1,"debug_info":{"host":"x"},"connection_info":{"app_id":"A1"}}"#;
        let env: Envelope = serde_json::from_str(raw).expect("parses");
        assert_eq!(env.envelope_type.as_deref(), Some("hello"));
        assert_eq!(env.num_connections, Some(1));
        assert!(env.envelope_id.is_none());
    }

    #[test]
    fn envelope_parses_disconnect() {
        let raw = r#"{"type":"disconnect","reason":"warning","debug_info":{}}"#;
        let env: Envelope = serde_json::from_str(raw).expect("parses");
        assert_eq!(env.envelope_type.as_deref(), Some("disconnect"));
        assert_eq!(env.reason.as_deref(), Some("warning"));
    }

    #[test]
    fn envelope_parses_slash_command_with_payload() {
        let raw = r#"{
            "envelope_id": "abc-123",
            "payload": {
                "token": "test",
                "team_id": "T1",
                "team_domain": "rt",
                "channel_id": "C0B5X88QQ0K",
                "channel_name": "carousels",
                "user_id": "U1",
                "user_name": "eric",
                "command": "/carousel-build",
                "text": "Mon Rovia",
                "response_url": "https://hooks.slack.com/x",
                "trigger_id": "t.1"
            },
            "type": "slash_commands",
            "accepts_response_payload": true,
            "retry_attempt": 0
        }"#;
        let env: Envelope = serde_json::from_str(raw).expect("parses");
        assert_eq!(env.envelope_type.as_deref(), Some("slash_commands"));
        assert_eq!(env.envelope_id.as_deref(), Some("abc-123"));

        // Confirm we can re-decode the payload into a SlashCommand.
        let payload = env.payload.expect("has payload");
        let cmd: SlashCommand = serde_json::from_value(payload).expect("decodes to SlashCommand");
        assert_eq!(cmd.command, "/carousel-build");
        assert_eq!(cmd.channel_id, "C0B5X88QQ0K");
        assert_eq!(cmd.text, "Mon Rovia");
        let intake = cmd.to_intake();
        assert_eq!(intake.take.as_deref(), Some("Mon Rovia"));
        assert_eq!(intake.channel.as_deref(), Some("C0B5X88QQ0K"));
    }

    #[test]
    fn ack_serializes_with_payload() {
        let ack = serde_json::json!({
            "envelope_id": "abc-123",
            "payload": {"response_type": "in_channel", "text": "ok"}
        });
        let s = serde_json::to_string(&ack).unwrap();
        assert!(s.contains("\"envelope_id\":\"abc-123\""));
        assert!(s.contains("\"in_channel\""));
    }

    #[test]
    fn ack_serializes_without_payload() {
        let ack = serde_json::json!({"envelope_id": "abc-123"});
        let s = serde_json::to_string(&ack).unwrap();
        assert_eq!(s, r#"{"envelope_id":"abc-123"}"#);
    }

    #[test]
    fn next_backoff_caps_at_max() {
        assert_eq!(next_backoff(Duration::from_secs(1)), Duration::from_secs(2));
        assert_eq!(next_backoff(Duration::from_secs(8)), Duration::from_secs(16));
        assert_eq!(next_backoff(Duration::from_secs(32)), Duration::from_secs(60));
        assert_eq!(next_backoff(BACKOFF_MAX), BACKOFF_MAX);
    }

    #[test]
    fn truncate_handles_short_and_long() {
        assert_eq!(truncate("short", 100), "short");
        assert_eq!(truncate("abcdefghij", 5), "abcde…");
    }
}
