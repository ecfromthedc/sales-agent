//! Slack Events API dispatch — reaction_added + message routing.
//!
//! Socket Mode hands us `events_api` envelopes; we parse the inner Event
//! Callback and route by event type. Two types matter today:
//!
//! - `reaction_added` → look up the message in [`crate::drafts`]; if it's a
//!   tracked draft and the reaction is in [`SHIP_REACTIONS`], invoke the
//!   ship_it flow (lock + summary post + iMessage send).
//! - `message` (thread reply) → look up the parent thread; if tracked and
//!   unlocked, parse the reply for edit notes and trigger regen.
//!
//! Anything else (file_shared, app_mention, etc.) is acked at the envelope
//! layer and ignored here.
use anyhow::{Context, Result};
use serde::Deserialize;
use std::sync::Arc;
use tracing::{debug, info, warn};

use crate::config::Config;
use crate::drafts;
use crate::sources::SourceIndex;

/// Reactions that count as "approve and ship." Generous set so Eric doesn't
/// have to remember the exact emoji.
pub const SHIP_REACTIONS: &[&str] =
    &["ship_it", "heavy_check_mark", "white_check_mark", "+1", "rocket"];

/// Top-level envelope: `{ event_callback: { event: { ... }, ... } }`.
#[derive(Debug, Deserialize)]
struct EventCallback {
    event: RawEvent,
}

/// Catch-all event shape. We treat the JSON as a property bag and dispatch on
/// `event_type` so new Slack event shapes don't break parsing.
///
/// `user` and `ts` are kept for future logging/audit even though no code path
/// reads them today.
#[derive(Debug, Deserialize, Default)]
struct RawEvent {
    #[serde(rename = "type")]
    event_type: String,
    // message-shaped fields
    channel: Option<String>,
    #[allow(dead_code)]
    user: Option<String>,
    text: Option<String>,
    #[allow(dead_code)]
    ts: Option<String>,
    thread_ts: Option<String>,
    subtype: Option<String>,
    bot_id: Option<String>,
    // reaction-shaped fields
    reaction: Option<String>,
    item: Option<ReactionItem>,
}

#[derive(Debug, Deserialize)]
struct ReactionItem {
    #[serde(rename = "type")]
    item_type: String,
    channel: String,
    ts: String,
}

/// Entry point — called by socket_mode for every `events_api` envelope.
pub async fn handle_event_callback(
    cfg: Arc<Config>,
    sources: Arc<SourceIndex>,
    payload: serde_json::Value,
) -> Result<()> {
    let parsed: EventCallback =
        serde_json::from_value(payload).context("parsing event_callback payload")?;
    let event = parsed.event;
    match event.event_type.as_str() {
        "reaction_added" => handle_reaction_added(cfg, sources, event).await,
        "message" => handle_message(cfg, sources, event).await,
        other => {
            debug!(event_type = %other, "ignoring unsupported event type");
            Ok(())
        }
    }
}

async fn handle_reaction_added(
    cfg: Arc<Config>,
    sources: Arc<SourceIndex>,
    event: RawEvent,
) -> Result<()> {
    let reaction = match event.reaction.as_deref() {
        Some(r) => r,
        None => {
            warn!("reaction_added event missing `reaction` field");
            return Ok(());
        }
    };
    let item = match event.item.as_ref() {
        Some(i) if i.item_type == "message" => i,
        _ => {
            debug!(?event.item, "reaction_added on non-message item — ignored");
            return Ok(());
        }
    };

    if !SHIP_REACTIONS.contains(&reaction) {
        debug!(reaction, "reaction is not in SHIP_REACTIONS — ignored");
        return Ok(());
    }

    let state = match drafts::store().get(&item.channel, &item.ts) {
        Some(s) => s,
        None => {
            debug!(channel = %item.channel, ts = %item.ts, "reaction on untracked message — ignored");
            return Ok(());
        }
    };

    if state.locked {
        info!(
            channel = %item.channel,
            ts = %item.ts,
            slug = %state.draft.slug,
            "draft already locked — repeat ship reaction noted, no action"
        );
        return Ok(());
    }

    info!(
        channel = %item.channel,
        ts = %item.ts,
        slug = %state.draft.slug,
        reaction,
        "ship reaction received — locking + dispatching ship flow"
    );

    let channel = item.channel.clone();
    let parent_ts = item.ts.clone();
    tokio::spawn(async move {
        if let Err(e) = crate::ship::run_ship_flow(cfg, sources, channel, parent_ts).await {
            warn!(error = %e, "ship flow failed");
        }
    });
    Ok(())
}

async fn handle_message(
    cfg: Arc<Config>,
    sources: Arc<SourceIndex>,
    event: RawEvent,
) -> Result<()> {
    // Filter bots (including our own bot's posts) so we don't loop.
    if event.bot_id.is_some() {
        debug!("message event from a bot — ignored");
        return Ok(());
    }
    // Filter message_changed / message_deleted / channel_join etc.
    if let Some(subtype) = event.subtype.as_deref() {
        debug!(subtype, "message event with subtype — ignored");
        return Ok(());
    }

    let (channel, thread_ts, text) = match (event.channel, event.thread_ts, event.text) {
        (Some(c), Some(t), Some(txt)) if !txt.trim().is_empty() => (c, t, txt),
        _ => {
            debug!("message event is not a thread reply with text — ignored");
            return Ok(());
        }
    };

    let state = match drafts::store().get(&channel, &thread_ts) {
        Some(s) => s,
        None => {
            debug!(%channel, %thread_ts, "reply in untracked thread — ignored");
            return Ok(());
        }
    };

    if state.locked {
        info!(
            %channel,
            %thread_ts,
            slug = %state.draft.slug,
            "edit-note reply on a locked draft — fire /carousel-build for a fresh take"
        );
        return Ok(());
    }

    info!(
        %channel,
        %thread_ts,
        slug = %state.draft.slug,
        text_len = text.len(),
        "edit-note reply received — dispatching regen"
    );
    tokio::spawn(async move {
        if let Err(e) =
            crate::regen::apply_edit_note(cfg, sources, channel, thread_ts, text).await
        {
            warn!(error = %e, "edit-note regen failed");
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reaction_event(reaction: &str, channel: &str, ts: &str, item_type: &str) -> RawEvent {
        RawEvent {
            event_type: "reaction_added".into(),
            reaction: Some(reaction.into()),
            item: Some(ReactionItem {
                item_type: item_type.into(),
                channel: channel.into(),
                ts: ts.into(),
            }),
            ..Default::default()
        }
    }

    fn message_event() -> RawEvent {
        RawEvent {
            event_type: "message".into(),
            channel: Some("C1".into()),
            user: Some("U1".into()),
            text: Some("slide 3: tighten the hook".into()),
            ts: Some("100.001".into()),
            thread_ts: Some("100.000".into()),
            ..Default::default()
        }
    }

    #[test]
    fn ship_reactions_include_documented_set() {
        for r in ["ship_it", "heavy_check_mark", "white_check_mark", "+1", "rocket"] {
            assert!(
                SHIP_REACTIONS.contains(&r),
                "expected `{r}` in SHIP_REACTIONS"
            );
        }
    }

    #[test]
    fn raw_event_parses_reaction_added_envelope() {
        let raw = serde_json::json!({
            "type": "reaction_added",
            "user": "U1",
            "reaction": "ship_it",
            "item": {
                "type": "message",
                "channel": "C1",
                "ts": "100.001"
            },
            "event_ts": "100.001"
        });
        let ev: RawEvent = serde_json::from_value(raw).expect("parses");
        assert_eq!(ev.event_type, "reaction_added");
        assert_eq!(ev.reaction.as_deref(), Some("ship_it"));
        let item = ev.item.as_ref().expect("has item");
        assert_eq!(item.channel, "C1");
        assert_eq!(item.ts, "100.001");
    }

    #[test]
    fn raw_event_parses_thread_reply() {
        let raw = serde_json::json!({
            "type": "message",
            "channel": "C1",
            "user": "U1",
            "text": "looks great",
            "ts": "200.001",
            "thread_ts": "200.000"
        });
        let ev: RawEvent = serde_json::from_value(raw).expect("parses");
        assert_eq!(ev.event_type, "message");
        assert_eq!(ev.thread_ts.as_deref(), Some("200.000"));
        assert!(ev.bot_id.is_none());
    }

    #[test]
    fn raw_event_parses_message_with_subtype_and_bot_id() {
        let raw = serde_json::json!({
            "type": "message",
            "channel": "C1",
            "subtype": "bot_message",
            "bot_id": "B1",
            "text": "hi",
            "ts": "200.001",
            "thread_ts": "200.000"
        });
        let ev: RawEvent = serde_json::from_value(raw).expect("parses");
        assert!(ev.bot_id.is_some());
        assert_eq!(ev.subtype.as_deref(), Some("bot_message"));
    }

    #[test]
    fn reaction_event_helper_smoke() {
        let ev = reaction_event("ship_it", "C1", "1.0", "message");
        assert_eq!(ev.event_type, "reaction_added");
        assert_eq!(ev.item.as_ref().unwrap().channel, "C1");
    }

    #[test]
    fn message_event_helper_smoke() {
        let ev = message_event();
        assert_eq!(ev.thread_ts.as_deref(), Some("100.000"));
    }
}
