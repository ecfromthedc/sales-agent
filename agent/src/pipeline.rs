//! Carousel pipeline orchestration — generation → render → PNG → Slack → Pocket.
//!
//! Extracted from `main.rs` so multiple trigger surfaces (HTTP `/intake`,
//! HTTP `/slack/slash-command`, Slack Socket Mode, `/alexandria-spawn`) can
//! share the exact same publish path. Keeping this in one place is the only
//! way to guarantee a slash command and a webhook produce identical output.
//!
//! Two entry points:
//! - [`run_from_intake`]: the common 5-field intake flow (Win/Take/etc).
//! - [`render_and_publish`]: takes already-drafted carousels and ships them.
//!   Used by `/alexandria-spawn` which builds its own draft directly via
//!   `Generator::draft_one(SeedField::AlexandriaSpawn, ...)`.

use anyhow::Result;
use std::sync::Arc;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::config::Config;
use crate::generator::Generator;
use crate::pocket::PocketInliner;
use crate::render::Renderer;
use crate::slack::SlackClient;
use crate::sources::SourceIndex;
use crate::types::{CarouselDraft, Intake};

/// Intake-driven pipeline: generate drafts from the 5 seed fields, then publish.
pub async fn run_from_intake(
    task_id: Uuid,
    cfg: Arc<Config>,
    sources: Arc<SourceIndex>,
    intake: Intake,
) -> Result<()> {
    info!(?task_id, "pipeline: building generator");
    let generator = Generator::new(&cfg, &sources)?;

    info!(?task_id, "pipeline: drafting from intake");
    let drafts = generator.draft_from_intake(&intake).await?;
    info!(?task_id, n = drafts.len(), "pipeline: drafts produced");

    let channel = intake
        .channel
        .clone()
        .unwrap_or_else(|| cfg.default_slack_channel.clone());
    let thread_ts = intake.thread_ts.clone();

    render_and_publish(task_id, &cfg, &drafts, &channel, thread_ts.as_deref()).await
}

/// Take pre-built drafts and run them through render → PNG → Slack → Pocket.
///
/// Each draft is independent — one failure (PNG, Slack, Pocket) doesn't abort
/// the others. We log and continue, matching Phase 1 behavior.
pub async fn render_and_publish(
    task_id: Uuid,
    cfg: &Config,
    drafts: &[CarouselDraft],
    channel: &str,
    thread_ts: Option<&str>,
) -> Result<()> {
    info!(?task_id, "pipeline: rendering HTML previews + PNG slides");
    let renderer = Renderer::new(cfg.repo_root.clone());
    let slack = SlackClient::new(cfg);
    let pocket = PocketInliner::new(cfg);
    let slack_enabled = cfg.slack_bot_token.is_some();

    for d in drafts {
        match renderer.write_preview(d) {
            Ok(path) => info!(
                ?task_id,
                slug = %d.slug,
                title = %d.working_title,
                seed = ?d.seed_field,
                path = %path.display(),
                "preview HTML written"
            ),
            Err(e) => {
                error!(
                    ?task_id,
                    slug = %d.slug,
                    error = %e,
                    "preview render failed — skipping draft"
                );
                continue;
            }
        }

        let pngs = match renderer.to_pngs(d).await {
            Ok(pngs) => {
                info!(
                    ?task_id,
                    slug = %d.slug,
                    count = pngs.len(),
                    "PNG slides captured"
                );
                pngs
            }
            Err(e) => {
                warn!(
                    ?task_id,
                    slug = %d.slug,
                    error = %e,
                    "PNG screenshot failed — preview HTML still written, skipping Slack"
                );
                continue;
            }
        };

        if slack_enabled {
            match slack
                .upload_carousel_draft(d, &pngs, channel, thread_ts)
                .await
            {
                Ok(result) => info!(
                    ?task_id,
                    slug = %d.slug,
                    channel = %result.channel,
                    thread_ts = ?result.thread_ts,
                    file_ids = result.file_ids.len(),
                    "carousel uploaded to Slack thread"
                ),
                Err(e) => warn!(
                    ?task_id,
                    slug = %d.slug,
                    error = %e,
                    "Slack upload failed — local artifacts still written"
                ),
            }
        } else {
            info!(
                ?task_id,
                slug = %d.slug,
                "Slack upload skipped — SLACK_BOT_TOKEN unset (PNGs written to disk only)"
            );
        }

        match pocket.inline_carousel(d) {
            Ok(result) => info!(
                ?task_id,
                slug = %d.slug,
                pocket_slug = %result.slug,
                hash = %result.hash,
                version = %result.version,
                action = ?result.action,
                "Pocket panel inlined — phone will hot-reload in ~2s"
            ),
            Err(e) => warn!(
                ?task_id,
                slug = %d.slug,
                error = %e,
                "Pocket inline skipped — local artifacts still written"
            ),
        }
    }

    Ok(())
}
