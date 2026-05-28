//! Source verification — parses `course-index.md` §3 (claims registry) and §6 (voice notes),
//! exposes lookup by keyword, and queries Neo4j Alexandria for supporting notes.
//!
//! The §3 claims registry is the agent's hard verification floor: any number on any slide
//! must trace to a row in this table (or a real Slack drop / verified Alexandria entry).

use crate::config::Config;
use anyhow::{Context, Result};
use std::path::Path;
use std::process::Stdio;
use tokio::process::Command;
use tracing::{debug, warn};

/// The loaded course-index — the agent's canonical reference layer.
#[derive(Debug, Clone, Default)]
pub struct SourceIndex {
    pub claims: Vec<Claim>,
    pub banned_phrases: Vec<String>,
    pub voice_metaphors: Vec<String>,
}

/// One row from §3 — a sourced numeric or factual claim safe to put on a slide.
#[derive(Debug, Clone)]
pub struct Claim {
    pub id: u32,
    pub text: String,
    pub source: String,
}

/// One result from a Neo4j Alexandria semantic search.
#[derive(Debug, Clone)]
pub struct AlexandriaHit {
    pub similarity: f32,
    pub title: String,
    pub path: String,
}

impl SourceIndex {
    pub fn load(cfg: &Config) -> Result<Self> {
        let body = std::fs::read_to_string(&cfg.course_index_path)
            .with_context(|| format!("reading {}", cfg.course_index_path.display()))?;

        let claims = parse_claims(&body);
        let banned_phrases = parse_banned_phrases(&body);
        let voice_metaphors = parse_voice_metaphors(&body);

        debug!(
            claims = claims.len(),
            banned = banned_phrases.len(),
            metaphors = voice_metaphors.len(),
            "loaded source index"
        );

        Ok(Self {
            claims,
            banned_phrases,
            voice_metaphors,
        })
    }

    /// Returns claims whose text contains the given lowercased keyword.
    /// Cheap substring match — semantic match is the Alexandria layer.
    pub fn find_by_keyword(&self, keyword: &str) -> Vec<&Claim> {
        let needle = keyword.to_lowercase();
        self.claims
            .iter()
            .filter(|c| c.text.to_lowercase().contains(&needle))
            .collect()
    }

    /// Returns true if any banned phrase appears (case-insensitive) in the text.
    pub fn contains_banned_phrase(&self, text: &str) -> Option<&str> {
        let lower = text.to_lowercase();
        self.banned_phrases
            .iter()
            .find(|p| lower.contains(&p.to_lowercase()))
            .map(|s| s.as_str())
    }

    /// Semantic search against Neo4j Alexandria via the existing Python script.
    ///
    /// Spawns `python3 neo4j-alexandria.py search "<query>"` and parses the
    /// top-matches block. Returns up to 10 hits. Returns Ok(vec![]) on tooling
    /// failure rather than erroring, so generator can degrade gracefully.
    pub async fn alexandria_search(&self, query: &str) -> Result<Vec<AlexandriaHit>> {
        let script = Path::new("/Users/ericcromartie/Projects/active/rt-agents/neo4j-alexandria.py");
        if !script.exists() {
            warn!(?script, "neo4j-alexandria.py not found — skipping Alexandria search");
            return Ok(Vec::new());
        }

        let venv_python =
            Path::new("/Users/ericcromartie/Projects/active/rt-agents/.venv/bin/python3");
        let py = if venv_python.exists() {
            venv_python
        } else {
            Path::new("/opt/homebrew/bin/python3")
        };

        let output = Command::new(py)
            .arg(script)
            .arg("search")
            .arg(query)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
            .context("spawning neo4j-alexandria.py")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!(?stderr, "alexandria search subprocess returned non-zero");
            return Ok(Vec::new());
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(parse_alexandria_search(&stdout))
    }
}

// ── §3 claims-registry parser ─────────────────────────────────────────────────

fn parse_claims(body: &str) -> Vec<Claim> {
    // Find the claims-registry section, then collect table rows until the next heading.
    let Some(section_start) = body.find("## §3 — Claims & Stats Registry") else {
        warn!("course-index §3 not found");
        return Vec::new();
    };
    let after = &body[section_start..];
    let next_heading = after[1..]
        .find("\n## ")
        .map(|p| p + 1)
        .unwrap_or(after.len());
    let section = &after[..next_heading];

    let mut out = Vec::new();
    for line in section.lines() {
        let trimmed = line.trim();
        // Match rows that begin with `| <number> |`
        if !trimmed.starts_with("| ") {
            continue;
        }
        let cells: Vec<&str> = trimmed
            .trim_start_matches('|')
            .trim_end_matches('|')
            .split('|')
            .map(str::trim)
            .collect();
        if cells.len() < 3 {
            continue;
        }
        let Ok(id) = cells[0].parse::<u32>() else {
            continue;
        };
        let text = strip_md_emphasis(cells[1]);
        let source = strip_md_emphasis(cells[2]);
        out.push(Claim { id, text, source });
    }

    out
}

/// Drop `**bold**` and `*italic*` markers but keep the content.
fn strip_md_emphasis(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '*' {
            // skip one extra * if present (handles **)
            if chars.peek() == Some(&'*') {
                chars.next();
            }
            continue;
        }
        out.push(c);
    }
    out
}

// ── §6.3 banned-phrases parser ────────────────────────────────────────────────

fn parse_banned_phrases(body: &str) -> Vec<String> {
    let Some(section_start) = body.find("### 6.3 Banned phrasing") else {
        return Vec::new();
    };
    let after = &body[section_start..];
    let next_heading = after[1..]
        .find("\n### ")
        .map(|p| p + 1)
        .or_else(|| after.find("\n## "))
        .unwrap_or(after.len());
    let section = &after[..next_heading];

    section
        .lines()
        .filter_map(|line| {
            let t = line.trim();
            if let Some(rest) = t.strip_prefix("- ") {
                // Items are wrapped in italic markdown like *"phrase"*
                let inner = rest.trim_matches(|c: char| c == '*' || c == '"' || c == '_');
                if !inner.is_empty() && !inner.contains(':') {
                    Some(inner.trim().to_string())
                } else {
                    None
                }
            } else {
                None
            }
        })
        .collect()
}

// ── §6.1 metaphors parser ─────────────────────────────────────────────────────

fn parse_voice_metaphors(body: &str) -> Vec<String> {
    let Some(section_start) = body.find("### 6.1 Eric's repeating metaphors") else {
        return Vec::new();
    };
    let after = &body[section_start..];
    let next_heading = after[1..]
        .find("\n### ")
        .map(|p| p + 1)
        .unwrap_or(after.len());
    let section = &after[..next_heading];

    section
        .lines()
        .filter_map(|line| {
            let t = line.trim();
            if let Some(rest) = t.strip_prefix("- ") {
                let inner = rest.trim_matches(|c: char| c == '*' || c == '"' || c == '_');
                if !inner.is_empty() {
                    Some(inner.trim().to_string())
                } else {
                    None
                }
            } else {
                None
            }
        })
        .collect()
}

// ── neo4j-alexandria.py search output parser ──────────────────────────────────

fn parse_alexandria_search(stdout: &str) -> Vec<AlexandriaHit> {
    // Format:
    //   [82.5%] Title-Of-Note
    //          Path/To/Note.md
    let mut hits = Vec::new();
    let mut lines = stdout.lines().peekable();
    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix('[') else {
            continue;
        };
        let Some(close) = rest.find("%]") else {
            continue;
        };
        let Ok(similarity) = rest[..close].trim().parse::<f32>() else {
            continue;
        };
        let title = rest[close + 2..].trim().to_string();
        let path = lines.next().map(|l| l.trim().to_string()).unwrap_or_default();
        hits.push(AlexandriaHit {
            similarity,
            title,
            path,
        });
    }
    hits
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_emphasis_markers() {
        assert_eq!(strip_md_emphasis("**bold** and *italic*"), "bold and italic");
        assert_eq!(strip_md_emphasis("plain text"), "plain text");
    }

    #[test]
    fn parses_a_simple_claim_row() {
        let body = "\
## §3 — Claims & Stats Registry

| # | Claim | Source |
|---|---|---|
| 1 | Mon Rovia: 5K IG → ~1M | Course Index (Module 1) |
| 8 | Gregory Alan Isakov **Sweet Heat Lightning**: 1K → 1.5M | Module 1 |

## §4 — Next
";
        let claims = parse_claims(body);
        assert_eq!(claims.len(), 2);
        assert_eq!(claims[0].id, 1);
        assert!(claims[0].text.contains("Mon Rovia"));
        assert_eq!(claims[1].id, 8);
        assert!(claims[1].text.contains("Sweet Heat Lightning"));
    }

    #[test]
    fn parses_alexandria_search_output() {
        let stdout = "\
Searching: test query

Top matches (semantic similarity):
--------------------------------------------------
  [82.5%] Module-1-Mindset-Vision-Sound-Optimization
         Alexandria/Content Strategy/RT-Viral-Course/Module-1-Mindset-Vision-Sound-Optimization.md
  [80.8%] 00-INDEX
         Alexandria/Content Strategy/RT-Viral-Course/00-INDEX.md
";
        let hits = parse_alexandria_search(stdout);
        assert_eq!(hits.len(), 2);
        assert!((hits[0].similarity - 82.5).abs() < 0.01);
        assert_eq!(hits[0].title, "Module-1-Mindset-Vision-Sound-Optimization");
        assert!(hits[1].path.contains("00-INDEX.md"));
    }
}
