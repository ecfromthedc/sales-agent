//! Edit-notes regen flow — runs when Eric replies in a carousel thread.
//!
//! v1 scope: regenerate the entire draft with the edit notes injected as
//! voice guidance, then re-render and re-upload into the same thread. We
//! don't surgically rebuild just slide N today — that's a later optimization
//! noted in the handoff. The bias here is *correctness and clarity* over
//! token efficiency: a full regen always produces a self-consistent draft.
//!
//! When the reply parses as `slide N: …`, we forward the slide number to the
//! prompt so the LLM knows which beat to weight. When it doesn't match, we
//! treat the full reply as a general edit note that applies to the whole arc.
use anyhow::{Context, Result};
use std::sync::Arc;
use tracing::{info, warn};

use crate::config::Config;
use crate::drafts;
use crate::generator::Generator;
use crate::pipeline;
use crate::sources::SourceIndex;
use crate::types::{CarouselDraft, Intake};

/// Slide-targeted edit note vs. general edit note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditNote {
    SlideTargeted { slide: u32, note: String },
    General(String),
}

impl EditNote {
    pub fn note_text(&self) -> &str {
        match self {
            Self::SlideTargeted { note, .. } => note,
            Self::General(s) => s,
        }
    }
    pub fn slide(&self) -> Option<u32> {
        match self {
            Self::SlideTargeted { slide, .. } => Some(*slide),
            Self::General(_) => None,
        }
    }
}

/// Parse a reply for the `slide N: <note>` shorthand. Falls back to General.
/// Recognised forms (case-insensitive):
///   `slide 3: tighten the hook`
///   `Slide 3 — make it punchier`
///   `s3: ...`
///   `#3 ...`
pub fn parse_edit_note(text: &str) -> EditNote {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return EditNote::General(String::new());
    }

    // We match against a lowercased copy but read offsets from `trimmed`. The
    // two are byte-aligned only when case conversion preserves length (true
    // for ASCII; can differ for some Unicode like ß → ss). If they diverge,
    // skip targeting and treat as a general note.
    let lower = trimmed.to_lowercase();
    if lower.len() != trimmed.len() {
        return EditNote::General(trimmed.to_string());
    }

    // Longest prefixes first so "slide " wins over "slide" → "s".
    let prefixes: &[&str] = &["slide ", "slide", "s", "#"];
    for prefix in prefixes {
        if !lower.starts_with(prefix) {
            continue;
        }
        let mut cursor = prefix.len();
        // Skip any whitespace between the prefix and the digits.
        while cursor < lower.len() && &lower.as_bytes()[cursor..cursor + 1] == b" " {
            cursor += 1;
        }
        let digit_start = cursor;
        while cursor < lower.len() && lower.as_bytes()[cursor].is_ascii_digit() {
            cursor += 1;
        }
        if cursor == digit_start {
            continue;
        }
        let slide: u32 = match lower[digit_start..cursor].parse() {
            Ok(n) if n > 0 => n,
            _ => continue,
        };
        let after = trimmed[cursor..].trim_start_matches([':', '-', '—', '.', ' ', '\t']);
        if after.is_empty() {
            return EditNote::General(trimmed.to_string());
        }
        return EditNote::SlideTargeted {
            slide,
            note: after.to_string(),
        };
    }
    EditNote::General(trimmed.to_string())
}

/// Compose the voice_notes block that tells the LLM what Eric wants changed.
pub fn compose_voice_notes(original: &str, note: &EditNote) -> String {
    let mut s = String::with_capacity(original.len() + 256);
    if !original.trim().is_empty() {
        s.push_str(original.trim());
        s.push_str("\n\n");
    }
    s.push_str("EDIT NOTES FROM ERIC (regenerate accordingly):\n");
    match note {
        EditNote::SlideTargeted { slide, note } => {
            s.push_str(&format!(
                "- Focus your changes on SLIDE {slide}. Other slides may stay similar.\n\
                 - Note: {note}\n"
            ));
        }
        EditNote::General(n) => {
            s.push_str(&format!("- {n}\n"));
        }
    }
    s
}

/// Build the raw seed text for the regen. We keep the topic stable by feeding
/// in the working_title + hook, so the LLM doesn't drift to a different concept.
fn raw_seed(draft: &CarouselDraft) -> String {
    let mut s = String::with_capacity(256);
    s.push_str(&draft.working_title);
    if let Some(headline) = draft.hook.headline.as_deref() {
        s.push_str(" — ");
        s.push_str(headline);
    } else if let Some(lede) = draft.hook.lede.as_deref() {
        s.push_str(" — ");
        s.push_str(lede);
    }
    s
}

/// Entry point — invoked by `events::handle_message` when an edit-note reply
/// is received on a tracked, unlocked draft.
pub async fn apply_edit_note(
    cfg: Arc<Config>,
    sources: Arc<SourceIndex>,
    channel: String,
    parent_ts: String,
    reply_text: String,
) -> Result<()> {
    let state = drafts::store()
        .get(&channel, &parent_ts)
        .context("draft missing from store at regen time")?;
    if state.locked {
        info!(%channel, %parent_ts, "regen: draft was locked between event and dispatch — abort");
        return Ok(());
    }

    let edit_note = parse_edit_note(&reply_text);
    info!(
        %channel,
        %parent_ts,
        slug = %state.draft.slug,
        target_slide = ?edit_note.slide(),
        note_len = edit_note.note_text().len(),
        "regen: edit note parsed"
    );

    let generator = Generator::new(&cfg, &sources)?;

    let intake = Intake {
        win: None,
        take: Some(state.draft.working_title.clone()),
        insight: None,
        course_tease: None,
        contrarian: None,
        thread_ts: Some(parent_ts.clone()),
        channel: Some(channel.clone()),
        voice_notes: Some(compose_voice_notes("", &edit_note)),
        embargo: None,
    };

    let raw = raw_seed(&state.draft);
    let new_draft = generator
        .draft_one(state.draft.seed_field, &raw, &intake)
        .await
        .context("regen draft_one")?;

    // Hand the regenerated draft into the existing render → PNG → Slack
    // pipeline. It will register the NEW draft into the drafts store at the
    // same (channel, parent_ts) key, replacing the prior entry.
    let drafts = vec![new_draft];
    pipeline::render_and_publish(
        uuid::Uuid::new_v4(),
        &cfg,
        &drafts,
        &channel,
        Some(&parent_ts),
    )
    .await
    .map_err(|e| {
        warn!(error = %e, "regen: render_and_publish failed");
        e
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_general_note_when_no_slide_prefix() {
        let n = parse_edit_note("make the CTA less salesy");
        assert_eq!(n, EditNote::General("make the CTA less salesy".into()));
    }

    #[test]
    fn parse_slide_n_colon_form() {
        let n = parse_edit_note("slide 3: tighten the hook");
        assert_eq!(
            n,
            EditNote::SlideTargeted {
                slide: 3,
                note: "tighten the hook".into()
            }
        );
    }

    #[test]
    fn parse_slide_n_em_dash_form() {
        let n = parse_edit_note("Slide 2 — punchier");
        assert_eq!(
            n,
            EditNote::SlideTargeted {
                slide: 2,
                note: "punchier".into()
            }
        );
    }

    #[test]
    fn parse_short_form_s_n() {
        let n = parse_edit_note("s4: lose the exclamation");
        assert_eq!(
            n,
            EditNote::SlideTargeted {
                slide: 4,
                note: "lose the exclamation".into()
            }
        );
    }

    #[test]
    fn parse_hash_form() {
        let n = parse_edit_note("#1 swap to a number lead");
        assert_eq!(
            n,
            EditNote::SlideTargeted {
                slide: 1,
                note: "swap to a number lead".into()
            }
        );
    }

    #[test]
    fn parse_slide_without_note_is_general() {
        // "slide 3" with no body — we can't act on the targeting alone
        let n = parse_edit_note("slide 3");
        assert!(matches!(n, EditNote::General(_)));
    }

    #[test]
    fn parse_empty_yields_general_empty() {
        assert_eq!(parse_edit_note("   "), EditNote::General(String::new()));
    }

    #[test]
    fn parse_does_not_misfire_on_unrelated_text_starting_with_s() {
        // "something needs work" should NOT match "s" prefix because no digits
        let n = parse_edit_note("something needs work");
        assert!(matches!(n, EditNote::General(_)));
    }

    #[test]
    fn parse_handles_leading_whitespace() {
        let n = parse_edit_note("   slide 3: x   ");
        assert_eq!(
            n,
            EditNote::SlideTargeted {
                slide: 3,
                note: "x".into()
            }
        );
    }

    #[test]
    fn compose_voice_notes_targets_slide() {
        let v = compose_voice_notes(
            "be punchy",
            &EditNote::SlideTargeted {
                slide: 2,
                note: "softer".into(),
            },
        );
        assert!(v.contains("be punchy"));
        assert!(v.contains("SLIDE 2"));
        assert!(v.contains("softer"));
    }

    #[test]
    fn compose_voice_notes_general() {
        let v = compose_voice_notes("", &EditNote::General("tone is off".into()));
        assert!(v.contains("EDIT NOTES"));
        assert!(v.contains("tone is off"));
    }
}
