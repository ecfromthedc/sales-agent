use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Weekly Content Brief intake — the 5 questions + optional metadata.
/// Mirrors carousel-weekly-brief.py block layout.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Intake {
    /// 1. Win of the Week — milestone + number, or "skip"
    pub win: Option<String>,

    /// 2. The Take — one-sentence operator take
    pub take: Option<String>,

    /// 3. The Insight — Alexandria/podcast/research + angle
    pub insight: Option<String>,

    /// 4. The Course Tease — module pick + framework
    pub course_tease: Option<String>,

    /// 5. The Contrarian — one-sentence pushback
    pub contrarian: Option<String>,

    /// Optional: Slack thread to post results back to
    pub thread_ts: Option<String>,

    /// Optional: source channel for the result post (default: brief channel)
    pub channel: Option<String>,

    /// Optional: voice guardrails for this batch (Block D — keep/ban phrasing)
    pub voice_notes: Option<String>,

    /// Optional: embargo flags
    pub embargo: Option<String>,
}

/// One drafted carousel concept, before rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CarouselDraft {
    pub slug: String,
    pub format: CarouselFormat,
    pub vol: u32,
    pub working_title: String,
    pub hook: SlideContent,
    pub build: Option<SlideContent>,
    pub payoff: Option<SlideContent>,
    pub cta: SlideContent,
    pub sources: Vec<SourceCitation>,
    /// Which intake field seeded this draft
    pub seed_field: SeedField,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum CarouselFormat {
    Editorial,
    Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum SeedField {
    Win,
    Take,
    Insight,
    CourseTease,
    Contrarian,
    AlexandriaSpawn,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlideContent {
    /// Display headline (uppercase, tight) — for hero slides
    pub headline: Option<String>,
    /// Serif lede / body
    pub lede: Option<String>,
    /// Word(s) that take the accent gradient — max 2 per slide
    pub accent_words: Vec<String>,
    /// Generation source: was this verbatim from Eric, or LLM-filled?
    pub origin: ContentOrigin,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ContentOrigin {
    Verbatim,
    LlmFilled,
    Templated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceCitation {
    pub label: String,
    pub kind: SourceKind,
    pub reference: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum SourceKind {
    CourseIndex,
    Alexandria,
    SlackDrop,
    CampaignData,
    EricExperience,
    Qualitative,
}

/// Response from POST /intake — the agent acknowledges receipt + returns a task id.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntakeResponse {
    pub task_id: Uuid,
    pub received_at: DateTime<Utc>,
    pub status: TaskStatus,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum TaskStatus {
    Accepted,
    Processing,
    Completed,
    Failed,
}

/// Final output bundle for a single generated carousel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationOutput {
    pub task_id: Uuid,
    pub draft: CarouselDraft,
    pub html_path: String,
    pub png_paths: Vec<String>,
    pub pdf_path: Option<String>,
    pub slack_message_ts: Option<String>,
    pub generated_at: DateTime<Utc>,
}
