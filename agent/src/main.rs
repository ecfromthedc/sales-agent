//! rt-carousel-agent — Rising Tides carousel generation agent
//!
//! HTTP service that takes a Weekly Content Brief intake (5 answers from Eric)
//! and emits Midnight Press carousels: HTML previews, 1080×1350 PNGs, and PDFs.
//!
//! Phase 1 — POST /intake → generator pipeline (background task).
//! Phase 2 — MCP interface, Slack Socket Mode, natural-phrase trigger,
//!           Alexandria-spawn endpoint.
//!
//! Endpoints:
//!   GET  /health                 — liveness probe
//!   POST /intake                 — submit a brief intake; pipeline runs in background
//!   POST /slack/slash-command    — Slack slash-command trigger (`/carousel-build <topic>`)
//!   POST /alexandria-spawn       — spawn a carousel from an Alexandria note (Phase 2)

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json},
    routing::{get, post},
    Router,
};
use chrono::Utc;
use std::sync::Arc;
use tower_http::trace::TraceLayer;
use tracing::{error, info, warn};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};
use uuid::Uuid;

use rt_carousel_agent::config::Config;
use rt_carousel_agent::generator::Generator;
use rt_carousel_agent::pocket::PocketInliner;
use rt_carousel_agent::render::Renderer;
use rt_carousel_agent::slack::{verify_slack_signature, SlackClient, SlashCommand};
use rt_carousel_agent::sources::SourceIndex;
use rt_carousel_agent::types::{Intake, IntakeResponse, TaskStatus};

/// Shared state across all handlers.
struct AppState {
    cfg: Config,
    sources: SourceIndex,
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

    if cfg.anthropic_api_key.is_none() {
        warn!("ANTHROPIC_API_KEY unset — LLM gap-filling will fail until set");
    }
    if cfg.slack_bot_token.is_none() {
        warn!("SLACK_BOT_TOKEN unset — Slack file uploads will fail until set");
    }

    let sources = SourceIndex::load(&cfg)?;
    info!(
        claims = sources.claims.len(),
        banned = sources.banned_phrases.len(),
        metaphors = sources.voice_metaphors.len(),
        "loaded source index"
    );

    let state = Arc::new(AppState {
        cfg: cfg.clone(),
        sources,
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/intake", post(intake_handler))
        .route("/slack/slash-command", post(slash_command_handler))
        .route("/alexandria-spawn", post(alexandria_spawn_handler))
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
        "default_channel": state.cfg.default_slack_channel,
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

    let pipeline_state = Arc::clone(&state);
    let pipeline_intake = intake.clone();
    tokio::spawn(async move {
        if let Err(e) = run_pipeline(task_id, pipeline_state, pipeline_intake).await {
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

/// Background pipeline: source-check → generate → render → screenshot → Slack upload.
/// Phase 1 implements parse + generate. Render/screenshot/upload land in tasks #13–#17.
async fn run_pipeline(
    task_id: Uuid,
    state: Arc<AppState>,
    intake: Intake,
) -> anyhow::Result<()> {
    info!(?task_id, "pipeline: building generator");
    let generator = Generator::new(&state.cfg, &state.sources)?;

    info!(?task_id, "pipeline: drafting from intake");
    let drafts = generator.draft_from_intake(&intake).await?;

    info!(?task_id, n = drafts.len(), "pipeline: drafts produced");

    info!(?task_id, "pipeline: rendering HTML previews + PNG slides");
    let renderer = Renderer::new(state.cfg.repo_root.clone());
    let slack = SlackClient::new(&state.cfg);
    let pocket = PocketInliner::new(&state.cfg);
    let target_channel = intake
        .channel
        .clone()
        .unwrap_or_else(|| state.cfg.default_slack_channel.clone());
    let thread_ts = intake.thread_ts.as_deref();
    let slack_enabled = state.cfg.slack_bot_token.is_some();

    for d in &drafts {
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
                .upload_carousel_draft(d, &pngs, &target_channel, thread_ts)
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

/// POST /slack/slash-command — Slack-triggered carousel build.
///
/// Slack wires `/carousel-build <topic>` to a public URL pointing at this
/// endpoint. We verify the request signature, ack within 3 seconds (Slack's
/// hard timeout), and run the same `run_pipeline` in the background so the
/// PNGs and Pocket panel land asynchronously.
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
        "slash command accepted — spawning pipeline"
    );

    let pipeline_state = Arc::clone(&state);
    let pipeline_intake = intake.clone();
    tokio::spawn(async move {
        if let Err(e) = run_pipeline(task_id, pipeline_state, pipeline_intake).await {
            error!(?task_id, error = %e, "pipeline failed");
        }
    });

    // Acknowledge within Slack's 3-second window. `response_type: in_channel`
    // posts the ack so anyone in the channel sees the agent is working.
    Ok(Json(serde_json::json!({
        "response_type": "in_channel",
        "text": format!(
            ":carousel_horse: working on a draft from `{}`. PNGs will land here when ready.",
            cmd.text.replace('`', "'")
        ),
    })))
}

/// POST /alexandria-spawn — generate a carousel from a new Alexandria note. Phase 2.
async fn alexandria_spawn_handler() -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    Err((
        StatusCode::NOT_IMPLEMENTED,
        "alexandria-spawn pending (task #22)".to_string(),
    ))
}
