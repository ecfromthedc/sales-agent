//! Anthropic Claude API client. Used by the hybrid generator to fill gaps
//! in Eric's intake (drafting Hook / Build / Payoff / CTA when fields are blank).
//!
//! Reads ANTHROPIC_API_KEY from env. Model is configurable via
//! RT_CAROUSEL_MODEL (default: claude-sonnet-4-6).

use crate::config::Config;
use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tracing::{debug, info};

const ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const DEFAULT_MODEL: &str = "claude-sonnet-4-6";

pub struct ClaudeClient {
    api_key: String,
    model: String,
    http: Client,
}

impl ClaudeClient {
    pub fn from_config(cfg: &Config) -> Result<Self> {
        let api_key = cfg.anthropic_api_key.clone().ok_or_else(|| {
            anyhow!(
                "ANTHROPIC_API_KEY unset — required for LLM gap-filling. \
                 Set in env or in ~/.cortextos/default/carousel-agent.env"
            )
        })?;
        let model = std::env::var("RT_CAROUSEL_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string());
        let http = Client::builder()
            .timeout(Duration::from_secs(90))
            .build()
            .context("building reqwest client")?;
        Ok(Self {
            api_key,
            model,
            http,
        })
    }

    /// Send a system + user message, return the assistant's text content.
    pub async fn complete(&self, system: &str, user: &str) -> Result<String> {
        let body = Request {
            model: self.model.as_str(),
            max_tokens: 2048,
            system,
            messages: vec![Message {
                role: "user",
                content: user,
            }],
        };

        debug!(
            model = %self.model,
            system_len = system.len(),
            user_len = user.len(),
            "claude API call"
        );

        let resp = self
            .http
            .post(ENDPOINT)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .context("posting to anthropic api")?;

        let status = resp.status();
        let raw = resp.text().await.context("reading anthropic response body")?;

        if !status.is_success() {
            return Err(anyhow!(
                "anthropic api returned {}: {}",
                status,
                truncate(&raw, 500)
            ));
        }

        let parsed: Response = serde_json::from_str(&raw)
            .with_context(|| format!("parsing anthropic response: {}", truncate(&raw, 500)))?;

        let text = parsed
            .content
            .into_iter()
            .filter(|b| b.kind == "text")
            .map(|b| b.text.unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n");

        info!(
            model = %self.model,
            input_tokens = parsed.usage.input_tokens,
            output_tokens = parsed.usage.output_tokens,
            "claude completion received"
        );

        Ok(text)
    }
}

// ── Request / response schemas ────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct Request<'a> {
    model: &'a str,
    max_tokens: u32,
    system: &'a str,
    messages: Vec<Message<'a>>,
}

#[derive(Debug, Serialize)]
struct Message<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Debug, Deserialize)]
struct Response {
    #[serde(default)]
    content: Vec<ContentBlock>,
    usage: Usage,
}

#[derive(Debug, Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct Usage {
    #[serde(default)]
    input_tokens: u32,
    #[serde(default)]
    output_tokens: u32,
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…[+{} chars]", &s[..max], s.len() - max)
    }
}
