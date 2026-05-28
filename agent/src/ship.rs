//! Ship-it flow — runs when Eric reacts `:ship_it:` (or one of the alternate
//! ship reactions) on a tracked draft.
//!
//! Order of operations:
//! 1. Lock the draft in [`crate::drafts`] so subsequent edit-note replies are
//!    rejected as "draft already locked."
//! 2. Compose an IG-ready caption from the draft.
//! 3. Post a `🔒 ready to ship` summary in the carousel thread with the
//!    caption rendered as a Slack code block (copy-paste target).
//! 4. iMessage the slide PNGs + caption text to Eric's phone — that's the
//!    "low-friction add-song-and-ship" surface. No-op if no recipient is
//!    configured.
//!
//! This is one of two reaction-triggered flows. The other is regen
//! ([`crate::regen`]), triggered by thread replies with edit notes.
use anyhow::{Context, Result};
use std::sync::Arc;
use tracing::{info, warn};

use crate::config::Config;
use crate::drafts;
use crate::imessage;
use crate::slack::SlackClient;
use crate::sources::SourceIndex;
use crate::types::{CarouselDraft, CarouselFormat, SlideContent};

/// Entry point — invoked by `events::handle_reaction_added` after the
/// reaction has been validated against [`crate::drafts`].
pub async fn run_ship_flow(
    cfg: Arc<Config>,
    _sources: Arc<SourceIndex>,
    channel: String,
    parent_ts: String,
) -> Result<()> {
    // Re-fetch the draft so we have the freshest PNG paths (a regen may have
    // updated them since the event fired).
    let state = drafts::store()
        .get(&channel, &parent_ts)
        .context("draft missing from store at ship time")?;

    // Lock first — this is the source of truth for "no more edits."
    // If it was already locked we still continue (idempotent ship), but log it.
    let newly_locked = drafts::store().lock(&channel, &parent_ts);
    if !newly_locked {
        info!(%channel, %parent_ts, "ship flow re-fired on already-locked draft");
    }

    let caption = compose_caption(&state.draft);
    let summary = build_summary_message(&state.draft, state.png_paths.len(), &caption);

    let slack = SlackClient::new(&cfg);
    if let Err(e) = slack.post_thread_message(&channel, &parent_ts, &summary).await {
        warn!(error = %e, "ship: summary post failed — continuing to iMessage");
    } else {
        info!(%channel, %parent_ts, "ship: summary posted in thread");
    }

    // iMessage send (background-spawnable but we await here so a single
    // run_ship_flow call has a deterministic finish). Skipped if no recipient.
    match cfg.imessage_recipient.as_deref() {
        Some(recipient) if !recipient.trim().is_empty() => {
            match imessage::send_carousel(recipient, &state.png_paths, Some(&caption)).await {
                Ok(n) => info!(%channel, n, "ship: iMessage attachments sent"),
                Err(e) => warn!(error = %e, "ship: iMessage send failed"),
            }
        }
        _ => info!("ship: RT_IMESSAGE_RECIPIENT unset — skipping iMessage step"),
    }
    Ok(())
}

/// Compose an IG-ready caption draft from a finished carousel. Kept tight —
/// Eric tweaks in IG before posting if he wants more.
pub fn compose_caption(draft: &CarouselDraft) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(4);
    if let Some(line) = slide_text(&draft.hook) {
        parts.push(line);
    }
    if matches!(draft.format, CarouselFormat::Value)
        && let Some(payoff) = draft.payoff.as_ref().and_then(slide_text)
    {
        parts.push(payoff);
    }
    if let Some(cta) = slide_text(&draft.cta) {
        parts.push(cta);
    }
    parts.push(format!(
        "— vol. {vol:02} · @risingtides.ent",
        vol = draft.vol
    ));
    parts.join("\n\n")
}

fn slide_text(slide: &SlideContent) -> Option<String> {
    if let Some(lede) = slide.lede.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        return Some(lede.to_string());
    }
    if let Some(headline) = slide
        .headline
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(headline.to_string());
    }
    None
}

fn build_summary_message(draft: &CarouselDraft, slide_count: usize, caption: &str) -> String {
    let format_label = match draft.format {
        CarouselFormat::Editorial => "editorial",
        CarouselFormat::Value => "value carousel",
    };
    format!(
        "🔒 *ready to ship* · vol. {vol:02} · `{slug}` · {format_label} ({slide_count} slide{plural})\n\n\
         *caption draft (copy-paste):*\n\
         ```\n{caption}\n```\n\n\
         📲 iMessaging the slides to your phone now — open Messages → tap-and-hold any slide → *Save All to Photos* → IG → New Post → add song → ship.",
        vol = draft.vol,
        slug = draft.slug,
        plural = if slide_count == 1 { "" } else { "s" },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ContentOrigin, SeedField};

    fn slide(headline: Option<&str>, lede: Option<&str>) -> SlideContent {
        SlideContent {
            headline: headline.map(str::to_string),
            lede: lede.map(str::to_string),
            accent_words: vec![],
            origin: ContentOrigin::LlmFilled,
        }
    }

    fn value_draft() -> CarouselDraft {
        CarouselDraft {
            slug: "pre-release-curiosity".into(),
            format: CarouselFormat::Value,
            vol: 2,
            working_title: "Pre-release curiosity".into(),
            hook: slide(Some("DROP DAY ISN'T LAUNCH"), Some("Launch starts six weeks earlier.")),
            build: Some(slide(None, Some("The curiosity loop has to fire before the upload."))),
            payoff: Some(slide(Some("MAKE THEM SWIPE BEFORE SPOTIFY DOES"), None)),
            cta: slide(None, Some("DM us a song.")),
            sources: vec![],
            seed_field: SeedField::Insight,
        }
    }

    fn editorial_draft() -> CarouselDraft {
        CarouselDraft {
            slug: "authenticity-is-distribution".into(),
            format: CarouselFormat::Editorial,
            vol: 7,
            working_title: "Authenticity is distribution".into(),
            hook: slide(None, Some("Authenticity is now a distribution strategy.")),
            build: None,
            payoff: None,
            cta: slide(None, Some("DM us a song.")),
            sources: vec![],
            seed_field: SeedField::Take,
        }
    }

    #[test]
    fn caption_prefers_lede_over_headline() {
        let draft = value_draft();
        let cap = compose_caption(&draft);
        assert!(cap.contains("Launch starts six weeks earlier."));
        assert!(!cap.contains("DROP DAY ISN'T LAUNCH"));
    }

    #[test]
    fn caption_falls_back_to_headline_when_no_lede() {
        let draft = value_draft();
        let cap = compose_caption(&draft);
        // payoff slide has only a headline — should show up
        assert!(cap.contains("MAKE THEM SWIPE BEFORE SPOTIFY DOES"));
    }

    #[test]
    fn caption_includes_handle_and_vol() {
        let cap = compose_caption(&value_draft());
        assert!(cap.contains("@risingtides.ent"));
        assert!(cap.contains("vol. 02"));
    }

    #[test]
    fn editorial_caption_skips_payoff_line() {
        let cap = compose_caption(&editorial_draft());
        // editorial has no payoff — caption should still build
        assert!(cap.contains("Authenticity is now a distribution strategy."));
        assert!(cap.contains("DM us a song."));
        assert!(cap.contains("vol. 07"));
    }

    #[test]
    fn summary_includes_caption_code_block() {
        let draft = value_draft();
        let cap = compose_caption(&draft);
        let msg = build_summary_message(&draft, 4, &cap);
        assert!(msg.contains("```\n"));
        assert!(msg.contains("4 slides"));
        assert!(msg.contains("vol. 02"));
        assert!(msg.contains("pre-release-curiosity"));
        assert!(msg.contains("iMessaging"));
    }

    #[test]
    fn summary_pluralization_handles_one_slide() {
        let draft = editorial_draft();
        let cap = compose_caption(&draft);
        let msg = build_summary_message(&draft, 1, &cap);
        assert!(msg.contains("1 slide)"), "expected singular: {msg}");
        assert!(!msg.contains("1 slides"));
    }
}
