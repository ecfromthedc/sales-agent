//! Hybrid generator: takes Eric's intake → emits CarouselDrafts via Claude API,
//! grounded in the course-index source registry + Alexandria semantic search.
//!
//! V1 strategy: one carousel per populated intake field. So 5 filled answers
//! → up to 5 drafts. Each one is a 4-slide Value carousel (Hook/Build/Payoff/CTA).
//! Editorial single-slide and verbatim-override modes land later.

use crate::claude_api::ClaudeClient;
use crate::config::Config;
use crate::sources::{AlexandriaHit, Claim, SourceIndex};
use crate::types::{
    CarouselDraft, CarouselFormat, ContentOrigin, Intake, SeedField, SlideContent, SourceCitation,
    SourceKind,
};
use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use slug::slugify;
use tracing::{debug, info, warn};

pub struct Generator<'a> {
    pub cfg: &'a Config,
    pub sources: &'a SourceIndex,
    pub claude: ClaudeClient,
}

impl<'a> Generator<'a> {
    pub fn new(cfg: &'a Config, sources: &'a SourceIndex) -> Result<Self> {
        let claude = ClaudeClient::from_config(cfg)?;
        Ok(Self {
            cfg,
            sources,
            claude,
        })
    }

    /// Walk the intake; for every populated seed field, draft one carousel.
    pub async fn draft_from_intake(&self, intake: &Intake) -> Result<Vec<CarouselDraft>> {
        let seeds: Vec<(SeedField, &str)> = [
            (SeedField::Win, intake.win.as_deref()),
            (SeedField::Take, intake.take.as_deref()),
            (SeedField::Insight, intake.insight.as_deref()),
            (SeedField::CourseTease, intake.course_tease.as_deref()),
            (SeedField::Contrarian, intake.contrarian.as_deref()),
        ]
        .into_iter()
        .filter_map(|(f, v)| {
            v.filter(|s| !s.trim().is_empty() && !s.trim().eq_ignore_ascii_case("skip"))
                .map(|s| (f, s))
        })
        .collect();

        if seeds.is_empty() {
            return Err(anyhow!("intake has no populated seed fields"));
        }

        info!(count = seeds.len(), "drafting carousels from seeds");

        let mut drafts = Vec::with_capacity(seeds.len());
        for (field, raw) in seeds {
            match self.draft_one(field, raw, intake).await {
                Ok(d) => drafts.push(d),
                Err(e) => {
                    warn!(?field, error = %e, "draft failed for seed; continuing");
                }
            }
        }

        if drafts.is_empty() {
            return Err(anyhow!("all seed drafts failed"));
        }

        Ok(drafts)
    }

    /// Draft one carousel from a single seed.
    pub async fn draft_one(
        &self,
        seed: SeedField,
        raw: &str,
        intake: &Intake,
    ) -> Result<CarouselDraft> {
        let relevant_claims = self.sources.find_by_keyword(raw);
        let alexandria_hits = self
            .sources
            .alexandria_search(raw)
            .await
            .unwrap_or_default();

        let voice_guard = intake.voice_notes.as_deref().unwrap_or("");
        let prompt = build_user_prompt(seed, raw, &relevant_claims, &alexandria_hits, voice_guard);
        let system = build_system_prompt(&self.sources.banned_phrases, &self.sources.voice_metaphors);

        debug!(?seed, claims_n = relevant_claims.len(), alex_n = alexandria_hits.len(), "generating");

        let raw_response = self.claude.complete(&system, &prompt).await?;
        let parsed: LlmDraft = extract_json(&raw_response)
            .with_context(|| format!("parsing LLM response: {}", truncate(&raw_response, 400)))?;

        // Banned-phrase lint
        for slide_text in [
            parsed.hook.headline.as_deref().unwrap_or(""),
            parsed.hook.lede.as_deref().unwrap_or(""),
            parsed.build.headline.as_deref().unwrap_or(""),
            parsed.build.lede.as_deref().unwrap_or(""),
            parsed.payoff.headline.as_deref().unwrap_or(""),
            parsed.payoff.lede.as_deref().unwrap_or(""),
            parsed.cta.headline.as_deref().unwrap_or(""),
            parsed.cta.lede.as_deref().unwrap_or(""),
        ] {
            if let Some(banned) = self.sources.contains_banned_phrase(slide_text) {
                warn!(banned, "draft contains banned phrase — flagging");
            }
        }

        Ok(parsed.into_draft(seed, raw))
    }
}

// ── prompt construction ───────────────────────────────────────────────────────

fn build_system_prompt(banned: &[String], metaphors: &[String]) -> String {
    let mut s = String::with_capacity(2000);
    s.push_str(
        "You are the Rising Tides Instagram social media manager, writing carousels for \
         @risingtides.ent (the music marketing agency page). Voice: THE MIDNIGHT PRESS — \
         dark newsprint, late edition. Magazine-cover declarative. Reporter at 2am.\n\n",
    );
    s.push_str("HARD RULES:\n");
    s.push_str("- Hook = 1 short declarative sentence, max 12 words, expresses tension. Never the payoff.\n");
    s.push_str("- Each slide max 1-2 accent_words (highlighted via gradient). Choose carefully.\n");
    s.push_str("- No emoji. No exclamation marks. No title case in display copy.\n");
    s.push_str("- Numbers ONLY from the provided sourced claims. Never invent a number.\n");
    s.push_str("- If you can't source a number, make the claim qualitative — never fabricate.\n");
    s.push_str("- CTA = low-friction tip-line ask (e.g. 'DM us a song', not 'learn more').\n\n");

    s.push_str("LIFT-READY METAPHORS (Eric's voice, use freely):\n");
    for m in metaphors.iter().take(15) {
        s.push_str(&format!("- {}\n", m));
    }
    s.push('\n');

    s.push_str("BANNED PHRASING (instant reject — do NOT generate any of these):\n");
    for b in banned.iter().take(20) {
        s.push_str(&format!("- {}\n", b));
    }
    s.push('\n');

    s.push_str(
        "OUTPUT FORMAT: return ONLY valid JSON, no prose, no markdown fences. \
         Schema:\n\
         {\n\
         \"working_title\": string,\n\
         \"hook\":   {\"headline\": string|null, \"lede\": string|null, \"accent_words\": [string]},\n\
         \"build\":  {\"headline\": string|null, \"lede\": string|null, \"accent_words\": [string]},\n\
         \"payoff\": {\"headline\": string|null, \"lede\": string|null, \"accent_words\": [string]},\n\
         \"cta\":    {\"headline\": string|null, \"lede\": string|null, \"accent_words\": [string]},\n\
         \"sources\": [string]\n\
         }\n",
    );
    s
}

fn build_user_prompt(
    seed: SeedField,
    raw: &str,
    relevant_claims: &[&Claim],
    alexandria_hits: &[AlexandriaHit],
    voice_guard: &str,
) -> String {
    let mut p = String::with_capacity(2000);
    p.push_str("Draft a 4-slide Value carousel (Hook → Build → Payoff → CTA) from this seed.\n\n");
    p.push_str(&format!("SEED FIELD: {seed:?}\n"));
    p.push_str(&format!("SEED VALUE (Eric's words, verbatim): \"{raw}\"\n\n"));

    if !relevant_claims.is_empty() {
        p.push_str("SOURCED CLAIMS YOU MAY USE (Course-Index §3 — these are real, vetted):\n");
        for c in relevant_claims.iter().take(8) {
            p.push_str(&format!("- [#{}] {} (source: {})\n", c.id, c.text, c.source));
        }
        p.push('\n');
    } else {
        p.push_str("SOURCED CLAIMS: (none matched this seed's keywords — keep numbers qualitative)\n\n");
    }

    if !alexandria_hits.is_empty() {
        p.push_str("ALEXANDRIA NOTES (semantic match, top hits — useful for context, cite by title):\n");
        for h in alexandria_hits.iter().take(5) {
            p.push_str(&format!("- [{:.1}%] {} — {}\n", h.similarity, h.title, h.path));
        }
        p.push('\n');
    }

    if !voice_guard.trim().is_empty() {
        p.push_str(&format!("VOICE GUARDRAILS FOR THIS BATCH: {voice_guard}\n\n"));
    }

    p.push_str("Generate the carousel. JSON only.\n");
    p
}

// ── LLM-output schema + parsing ───────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct LlmDraft {
    working_title: String,
    hook: LlmSlide,
    build: LlmSlide,
    payoff: LlmSlide,
    cta: LlmSlide,
    #[serde(default)]
    sources: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct LlmSlide {
    #[serde(default)]
    headline: Option<String>,
    #[serde(default)]
    lede: Option<String>,
    #[serde(default)]
    accent_words: Vec<String>,
}

impl LlmDraft {
    fn into_draft(self, seed: SeedField, raw: &str) -> CarouselDraft {
        let slug = slugify(&self.working_title);
        CarouselDraft {
            slug: if slug.is_empty() {
                format!("seed-{seed:?}").to_lowercase()
            } else {
                slug
            },
            format: CarouselFormat::Value,
            vol: 0, // assigned by render layer or caller
            working_title: self.working_title,
            hook: self.hook.into_slide_content(ContentOrigin::LlmFilled),
            build: Some(self.build.into_slide_content(ContentOrigin::LlmFilled)),
            payoff: Some(self.payoff.into_slide_content(ContentOrigin::LlmFilled)),
            cta: self.cta.into_slide_content(ContentOrigin::LlmFilled),
            sources: self
                .sources
                .into_iter()
                .map(|s| SourceCitation {
                    label: s,
                    kind: SourceKind::Qualitative, // refined in source-verification pass
                    reference: raw.to_string(),
                })
                .collect(),
            seed_field: seed,
        }
    }
}

impl LlmSlide {
    fn into_slide_content(self, origin: ContentOrigin) -> SlideContent {
        SlideContent {
            headline: self.headline,
            lede: self.lede,
            accent_words: self.accent_words,
            origin,
        }
    }
}

// ── JSON-from-LLM-text extraction ─────────────────────────────────────────────

/// Pulls the first {...} JSON block out of an LLM response, tolerating
/// stray prose, code-fence wrappers, or trailing commentary.
fn extract_json<T: for<'de> Deserialize<'de>>(raw: &str) -> Result<T> {
    let candidate = if let Some(stripped) = raw
        .trim()
        .strip_prefix("```json")
        .or_else(|| raw.trim().strip_prefix("```"))
    {
        stripped.trim_end_matches("```").trim()
    } else {
        raw.trim()
    };

    if let Ok(v) = serde_json::from_str::<T>(candidate) {
        return Ok(v);
    }

    // Fallback: find the first '{' and try to balance braces.
    let bytes = candidate.as_bytes();
    if let Some(start) = bytes.iter().position(|&b| b == b'{') {
        let mut depth = 0i32;
        let mut in_str = false;
        let mut escaped = false;
        for (i, &b) in bytes.iter().enumerate().skip(start) {
            if escaped {
                escaped = false;
                continue;
            }
            match b {
                b'\\' if in_str => escaped = true,
                b'"' => in_str = !in_str,
                b'{' if !in_str => depth += 1,
                b'}' if !in_str => {
                    depth -= 1;
                    if depth == 0 {
                        let slice = &candidate[start..=i];
                        return serde_json::from_str(slice).context("parsing balanced JSON slice");
                    }
                }
                _ => {}
            }
        }
    }

    Err(anyhow!("no JSON object found in LLM response"))
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Deserialize, PartialEq)]
    struct Hello {
        msg: String,
    }

    #[test]
    fn extracts_json_from_clean_response() {
        let raw = r#"{"msg": "hi"}"#;
        let v: Hello = extract_json(raw).unwrap();
        assert_eq!(v.msg, "hi");
    }

    #[test]
    fn extracts_json_from_fenced_response() {
        let raw = "```json\n{\"msg\": \"hi\"}\n```";
        let v: Hello = extract_json(raw).unwrap();
        assert_eq!(v.msg, "hi");
    }

    #[test]
    fn extracts_json_from_prose_with_prefix() {
        let raw = "Here is your draft:\n\n{\"msg\": \"hi\"}\n\nLet me know.";
        let v: Hello = extract_json(raw).unwrap();
        assert_eq!(v.msg, "hi");
    }
}
