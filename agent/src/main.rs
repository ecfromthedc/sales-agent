//! rt-carousel-agent — Rising Tides carousel generation agent
//!
//! HTTP service that takes a Weekly Content Brief intake (5 answers from Eric)
//! and emits Midnight Press carousels: HTML previews, 1080×1350 PNGs, and PDFs.
//!
//! Trigger surfaces (all share the same `pipeline::run_from_intake` path):
//!   POST /intake                 — direct JSON intake (5-field Weekly Brief)
//!   POST /slack/slash-command    — Slack-signed `/carousel-build <topic>` (HTTP)
//!   POST /alexandria-spawn       — spawn a carousel from an Alexandria note
//!   Slack Socket Mode            — same `/carousel-build`, no public URL needed
//!
//! Endpoints:
//!   GET  /health                 — liveness probe

use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json},
    routing::{get, post},
};
use chrono::Utc;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::trace::TraceLayer;
use tracing::{error, info, warn};
use tracing_subscriber::{EnvFilter, fmt, prelude::*};
use uuid::Uuid;

use rt_carousel_agent::config::Config;
use rt_carousel_agent::drafts;
use rt_carousel_agent::generator::Generator;
use rt_carousel_agent::pipeline;
use rt_carousel_agent::regen;
use rt_carousel_agent::ship;
use rt_carousel_agent::slack::{SlashCommand, verify_slack_signature};
use rt_carousel_agent::socket_mode;
use rt_carousel_agent::sources::SourceIndex;
use rt_carousel_agent::types::{Intake, IntakeResponse, SeedField, TaskStatus};

/// Shared state across all handlers. `Arc`-wrapped so background tasks
/// (spawned for the pipeline) can hold their own clones cheaply.
struct AppState {
    cfg: Arc<Config>,
    sources: Arc<SourceIndex>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cfg = Config::from_env()?;

    // Write to stderr so launchd captures lines immediately. Rust's stdout is
    // block-buffered when redirected to a file; stderr is line-buffered, so
    // logs appear in /tmp/rt-carousel-agent.err as they happen — critical for
    // diagnosing a service whose only window is its logs.
    tracing_subscriber::registry()
        .with(EnvFilter::try_new(&cfg.log_level).unwrap_or_else(|_| EnvFilter::new("info")))
        .with(fmt::layer().with_target(true).with_writer(std::io::stderr))
        .init();

    info!(version = env!("CARGO_PKG_VERSION"), "rt-carousel-agent starting");
    info!(bind = %cfg.bind_addr, "binding HTTP server");
    info!(repo_root = ?cfg.repo_root, course_index = ?cfg.course_index_path);
    info!(obsidian_vault = ?cfg.obsidian_vault);

    if cfg.anthropic_api_key.is_none() {
        warn!("ANTHROPIC_API_KEY unset — LLM gap-filling will fail until set");
    }
    if cfg.slack_bot_token.is_none() {
        warn!("SLACK_BOT_TOKEN unset — Slack file uploads will fail until set");
    }
    if cfg.slack_app_token.is_none() {
        info!("SLACK_APP_TOKEN unset — Socket Mode disabled (HTTP slash endpoint still active)");
    }

    let sources = SourceIndex::load(&cfg)?;
    info!(
        claims = sources.claims.len(),
        banned = sources.banned_phrases.len(),
        metaphors = sources.voice_metaphors.len(),
        "loaded source index"
    );

    let cfg = Arc::new(cfg);
    let sources = Arc::new(sources);

    // Spawn Slack Socket Mode listener if the app token is present. This
    // gives us a Slack trigger surface that doesn't need a public URL —
    // Slack pushes slash-command envelopes through an outbound WebSocket.
    if cfg.slack_app_token.is_some() {
        info!("starting Slack Socket Mode listener");
        socket_mode::spawn(Arc::clone(&cfg), Arc::clone(&sources));
    }

    let state = Arc::new(AppState {
        cfg: Arc::clone(&cfg),
        sources: Arc::clone(&sources),
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/intake", post(intake_handler))
        .route("/slack/slash-command", post(slash_command_handler))
        .route("/alexandria-spawn", post(alexandria_spawn_handler))
        .route("/debug/list-drafts", get(debug_list_drafts))
        .route("/debug/simulate-ship", post(debug_simulate_ship))
        .route("/debug/simulate-edit-note", post(debug_simulate_edit_note))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&cfg.bind_addr).await?;
    info!(addr = %listener.local_addr()?, "listening");
    axum::serve(listener, app).await?;

    Ok(())
}

/// GET /health — liveness probe.
async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(serde_json::json!({
        "ok": true,
        "service": "rt-carousel-agent",
        "version": env!("CARGO_PKG_VERSION"),
        "anthropic_key_present": state.cfg.anthropic_api_key.is_some(),
        "slack_token_present": state.cfg.slack_bot_token.is_some(),
        "slack_signing_secret_present": state.cfg.slack_signing_secret.is_some(),
        "slack_app_token_present": state.cfg.slack_app_token.is_some(),
        "socket_mode_enabled": state.cfg.slack_app_token.is_some(),
        "default_channel": state.cfg.default_slack_channel,
        "obsidian_vault": state.cfg.obsidian_vault.display().to_string(),
        "sources": {
            "claims": state.sources.claims.len(),
            "banned_phrases": state.sources.banned_phrases.len(),
            "voice_metaphors": state.sources.voice_metaphors.len(),
        },
        "now": Utc::now().to_rfc3339(),
    }))
}

/// POST /intake — receive a Weekly Content Brief intake. Pipeline runs in background.
async fn intake_handler(
    State(state): State<Arc<AppState>>,
    Json(intake): Json<Intake>,
) -> Result<Json<IntakeResponse>, (StatusCode, String)> {
    let task_id = Uuid::new_v4();
    let filled = [
        intake.win.is_some(),
        intake.take.is_some(),
        intake.insight.is_some(),
        intake.course_tease.is_some(),
        intake.contrarian.is_some(),
    ]
    .iter()
    .filter(|x| **x)
    .count();

    info!(?task_id, filled, "received intake — spawning pipeline");

    let cfg = Arc::clone(&state.cfg);
    let sources = Arc::clone(&state.sources);
    let pipeline_intake = intake.clone();
    tokio::spawn(async move {
        if let Err(e) = pipeline::run_from_intake(task_id, cfg, sources, pipeline_intake).await {
            error!(?task_id, error = %e, "pipeline failed");
        }
    });

    let response = IntakeResponse {
        task_id,
        received_at: Utc::now(),
        status: TaskStatus::Accepted,
        message: format!(
            "Intake received ({filled} of 5 fields filled). Pipeline running in background — \
             results post to Slack thread on completion."
        ),
    };

    Ok(Json(response))
}

/// POST /slack/slash-command — Slack-triggered carousel build (HTTP path).
///
/// Slack wires `/carousel-build <topic>` to a public URL pointing at this
/// endpoint. We verify the request signature, ack within 3 seconds, and
/// run the same pipeline in the background.
///
/// When Socket Mode is enabled this endpoint is redundant for production
/// but is kept for `/tmp/test-slash.sh` integration tests and as a backup
/// if Socket Mode is intentionally disabled.
async fn slash_command_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let signing_secret = state.cfg.slack_signing_secret.as_deref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "SLACK_SIGNING_SECRET not configured — slash endpoint is disabled".to_string(),
    ))?;

    let ts_header = headers
        .get("X-Slack-Request-Timestamp")
        .and_then(|v| v.to_str().ok())
        .ok_or((
            StatusCode::BAD_REQUEST,
            "missing X-Slack-Request-Timestamp header".to_string(),
        ))?;
    let sig_header = headers
        .get("X-Slack-Signature")
        .and_then(|v| v.to_str().ok())
        .ok_or((
            StatusCode::BAD_REQUEST,
            "missing X-Slack-Signature header".to_string(),
        ))?;

    let now = Utc::now().timestamp();
    if let Err(e) = verify_slack_signature(signing_secret, ts_header, &body, sig_header, now) {
        warn!(error = %e, "rejected slack request — bad signature");
        return Err((StatusCode::UNAUTHORIZED, "signature check failed".to_string()));
    }

    let cmd = SlashCommand::parse(&body).map_err(|e| {
        warn!(error = %e, "bad slash-command form body");
        (StatusCode::BAD_REQUEST, "invalid form body".to_string())
    })?;

    let task_id = Uuid::new_v4();
    let intake = cmd.to_intake();
    info!(
        ?task_id,
        command = %cmd.command,
        user = %cmd.user_name,
        channel = %cmd.channel_name,
        text_len = cmd.text.len(),
        "slash command accepted (HTTP) — spawning pipeline"
    );

    let cfg = Arc::clone(&state.cfg);
    let sources = Arc::clone(&state.sources);
    let pipeline_intake = intake.clone();
    tokio::spawn(async move {
        if let Err(e) = pipeline::run_from_intake(task_id, cfg, sources, pipeline_intake).await {
            error!(?task_id, error = %e, "pipeline failed");
        }
    });

    Ok(Json(serde_json::json!({
        "response_type": "in_channel",
        "text": format!(
            ":carousel_horse: working on a draft from `{}`. PNGs will land here when ready.",
            cmd.text.replace('`', "'")
        ),
    })))
}

/// Body of POST /alexandria-spawn. `note_path` is the only required field.
#[derive(Debug, Deserialize)]
struct AlexandriaSpawnRequest {
    /// Path to the Alexandria note. Accepts:
    /// - Absolute path (`/Users/.../Obsidian Vault/Alexandria/...`)
    /// - Path relative to the Obsidian vault root (`Alexandria/Content Strategy/foo.md`)
    /// - Path relative to the vault's `Alexandria/` folder (`Content Strategy/foo.md`)
    note_path: String,
    /// Optional — override the destination Slack channel.
    channel: Option<String>,
    /// Optional — post into an existing thread.
    thread_ts: Option<String>,
    /// Optional — manual override of the "take" (one-line operator angle)
    /// the generator anchors to. If absent, we derive one from the note's
    /// title/frontmatter/first paragraph.
    take_override: Option<String>,
}

/// POST /alexandria-spawn — generate a carousel from a new Alexandria note.
///
/// Designed as a webhook target for `alexandria-slack-notifier.py`: when an
/// Alexandria entry is published, fire this endpoint and a carousel draft
/// lands in #carousels minutes later.
async fn alexandria_spawn_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AlexandriaSpawnRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let task_id = Uuid::new_v4();

    let resolved = resolve_note_path(&state.cfg.obsidian_vault, &req.note_path).map_err(|e| {
        warn!(?task_id, note = %req.note_path, error = %e, "alexandria note path invalid");
        (StatusCode::BAD_REQUEST, e.to_string())
    })?;

    let note_raw = std::fs::read_to_string(&resolved).map_err(|e| {
        warn!(?task_id, path = %resolved.display(), error = %e, "alexandria note read failed");
        (
            StatusCode::NOT_FOUND,
            format!("could not read note: {e}"),
        )
    })?;

    let note = AlexandriaNote::parse(&note_raw);
    let take = req
        .take_override
        .clone()
        .or_else(|| note.derive_take())
        .ok_or((
            StatusCode::UNPROCESSABLE_ENTITY,
            "could not derive a 'take' from the note — pass take_override".to_string(),
        ))?;

    info!(
        ?task_id,
        path = %resolved.display(),
        body_len = note.body.len(),
        title = ?note.title,
        derived_take_len = take.len(),
        "alexandria spawn accepted"
    );

    let intake = Intake {
        win: None,
        take: Some(take.clone()),
        insight: None,
        course_tease: None,
        contrarian: None,
        thread_ts: req.thread_ts.clone(),
        channel: req.channel.clone(),
        voice_notes: Some(format!(
            "Alexandria spawn from `{}`. Treat the take as the operator angle, ground in the note content.",
            req.note_path
        )),
        embargo: note.embargo.clone(),
    };

    // Use draft_one directly so we get SeedField::AlexandriaSpawn (not Take)
    // on the produced draft, and so we can feed the note body in as `raw`
    // for source-grounding context.
    let cfg = Arc::clone(&state.cfg);
    let sources = Arc::clone(&state.sources);
    let body_for_pipeline = note.body.clone();
    let channel = req
        .channel
        .clone()
        .unwrap_or_else(|| cfg.default_slack_channel.clone());
    let thread_ts = req.thread_ts.clone();
    let take_for_pipeline = take.clone();

    tokio::spawn(async move {
        let generator = match Generator::new(&cfg, &sources) {
            Ok(g) => g,
            Err(e) => {
                error!(?task_id, error = %e, "alexandria spawn: generator init failed");
                return;
            }
        };
        // Use the note body as the source-grounding context, the derived take as the seed angle.
        let raw = format!("{take_for_pipeline}\n\n{body_for_pipeline}");
        let draft = match generator
            .draft_one(SeedField::AlexandriaSpawn, &raw, &intake)
            .await
        {
            Ok(d) => d,
            Err(e) => {
                error!(?task_id, error = %e, "alexandria spawn: draft failed");
                return;
            }
        };
        let drafts = vec![draft];
        if let Err(e) =
            pipeline::render_and_publish(task_id, &cfg, &drafts, &channel, thread_ts.as_deref())
                .await
        {
            error!(?task_id, error = %e, "alexandria spawn: pipeline failed");
        }
    });

    Ok(Json(serde_json::json!({
        "ok": true,
        "task_id": task_id,
        "note_path": resolved.display().to_string(),
        "take": take,
        "message": "alexandria spawn accepted — draft posting to Slack shortly",
    })))
}

/// Body for /debug/simulate-ship — simulates a `:ship_it:` reaction without
/// needing Slack to actually deliver an events_api envelope. Used to verify
/// the ship flow end-to-end when Event Subscriptions delivery is gated on a
/// pending Slack UI toggle.
#[derive(Debug, Deserialize)]
struct DebugSimulateShipRequest {
    channel: String,
    parent_ts: String,
}

/// Body for /debug/simulate-edit-note — simulates a thread reply edit note.
#[derive(Debug, Deserialize)]
struct DebugSimulateEditNoteRequest {
    channel: String,
    parent_ts: String,
    text: String,
}

/// GET /debug/list-drafts — lists live (in-memory) drafts so you can find a
/// (channel, parent_ts) pair to pass into the simulators.
async fn debug_list_drafts() -> Json<serde_json::Value> {
    let store = drafts::store();
    Json(serde_json::json!({
        "live_draft_count": store.len(),
        "note": "drafts are keyed by (channel, parent_ts); use /debug/simulate-ship or /debug/simulate-edit-note to exercise the post-draft handlers without a Slack event",
    }))
}

/// POST /debug/simulate-ship — fires the `:ship_it:` reaction flow against an
/// existing draft. Lock → summary post → iMessage send.
async fn debug_simulate_ship(
    State(state): State<Arc<AppState>>,
    Json(req): Json<DebugSimulateShipRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if drafts::store().get(&req.channel, &req.parent_ts).is_none() {
        return Err((
            StatusCode::NOT_FOUND,
            format!(
                "no live draft at (channel={}, parent_ts={}). Use GET /debug/list-drafts and POST /intake to create one first.",
                req.channel, req.parent_ts
            ),
        ));
    }
    let cfg = Arc::clone(&state.cfg);
    let sources = Arc::clone(&state.sources);
    let channel = req.channel.clone();
    let parent_ts = req.parent_ts.clone();
    tokio::spawn(async move {
        if let Err(e) = ship::run_ship_flow(cfg, sources, channel, parent_ts).await {
            warn!(error = %e, "debug ship flow failed");
        }
    });
    Ok(Json(serde_json::json!({
        "ok": true,
        "message": "ship flow dispatched in background",
        "channel": req.channel,
        "parent_ts": req.parent_ts,
    })))
}

/// POST /debug/simulate-edit-note — fires the edit-note regen flow.
async fn debug_simulate_edit_note(
    State(state): State<Arc<AppState>>,
    Json(req): Json<DebugSimulateEditNoteRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    if drafts::store().get(&req.channel, &req.parent_ts).is_none() {
        return Err((
            StatusCode::NOT_FOUND,
            format!(
                "no live draft at (channel={}, parent_ts={})",
                req.channel, req.parent_ts
            ),
        ));
    }
    let cfg = Arc::clone(&state.cfg);
    let sources = Arc::clone(&state.sources);
    let channel = req.channel.clone();
    let parent_ts = req.parent_ts.clone();
    let text = req.text.clone();
    tokio::spawn(async move {
        if let Err(e) = regen::apply_edit_note(cfg, sources, channel, parent_ts, text).await {
            warn!(error = %e, "debug edit-note regen failed");
        }
    });
    Ok(Json(serde_json::json!({
        "ok": true,
        "message": "edit-note regen dispatched in background",
        "channel": req.channel,
        "parent_ts": req.parent_ts,
        "text_len": req.text.len(),
    })))
}

/// Resolve an Alexandria note path. The frontend may pass:
/// - an absolute path
/// - a vault-relative path (`Alexandria/Content Strategy/foo.md`)
/// - an `Alexandria/`-relative path (`Content Strategy/foo.md`)
fn resolve_note_path(vault: &std::path::Path, raw: &str) -> anyhow::Result<PathBuf> {
    let p = PathBuf::from(raw);
    if p.is_absolute() {
        if p.exists() {
            return Ok(p);
        }
        return Err(anyhow::anyhow!("absolute path does not exist: {raw}"));
    }
    let vault_rel = vault.join(&p);
    if vault_rel.exists() {
        return Ok(vault_rel);
    }
    let alex_rel = vault.join("Alexandria").join(&p);
    if alex_rel.exists() {
        return Ok(alex_rel);
    }
    Err(anyhow::anyhow!(
        "note not found under vault root or Alexandria/: {raw}"
    ))
}

/// Lightweight frontmatter + body split for an Obsidian note. We don't pull in
/// a full YAML parser — the frontmatter format is line-oriented `key: value`,
/// optionally with quoted strings. Lists are normalized to comma-joined.
#[derive(Debug, Default)]
struct AlexandriaNote {
    title: Option<String>,
    summary: Option<String>,
    embargo: Option<String>,
    body: String,
}

impl AlexandriaNote {
    fn parse(raw: &str) -> Self {
        let mut out = AlexandriaNote::default();
        let trimmed = raw.trim_start_matches('\u{FEFF}');

        if let Some(rest) = trimmed.strip_prefix("---") {
            // Find the closing `---` on its own line.
            let after_open = rest.trim_start_matches('\n');
            if let Some(end) = after_open.find("\n---") {
                let fm_block = &after_open[..end];
                let body_start = end + "\n---".len();
                out.body = after_open[body_start..]
                    .trim_start_matches('\n')
                    .to_string();
                for line in fm_block.lines() {
                    let line = line.trim();
                    if line.is_empty() || line.starts_with('#') {
                        continue;
                    }
                    if let Some((k, v)) = line.split_once(':') {
                        let key = k.trim();
                        let val = v
                            .trim()
                            .trim_matches('"')
                            .trim_matches('\'')
                            .to_string();
                        if val.is_empty() {
                            continue;
                        }
                        match key {
                            "title" => out.title = Some(val),
                            "summary" | "description" => out.summary = Some(val),
                            "embargo" => out.embargo = Some(val),
                            _ => {}
                        }
                    }
                }
                return out;
            }
        }

        // No frontmatter — whole file is body.
        out.body = trimmed.to_string();
        out
    }

    /// Derive a one-line "take" the generator can anchor to.
    /// Order: frontmatter `summary` → frontmatter `title` → first H1 → first
    /// non-empty paragraph (truncated to one sentence).
    fn derive_take(&self) -> Option<String> {
        if let Some(s) = &self.summary {
            return Some(s.clone());
        }
        if let Some(t) = &self.title {
            return Some(t.clone());
        }
        for line in self.body.lines() {
            let l = line.trim();
            if let Some(h1) = l.strip_prefix("# ") {
                return Some(h1.to_string());
            }
        }
        // First non-empty paragraph, first sentence (~200 chars cap).
        for para in self.body.split("\n\n") {
            let p = para.trim();
            if p.is_empty() {
                continue;
            }
            let one_sentence = p
                .split_once(['.', '!', '?'])
                .map(|(s, _)| s.to_string())
                .unwrap_or_else(|| p.to_string());
            let truncated: String = one_sentence.chars().take(200).collect();
            if !truncated.trim().is_empty() {
                return Some(truncated.trim().to_string());
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alexandria_note_parses_frontmatter_and_body() {
        let raw = "---\ntitle: \"AGC and the discovery engine\"\nsummary: Authenticity is now distribution.\ntags: [hormozi, ugc]\n---\n\n# AGC and the discovery engine\n\nThe merged feed throttles polished creative.\n";
        let n = AlexandriaNote::parse(raw);
        assert_eq!(n.title.as_deref(), Some("AGC and the discovery engine"));
        assert_eq!(n.summary.as_deref(), Some("Authenticity is now distribution."));
        assert!(n.body.starts_with("# AGC"));
    }

    #[test]
    fn alexandria_note_handles_no_frontmatter() {
        let raw = "# Just a heading\n\nA paragraph.\n";
        let n = AlexandriaNote::parse(raw);
        assert!(n.title.is_none());
        assert!(n.body.starts_with("# Just"));
    }

    #[test]
    fn derive_take_prefers_summary() {
        let n = AlexandriaNote {
            title: Some("title".into()),
            summary: Some("summary".into()),
            embargo: None,
            body: "# H1\n\nFirst paragraph.".into(),
        };
        assert_eq!(n.derive_take().as_deref(), Some("summary"));
    }

    #[test]
    fn derive_take_falls_back_to_title() {
        let n = AlexandriaNote {
            title: Some("the title".into()),
            summary: None,
            embargo: None,
            body: "".into(),
        };
        assert_eq!(n.derive_take().as_deref(), Some("the title"));
    }

    #[test]
    fn derive_take_falls_back_to_h1() {
        let n = AlexandriaNote {
            title: None,
            summary: None,
            embargo: None,
            body: "# A nice headline\n\nbody.".into(),
        };
        assert_eq!(n.derive_take().as_deref(), Some("A nice headline"));
    }

    #[test]
    fn derive_take_falls_back_to_first_sentence() {
        let n = AlexandriaNote {
            title: None,
            summary: None,
            embargo: None,
            body: "The merged feed throttles polished creative. Second sentence.".into(),
        };
        assert_eq!(
            n.derive_take().as_deref(),
            Some("The merged feed throttles polished creative")
        );
    }

    #[test]
    fn derive_take_returns_none_for_empty() {
        let n = AlexandriaNote::default();
        assert!(n.derive_take().is_none());
    }

    #[test]
    fn resolve_note_path_absolute() {
        let tmp = std::env::temp_dir();
        let f = tmp.join("rt-carousel-resolve-abs.md");
        std::fs::write(&f, "x").unwrap();
        let resolved = resolve_note_path(&PathBuf::from("/nope"), f.to_str().unwrap()).unwrap();
        assert_eq!(resolved, f);
        std::fs::remove_file(&f).ok();
    }

    #[test]
    fn resolve_note_path_vault_relative() {
        let tmp = std::env::temp_dir().join(format!("rt-resolve-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(tmp.join("Alexandria/Foo")).unwrap();
        let f = tmp.join("Alexandria/Foo/bar.md");
        std::fs::write(&f, "x").unwrap();

        let resolved = resolve_note_path(&tmp, "Alexandria/Foo/bar.md").unwrap();
        assert_eq!(resolved, f);

        // Also accepts the `Alexandria/`-stripped form.
        let resolved2 = resolve_note_path(&tmp, "Foo/bar.md").unwrap();
        assert_eq!(resolved2, f);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn resolve_note_path_errors_when_missing() {
        let tmp = std::env::temp_dir();
        let err = resolve_note_path(&tmp, "definitely-not-here-xyz.md").unwrap_err();
        assert!(err.to_string().contains("not found"));
    }
}
