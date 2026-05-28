use anyhow::{Context, Result};
use std::env;
use std::path::PathBuf;

/// Runtime configuration loaded from env + .env files.
#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: String,
    pub repo_root: PathBuf,
    pub pocket_index_path: PathBuf,
    pub anthropic_api_key: Option<String>,
    pub slack_bot_token: Option<String>,
    pub slack_signing_secret: Option<String>,
    pub default_slack_channel: String,
    pub neo4j_search_endpoint: Option<String>,
    pub course_index_path: PathBuf,
    pub log_level: String,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        // Load .env files (best-effort). Order matters — first hit wins per var.
        let _ = dotenvy::dotenv();
        for rel in [
            ".cortextos/default/carousel-agent.env", // dedicated, preferred for ANTHROPIC_API_KEY
            ".cortextos/default/eric-claude-bot.env", // shared SLACK_BOT_TOKEN
        ] {
            if let Some(p) = dirs::home_dir().map(|h| h.join(rel)).filter(|p| p.exists()) {
                let _ = dotenvy::from_path(&p);
            }
        }

        let repo_root = repo_root_default()?;
        let pocket_index_path = match env::var("RT_POCKET_INDEX") {
            Ok(p) => PathBuf::from(p),
            Err(_) => dirs::home_dir()
                .context("HOME unset")?
                .join("Projects/active/rt-pocket/index.html"),
        };

        Ok(Self {
            bind_addr: env::var("RT_CAROUSEL_BIND").unwrap_or_else(|_| "127.0.0.1:7677".to_string()),
            repo_root: repo_root.clone(),
            pocket_index_path,
            anthropic_api_key: env::var("ANTHROPIC_API_KEY").ok(),
            slack_bot_token: env::var("SLACK_BOT_TOKEN").ok(),
            slack_signing_secret: env::var("SLACK_SIGNING_SECRET").ok(),
            default_slack_channel: env::var("RT_CAROUSEL_SLACK_CHANNEL")
                .unwrap_or_else(|_| "C0B5X88QQ0K".to_string()),
            neo4j_search_endpoint: env::var("RT_NEO4J_SEARCH_ENDPOINT").ok(),
            course_index_path: repo_root.join("course-index.md"),
            log_level: env::var("RUST_LOG").unwrap_or_else(|_| "info,rt_carousel_agent=debug".to_string()),
        })
    }
}

fn repo_root_default() -> Result<PathBuf> {
    if let Ok(env_val) = env::var("RT_CAROUSEL_REPO") {
        return Ok(PathBuf::from(env_val));
    }
    let home = dirs::home_dir().context("HOME unset")?;
    Ok(home.join("Documents/Development/carousels-agent"))
}
