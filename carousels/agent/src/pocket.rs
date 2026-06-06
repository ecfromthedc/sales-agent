//! RT Pocket inline integration.
//!
//! Pocket is a single-file Telegram Mini App backed by `index.html`. Visual
//! artifacts live as `<script type="text/html" id="panel-{slug}">` blocks that
//! the in-page router loads into an iframe via `srcdoc`. All edits happen in
//! ONE file — sibling HTML files 404 through the Cloudflare tunnel.
//!
//! This module performs idempotent upserts:
//!   1. Replaces or appends the panel block for `panel-carousel-{slug}`.
//!   2. Replaces or appends the home-drawer card for `data-panel="carousel-{slug}"`.
//!   3. Bumps `version.txt` so the phone hot-reloads within ~2 seconds.

use crate::config::Config;
use crate::render::Renderer;
use crate::types::{CarouselDraft, CarouselFormat, SeedField};
use anyhow::{anyhow, Context, Result};
use chrono::Local;
use std::path::PathBuf;

const PANEL_INSERTION_MARKER: &str = "</body>";
const CARD_INSERTION_MARKER: &str = "<!-- SHARE -->";

pub struct PocketInliner<'a> {
    cfg: &'a Config,
    renderer: Renderer,
}

#[derive(Debug, Clone)]
pub struct PocketInsertResult {
    pub slug: String,
    pub hash: String,
    pub version: String,
    pub action: PocketAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PocketAction {
    Inserted,
    Updated,
}

impl<'a> PocketInliner<'a> {
    pub fn new(cfg: &'a Config) -> Self {
        Self {
            cfg,
            renderer: Renderer::new(cfg.repo_root.clone()),
        }
    }

    /// Idempotently inline a carousel draft as a Pocket panel + drawer card.
    /// Bumps `version.txt`. Returns the resolved slug, hash, and new version.
    pub fn inline_carousel(&self, draft: &CarouselDraft) -> Result<PocketInsertResult> {
        let index_path = &self.cfg.pocket_index_path;
        if !index_path.exists() {
            return Err(anyhow!(
                "RT Pocket index.html not found at {} — skipping inline",
                index_path.display()
            ));
        }
        let version_path = version_path_for(index_path)?;

        let panel_slug = format!("carousel-{}", draft.slug);
        let panel_id = format!("panel-{panel_slug}");
        let hash = format!("#{panel_slug}");

        let panel_body = self.renderer.to_html(draft)?;
        let panel_block = build_panel_block(&panel_id, &panel_title(draft), &panel_body);
        let card_html = build_drawer_card(&panel_slug, draft);

        let mut content = std::fs::read_to_string(index_path)
            .with_context(|| format!("read {}", index_path.display()))?;

        let panel_action = upsert_panel(&mut content, &panel_id, &panel_block)?;
        let card_action = upsert_drawer_card(&mut content, &panel_slug, &card_html)?;

        std::fs::write(index_path, &content)
            .with_context(|| format!("write {}", index_path.display()))?;

        let version = bump_version(&version_path)?;

        Ok(PocketInsertResult {
            slug: panel_slug,
            hash,
            version,
            action: if panel_action == PocketAction::Updated
                || card_action == PocketAction::Updated
            {
                PocketAction::Updated
            } else {
                PocketAction::Inserted
            },
        })
    }
}

fn version_path_for(index_path: &std::path::Path) -> Result<PathBuf> {
    index_path
        .parent()
        .map(|p| p.join("version.txt"))
        .ok_or_else(|| anyhow!("cannot derive version.txt path from {}", index_path.display()))
}

fn panel_title(draft: &CarouselDraft) -> String {
    let kind = match draft.format {
        CarouselFormat::Editorial => "Editorial",
        CarouselFormat::Value => "Value",
    };
    format!("Vol. {:02} · {} — {}", draft.vol, kind, draft.working_title)
}

fn build_panel_block(panel_id: &str, title: &str, body_html: &str) -> String {
    // Defensive: any literal `</script>` in the body would terminate the
    // wrapping <script type="text/html"> tag early. Escape conservatively.
    let safe_body = body_html.replace("</script>", "<\\/script>");
    let title_attr = title.replace('"', "&quot;");
    format!(
        "  <script type=\"text/html\" id=\"{panel_id}\" data-title=\"{title_attr}\">\n{safe_body}\n  </script>\n"
    )
}

fn build_drawer_card(panel_slug: &str, draft: &CarouselDraft) -> String {
    let kind_word = match draft.format {
        CarouselFormat::Editorial => "Editorial",
        CarouselFormat::Value => "Value carousel",
    };
    let slide_count = match draft.format {
        CarouselFormat::Editorial => 1,
        CarouselFormat::Value => {
            1 + draft.build.is_some() as usize + draft.payoff.is_some() as usize + 1
        }
    };
    let plural = if slide_count == 1 { "" } else { "s" };
    let title = escape_attr(&draft.working_title);
    let seed = seed_label(draft.seed_field);

    format!(
        "    <a class=\"card-link\" href=\"#{panel_slug}\" data-panel=\"{panel_slug}\">\n      <div class=\"card\">\n        <h3>Vol. {vol:02} <span class=\"chev\">›</span></h3>\n        <p class=\"big\">{title}</p>\n        <p class=\"sub\">{kind_word} · {slide_count} slide{plural} · seed: {seed}</p>\n      </div>\n    </a>\n",
        vol = draft.vol,
    )
}

fn upsert_panel(content: &mut String, panel_id: &str, new_block: &str) -> Result<PocketAction> {
    let needle = format!("<script type=\"text/html\" id=\"{panel_id}\"");
    if let Some(start) = content.find(&needle) {
        let after_start = &content[start..];
        let end_rel = after_start
            .find("</script>")
            .ok_or_else(|| anyhow!("unterminated panel block for {panel_id}"))?;
        let end_abs = start + end_rel + "</script>".len();

        // Strip leading indentation of the existing block so the replacement
        // re-indents cleanly.
        let line_start = content[..start].rfind('\n').map(|i| i + 1).unwrap_or(0);
        // Consume trailing newline after </script> if present so repeated
        // upserts don't accumulate blank lines.
        let trim_end = if content.as_bytes().get(end_abs) == Some(&b'\n') {
            end_abs + 1
        } else {
            end_abs
        };
        content.replace_range(line_start..trim_end, new_block);
        Ok(PocketAction::Updated)
    } else {
        let insertion_point = content
            .find(PANEL_INSERTION_MARKER)
            .ok_or_else(|| anyhow!("missing </body> sentinel in Pocket index"))?;
        content.insert_str(insertion_point, &format!("{new_block}\n"));
        Ok(PocketAction::Inserted)
    }
}

fn upsert_drawer_card(
    content: &mut String,
    panel_slug: &str,
    new_card: &str,
) -> Result<PocketAction> {
    let needle = format!("data-panel=\"{panel_slug}\"");
    if let Some(needle_pos) = content.find(&needle) {
        let anchor_start = content[..needle_pos]
            .rfind("<a class=\"card-link\"")
            .ok_or_else(|| anyhow!("found data-panel but no enclosing card anchor"))?;
        let line_start = content[..anchor_start]
            .rfind('\n')
            .map(|i| i + 1)
            .unwrap_or(0);
        let close_rel = content[needle_pos..]
            .find("</a>")
            .ok_or_else(|| anyhow!("unterminated drawer card for {panel_slug}"))?;
        let end_abs = needle_pos + close_rel + "</a>".len();
        let trim_end = if content.as_bytes().get(end_abs) == Some(&b'\n') {
            end_abs + 1
        } else {
            end_abs
        };
        content.replace_range(line_start..trim_end, new_card);
        Ok(PocketAction::Updated)
    } else {
        let insertion_point = content
            .find(CARD_INSERTION_MARKER)
            .ok_or_else(|| anyhow!("missing <!-- SHARE --> sentinel in Pocket index"))?;
        let line_start = content[..insertion_point]
            .rfind('\n')
            .map(|i| i + 1)
            .unwrap_or(0);
        content.insert_str(line_start, new_card);
        Ok(PocketAction::Inserted)
    }
}

fn bump_version(version_path: &std::path::Path) -> Result<String> {
    let today = Local::now().format("%Y-%m-%d").to_string();
    let current = std::fs::read_to_string(version_path).unwrap_or_default();
    let trimmed = current.trim();
    let next_n: u32 = trimmed
        .strip_prefix(&format!("{today}-"))
        .and_then(|s| s.parse::<u32>().ok())
        .map(|n| n + 1)
        .unwrap_or(1);
    let next = format!("{today}-{next_n:03}");
    std::fs::write(version_path, &next)
        .with_context(|| format!("write version.txt at {}", version_path.display()))?;
    Ok(next)
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn seed_label(seed: SeedField) -> &'static str {
    match seed {
        SeedField::Win => "win",
        SeedField::Take => "take",
        SeedField::Insight => "insight",
        SeedField::CourseTease => "course tease",
        SeedField::Contrarian => "contrarian",
        SeedField::AlexandriaSpawn => "alexandria spawn",
        SeedField::Manual => "manual",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ContentOrigin, SlideContent, SourceCitation, SourceKind};

    fn skeleton(extra_in_body: &str) -> String {
        format!(
            "<html><body>\n<main>\n<!-- SHARE -->\n<button>x</button>\n</main>\n{extra_in_body}</body></html>\n"
        )
    }

    fn slide(headline: &str) -> SlideContent {
        SlideContent {
            headline: Some(headline.into()),
            lede: None,
            accent_words: vec![],
            origin: ContentOrigin::LlmFilled,
        }
    }

    fn fake_draft() -> CarouselDraft {
        CarouselDraft {
            slug: "smoke-test".into(),
            format: CarouselFormat::Value,
            vol: 9,
            working_title: "Smoke test".into(),
            hook: slide("Hook headline"),
            build: None,
            payoff: None,
            cta: slide("CTA headline"),
            sources: vec![SourceCitation {
                label: "test".into(),
                kind: SourceKind::Qualitative,
                reference: "n/a".into(),
            }],
            seed_field: SeedField::Manual,
        }
    }

    #[test]
    fn upsert_panel_inserts_block_when_missing() {
        let mut content = skeleton("");
        let action = upsert_panel(
            &mut content,
            "panel-carousel-foo",
            "  <script>foo</script>\n",
        )
        .unwrap();
        assert_eq!(action, PocketAction::Inserted);
        assert!(content.contains("<script>foo</script>"));
        let body_close = content.find("</body>").unwrap();
        let block_pos = content.find("<script>foo").unwrap();
        assert!(block_pos < body_close);
    }

    #[test]
    fn upsert_panel_replaces_block_when_present_idempotently() {
        let mut content = skeleton(
            "  <script type=\"text/html\" id=\"panel-carousel-foo\" data-title=\"old\">OLD</script>\n",
        );
        let action = upsert_panel(
            &mut content,
            "panel-carousel-foo",
            "  <script type=\"text/html\" id=\"panel-carousel-foo\" data-title=\"new\">NEW</script>\n",
        )
        .unwrap();
        assert_eq!(action, PocketAction::Updated);
        assert!(content.contains("data-title=\"new\""));
        assert!(content.contains(">NEW<"));
        assert!(!content.contains(">OLD<"));
        // Idempotent: re-apply same upsert, count stays at 1.
        let _ = upsert_panel(
            &mut content,
            "panel-carousel-foo",
            "  <script type=\"text/html\" id=\"panel-carousel-foo\" data-title=\"new\">NEW</script>\n",
        )
        .unwrap();
        assert_eq!(content.matches("id=\"panel-carousel-foo\"").count(), 1);
    }

    #[test]
    fn upsert_drawer_card_inserts_before_share_marker() {
        let mut content = skeleton("");
        let card = "    <a class=\"card-link\" href=\"#carousel-foo\" data-panel=\"carousel-foo\"><div class=\"card\"><h3>Vol 9</h3></div></a>\n";
        let action = upsert_drawer_card(&mut content, "carousel-foo", card).unwrap();
        assert_eq!(action, PocketAction::Inserted);
        let card_pos = content.find("data-panel=\"carousel-foo\"").unwrap();
        let share_pos = content.find("<!-- SHARE -->").unwrap();
        assert!(card_pos < share_pos);
    }

    #[test]
    fn upsert_drawer_card_replaces_existing_card() {
        let mut content = skeleton("").replace(
            "<!-- SHARE -->",
            "    <a class=\"card-link\" href=\"#carousel-foo\" data-panel=\"carousel-foo\"><div class=\"card\"><h3>OLD</h3></div></a>\n    <!-- SHARE -->",
        );
        let new_card = "    <a class=\"card-link\" href=\"#carousel-foo\" data-panel=\"carousel-foo\"><div class=\"card\"><h3>NEW</h3></div></a>\n";
        let action = upsert_drawer_card(&mut content, "carousel-foo", new_card).unwrap();
        assert_eq!(action, PocketAction::Updated);
        assert!(content.contains(">NEW<"));
        assert!(!content.contains(">OLD<"));
        assert_eq!(
            content.matches("data-panel=\"carousel-foo\"").count(),
            1
        );
    }

    #[test]
    fn build_panel_block_escapes_inner_closing_script_tags() {
        let block = build_panel_block(
            "panel-carousel-x",
            "Title",
            "<html><body><script>alert(1)</script></body></html>",
        );
        assert!(!block.contains("alert(1)</script></body>"));
        assert!(block.contains("<\\/script></body>"));
        assert!(block.starts_with("  <script type=\"text/html\" id=\"panel-carousel-x\""));
        assert!(block.trim_end().ends_with("</script>"));
    }

    #[test]
    fn build_panel_block_escapes_double_quotes_in_title() {
        let block = build_panel_block("panel-x", "She said \"hi\"", "<html></html>");
        assert!(block.contains("data-title=\"She said &quot;hi&quot;\""));
    }

    #[test]
    fn build_drawer_card_renders_volume_title_and_seed() {
        let draft = fake_draft();
        let card = build_drawer_card("carousel-smoke-test", &draft);
        assert!(card.contains("href=\"#carousel-smoke-test\""));
        assert!(card.contains("data-panel=\"carousel-smoke-test\""));
        assert!(card.contains("Vol. 09"));
        assert!(card.contains("Smoke test"));
        assert!(card.contains("2 slides"));
        assert!(card.contains("seed: manual"));
        assert!(card.contains("Value carousel"));
    }

    #[test]
    fn build_drawer_card_singular_slide_for_editorial() {
        let mut d = fake_draft();
        d.format = CarouselFormat::Editorial;
        let card = build_drawer_card("carousel-x", &d);
        assert!(card.contains("1 slide ·"));
        assert!(card.contains("Editorial · 1 slide"));
        assert!(!card.contains("1 slides"));
    }

    #[test]
    fn bump_version_increments_same_day_counter() {
        let dir = tempdir_simple();
        let path = dir.join("version.txt");
        let today = Local::now().format("%Y-%m-%d").to_string();
        std::fs::write(&path, format!("{today}-006")).unwrap();
        let v = bump_version(&path).unwrap();
        assert_eq!(v, format!("{today}-007"));
        let v2 = bump_version(&path).unwrap();
        assert_eq!(v2, format!("{today}-008"));
    }

    #[test]
    fn bump_version_resets_to_001_on_new_day() {
        let dir = tempdir_simple();
        let path = dir.join("version.txt");
        std::fs::write(&path, "1999-01-01-099").unwrap();
        let v = bump_version(&path).unwrap();
        let today = Local::now().format("%Y-%m-%d").to_string();
        assert_eq!(v, format!("{today}-001"));
    }

    #[test]
    fn bump_version_handles_missing_file() {
        let dir = tempdir_simple();
        let path = dir.join("nonexistent.txt");
        let v = bump_version(&path).unwrap();
        let today = Local::now().format("%Y-%m-%d").to_string();
        assert_eq!(v, format!("{today}-001"));
        assert!(path.exists());
    }

    fn tempdir_simple() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "rt-pocket-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}
