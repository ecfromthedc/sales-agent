//! Midnight Press HTML renderer.
//!
//! Task #13 — produces self-contained HTML per `CarouselDraft`. Each artboard
//! is 1080x1350 at full resolution and scaled into a preview shell. No external
//! CSS references; styles + Google Fonts are inlined so the output works
//! standalone in a browser AND when embedded in RT Pocket via `srcdoc`.
//!
//! PNG screenshot (#14) and PDF bundling (#15) remain stubs below.

use crate::types::{CarouselDraft, CarouselFormat, SeedField, SlideContent};
use anyhow::{anyhow, Context, Result};
use base64::Engine as _;
use headless_chrome::protocol::cdp::Emulation;
use headless_chrome::protocol::cdp::Page::{
    CaptureScreenshot, CaptureScreenshotFormatOption, Viewport,
};
use headless_chrome::{Browser, LaunchOptions};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

/// Native slide dimensions in CSS pixels.
const SLIDE_W: u32 = 1080;
const SLIDE_H: u32 = 1350;

const STYLES: &str = include_str!("../templates/midnight-press.css");
const MAX_ACCENT_WORDS_PER_SLIDE: usize = 2;

/// Rendering mode — preview embeds slides inside scaled `.shell` divs for
/// in-browser eyeballing; export emits slides at native 1080x1350 for PNG
/// screenshotting.
#[derive(Clone, Copy, PartialEq, Eq)]
enum RenderMode {
    Preview,
    Export,
}

pub struct Renderer {
    pub repo_root: PathBuf,
}

impl Renderer {
    pub fn new(repo_root: PathBuf) -> Self {
        Self { repo_root }
    }

    /// Render a draft to self-contained preview HTML (scaled `.shell` grid).
    pub fn to_html(&self, draft: &CarouselDraft) -> Result<String> {
        self.render(draft, RenderMode::Preview)
    }

    /// Render a draft to self-contained export HTML — slides at native
    /// 1080x1350 for headless-Chrome screenshotting.
    pub fn to_export_html(&self, draft: &CarouselDraft) -> Result<String> {
        self.render(draft, RenderMode::Export)
    }

    fn render(&self, draft: &CarouselDraft, mode: RenderMode) -> Result<String> {
        validate_draft(draft)?;
        let slides = build_slide_list(draft);
        let bloom = pick_bloom(&draft.slug);
        let total = slides.len();

        let mut sections = String::new();
        for (idx, slide) in slides.iter().enumerate() {
            let n = idx + 1;
            let section = render_slide_section(draft, slide, n, total, bloom, mode)?;
            sections.push_str(&section);
            sections.push('\n');
        }

        let title = format!(
            "RT Carousel — {} (vol. {:02})",
            esc(&draft.working_title),
            draft.vol
        );

        let mut html = String::with_capacity(8192);
        html.push_str("<!doctype html>\n");
        html.push_str("<html lang=\"en\">\n<head>\n");
        html.push_str("  <meta charset=\"UTF-8\" />\n");
        html.push_str("  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n");
        let _ = writeln!(html, "  <title>{title}</title>");
        html.push_str("  <style>\n");
        html.push_str(STYLES);
        html.push_str("\n  </style>\n");
        html.push_str("</head>\n");

        match mode {
            RenderMode::Preview => {
                html.push_str("<body>\n");
                let format_label = match draft.format {
                    CarouselFormat::Editorial => "editorial (single slide)",
                    CarouselFormat::Value => "value carousel",
                };
                let seed_label = seed_label(draft.seed_field);
                let _ = writeln!(
                    html,
                    "  <h1 class=\"page-title\">{} · vol. {:02}</h1>",
                    esc(&draft.working_title),
                    draft.vol
                );
                let _ = writeln!(
                    html,
                    "  <p class=\"page-meta\">{format_label} · seed: {seed_label} · {total} slide{plural}</p>",
                    plural = if total == 1 { "" } else { "s" }
                );
                html.push_str("  <div class=\"grid\">\n");
                html.push_str(&sections);
                html.push_str("  </div>\n</body>\n");
            }
            RenderMode::Export => {
                html.push_str("<body class=\"export-mode\">\n");
                html.push_str(&sections);
                html.push_str("</body>\n");
            }
        }
        html.push_str("</html>\n");

        Ok(html)
    }

    /// Render preview HTML and write to `<repo_root>/preview-{slug}.html`.
    pub fn write_preview(&self, draft: &CarouselDraft) -> Result<PathBuf> {
        let html = self.to_html(draft)?;
        let path = self.repo_root.join(format!("preview-{}.html", draft.slug));
        std::fs::write(&path, html)
            .with_context(|| format!("failed to write preview HTML at {}", path.display()))?;
        Ok(path)
    }

    /// Render the export HTML, launch headless Chrome, capture one PNG per slide.
    ///
    /// Writes to `<repo_root>/exports/<slug>/source.html` + `slide-NN.png`.
    /// Returns the PNG paths in slide order.
    pub async fn to_pngs(&self, draft: &CarouselDraft) -> Result<Vec<PathBuf>> {
        let export_html = self.to_export_html(draft)?;
        let export_dir = self.repo_root.join("exports").join(&draft.slug);
        std::fs::create_dir_all(&export_dir)
            .with_context(|| format!("create exports dir {}", export_dir.display()))?;
        let html_path = export_dir.join("source.html");
        std::fs::write(&html_path, &export_html)
            .with_context(|| format!("write export HTML to {}", html_path.display()))?;

        let file_url = format!("file://{}", html_path.display());
        let png_paths = tokio::task::spawn_blocking(move || -> Result<Vec<PathBuf>> {
            screenshot_all_slides(&file_url, &export_dir)
        })
        .await
        .map_err(|e| anyhow!("screenshot task panicked: {e}"))??;

        Ok(png_paths)
    }

    /// Bundle PNGs into a single PDF, one slide per page. Stub (#15).
    pub fn to_pdf(&self, _png_paths: &[PathBuf]) -> Result<PathBuf> {
        Err(anyhow!("pdf bundler not yet implemented (task #15)"))
    }
}

/// Internal: one slide as it will be rendered, plus its role.
struct RenderSlide<'a> {
    role: SlideRole,
    content: &'a SlideContent,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SlideRole {
    Editorial,
    Hook,
    Build,
    Payoff,
    Cta,
}

impl SlideRole {
    fn kicker(self) -> &'static str {
        match self {
            SlideRole::Editorial => "§ case file",
            SlideRole::Hook => "Hook",
            SlideRole::Build => "Build",
            SlideRole::Payoff => "Payoff",
            SlideRole::Cta => "CTA",
        }
    }

    fn footer_tag(self, vol: u32, is_last: bool) -> String {
        match self {
            SlideRole::Editorial => format!("editorial / vol. {vol:02}"),
            SlideRole::Hook => "swipe →".to_string(),
            SlideRole::Build => "build".to_string(),
            SlideRole::Payoff => "receipts".to_string(),
            SlideRole::Cta if is_last => format!("end / vol. {vol:02}"),
            SlideRole::Cta => "close".to_string(),
        }
    }
}

fn build_slide_list(draft: &CarouselDraft) -> Vec<RenderSlide<'_>> {
    match draft.format {
        CarouselFormat::Editorial => vec![RenderSlide {
            role: SlideRole::Editorial,
            content: &draft.hook,
        }],
        CarouselFormat::Value => {
            let mut slides = vec![RenderSlide {
                role: SlideRole::Hook,
                content: &draft.hook,
            }];
            if let Some(build) = &draft.build {
                slides.push(RenderSlide {
                    role: SlideRole::Build,
                    content: build,
                });
            }
            if let Some(payoff) = &draft.payoff {
                slides.push(RenderSlide {
                    role: SlideRole::Payoff,
                    content: payoff,
                });
            }
            slides.push(RenderSlide {
                role: SlideRole::Cta,
                content: &draft.cta,
            });
            slides
        }
    }
}

fn validate_draft(draft: &CarouselDraft) -> Result<()> {
    let slides = build_slide_list(draft);
    for (idx, slide) in slides.iter().enumerate() {
        let n = idx + 1;
        if slide.content.accent_words.len() > MAX_ACCENT_WORDS_PER_SLIDE {
            return Err(anyhow!(
                "slide {n} ({:?}) has {} accent words, max is {} per Midnight Press rules",
                slide.role.kicker(),
                slide.content.accent_words.len(),
                MAX_ACCENT_WORDS_PER_SLIDE
            ));
        }
        if slide.content.headline.is_none() && slide.content.lede.is_none() {
            return Err(anyhow!(
                "slide {n} ({:?}) has neither headline nor lede — nothing to render",
                slide.role.kicker()
            ));
        }
    }
    Ok(())
}

fn render_slide_section(
    draft: &CarouselDraft,
    slide: &RenderSlide<'_>,
    slide_num: usize,
    total: usize,
    bloom: BloomPreset,
    mode: RenderMode,
) -> Result<String> {
    let is_last = slide_num == total;
    let mast_right = match (draft.format, slide.role) {
        (CarouselFormat::Editorial, _) => format!("VOL. {:02}", draft.vol),
        (CarouselFormat::Value, _) => format!("VALUE {:02}/{:02}", slide_num, total),
    };

    let kicker = slide.role.kicker();
    let footer_tag = slide.role.footer_tag(draft.vol, is_last);
    let indent = match mode {
        RenderMode::Preview => "      ",
        RenderMode::Export => "  ",
    };

    let mut out = String::with_capacity(1024);
    if mode == RenderMode::Preview {
        let _ = writeln!(out, "    <div class=\"shell\">");
    }
    let _ = writeln!(
        out,
        "{indent}<section class=\"slide\" style=\"--bloom-bg: {};\">",
        bloom.css_value()
    );

    // Masthead
    let _ = writeln!(out, "{indent}  <header class=\"mast\">");
    let _ = writeln!(
        out,
        "{indent}    <div class=\"brand\"><span>THE MIDNIGHT PRESS</span></div>"
    );
    let _ = writeln!(out, "{indent}    <span>{}</span>", esc(&mast_right));
    let _ = writeln!(out, "{indent}  </header>");
    let _ = writeln!(out, "{indent}  <div class=\"kicker\">{}</div>", esc(kicker));

    // Body: Build slides get a giant numeral; everything else gets a hero headline.
    let content = slide.content;
    if slide.role == SlideRole::Build {
        let numeral = build_numeral(draft, slide_num);
        let _ = writeln!(out, "{indent}  <div class=\"num\">{numeral}</div>");
        let _ = writeln!(out, "{indent}  <div class=\"body\">");
        if let Some(headline) = &content.headline {
            let _ = writeln!(
                out,
                "{indent}    <p>{}</p>",
                wrap_accents(headline, &content.accent_words)
            );
        }
        if let Some(lede) = &content.lede {
            let _ = writeln!(
                out,
                "{indent}    <p>{}</p>",
                wrap_accents(lede, &content.accent_words)
            );
        }
        let _ = writeln!(out, "{indent}  </div>");
    } else {
        if let Some(headline) = &content.headline {
            let size_class = hero_size_class(headline);
            let _ = writeln!(
                out,
                "{indent}  <h2 class=\"hero{size_class}\">{}</h2>",
                wrap_accents(headline, &content.accent_words)
            );
        }
        if let Some(lede) = &content.lede {
            let _ = writeln!(
                out,
                "{indent}  <p class=\"lede\">{}</p>",
                wrap_accents(lede, &content.accent_words)
            );
        }
    }

    // Footer
    let _ = writeln!(out, "{indent}  <footer class=\"foot\">");
    let _ = writeln!(out, "{indent}    <span>@risingtides.ent</span>");
    let _ = writeln!(out, "{indent}    <span>{}</span>", esc(&footer_tag));
    let _ = writeln!(out, "{indent}  </footer>");

    let _ = writeln!(out, "{indent}</section>");
    if mode == RenderMode::Preview {
        let _ = writeln!(out, "    </div>");
    }
    Ok(out)
}

/// Synchronous Chrome screenshot loop, intended to run inside `spawn_blocking`.
///
/// Sets a device viewport tall enough to contain every stacked slide at native
/// 1080×1350, waits for fonts, then uses `Page.captureScreenshot` directly
/// (with `capture_beyond_viewport: true`) so each per-slide clip captures the
/// real pixels, not a viewport-cropped fallback.
fn screenshot_all_slides(file_url: &str, export_dir: &Path) -> Result<Vec<PathBuf>> {
    let opts = LaunchOptions::default_builder()
        .window_size(Some((SLIDE_W + 80, SLIDE_H + 80)))
        .sandbox(true)
        .build()
        .map_err(|e| anyhow!("launch options build failed: {e}"))?;
    let browser = Browser::new(opts).context("failed to launch headless Chrome")?;
    let tab = browser.new_tab().context("failed to open new tab")?;

    tab.navigate_to(file_url)
        .with_context(|| format!("navigate to {file_url}"))?;
    tab.wait_until_navigated().context("wait for navigation")?;

    let slide_count = {
        // Count via JS — cheaper than walking find_elements once viewport is set.
        let result = tab
            .evaluate("document.querySelectorAll('.slide').length", false)
            .context("count .slide elements")?;
        result
            .value
            .as_ref()
            .and_then(|v| v.as_u64())
            .ok_or_else(|| anyhow!("could not read slide count from page"))? as u32
    };
    if slide_count == 0 {
        return Err(anyhow!("no .slide elements found in export HTML"));
    }

    // Override the device viewport so all stacked slides exist at native 1080×1350
    // in real layout. `device_scale_factor: 1.0` ensures CSS px == output px.
    let total_height = SLIDE_H * slide_count;
    tab.call_method(Emulation::SetDeviceMetricsOverride {
        width: SLIDE_W,
        height: total_height,
        device_scale_factor: 1.0,
        mobile: false,
        scale: None,
        screen_width: None,
        screen_height: None,
        position_x: None,
        position_y: None,
        dont_set_visible_size: None,
        screen_orientation: None,
        viewport: None,
        display_feature: None,
        device_posture: None,
    })
    .context("set device viewport override")?;

    // Wait for Google Fonts (loaded via @import) + final layout/paint.
    let _ = tab.evaluate("document.fonts.ready.then(() => 'ready')", true);
    std::thread::sleep(std::time::Duration::from_millis(900));

    let mut paths = Vec::with_capacity(slide_count as usize);
    for idx in 0..slide_count {
        let n = idx + 1;
        let clip = Viewport {
            x: 0.0,
            y: (idx * SLIDE_H) as f64,
            width: SLIDE_W as f64,
            height: SLIDE_H as f64,
            scale: 1.0,
        };
        let response = tab
            .call_method(CaptureScreenshot {
                format: Some(CaptureScreenshotFormatOption::Png),
                clip: Some(clip),
                quality: None,
                from_surface: Some(true),
                capture_beyond_viewport: Some(true),
                optimize_for_speed: None,
            })
            .with_context(|| format!("capture screenshot for slide {n}"))?;
        let png = base64::engine::general_purpose::STANDARD
            .decode(response.data.as_bytes())
            .with_context(|| format!("decode screenshot PNG for slide {n}"))?;
        let path = export_dir.join(format!("slide-{n:02}.png"));
        std::fs::write(&path, &png)
            .with_context(|| format!("write png {}", path.display()))?;
        paths.push(path);
    }
    Ok(paths)
}

/// Pick the size class for a hero headline based on character count. Display
/// type wants to be huge but legible — long headlines need a smaller size.
fn hero_size_class(headline: &str) -> &'static str {
    let chars = headline.chars().count();
    if chars <= 12 {
        " short"
    } else if chars >= 28 {
        " long"
    } else {
        ""
    }
}

/// Build slides get an `01`, `02`... numeral derived from their position in the
/// build sequence. With a single build slide, it's just `01`.
fn build_numeral(draft: &CarouselDraft, slide_num: usize) -> String {
    // In Value layout: slide 1 = Hook, slide 2..n-1 = Build/Payoff, slide n = CTA.
    // Build is currently always at slide 2; this leaves room for future multi-build sequences.
    let _ = draft;
    format!("{:02}", slide_num.saturating_sub(1))
}

/// HTML-escape inline text. Quotes/apostrophes are NOT escaped because we only
/// interpolate into element bodies, never into attribute values.
fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

/// Wrap accent words inside an HTML-escaped string with `<span class="accent">…</span>`.
/// Matching is case-insensitive and whole-word.
fn wrap_accents(text: &str, accent_words: &[String]) -> String {
    let escaped = esc(text);
    if accent_words.is_empty() {
        return escaped;
    }

    let mut result = escaped;
    for word in accent_words {
        let word_trimmed = word.trim();
        if word_trimmed.is_empty() {
            continue;
        }
        let escaped_word = esc(word_trimmed);
        result = wrap_whole_word_ci(&result, &escaped_word);
    }
    result
}

/// Wrap the first whole-word case-insensitive occurrence of `needle` inside
/// `haystack` (already HTML-escaped) with `<span class="accent">…</span>`.
fn wrap_whole_word_ci(haystack: &str, needle: &str) -> String {
    if needle.is_empty() {
        return haystack.to_string();
    }
    let hay_lower = haystack.to_lowercase();
    let needle_lower = needle.to_lowercase();
    let bytes = haystack.as_bytes();
    let lower_bytes = hay_lower.as_bytes();
    let needle_bytes = needle_lower.as_bytes();

    let mut search_from = 0;
    while let Some(rel) = find_subslice(&lower_bytes[search_from..], needle_bytes) {
        let start = search_from + rel;
        let end = start + needle_bytes.len();
        let prev_ok = start == 0 || !is_word_char_byte(bytes[start - 1]);
        let next_ok = end == bytes.len() || !is_word_char_byte(bytes[end]);
        if prev_ok && next_ok {
            let mut out = String::with_capacity(haystack.len() + 32);
            out.push_str(&haystack[..start]);
            out.push_str("<span class=\"accent\">");
            out.push_str(&haystack[start..end]);
            out.push_str("</span>");
            out.push_str(&haystack[end..]);
            return out;
        }
        search_from = start + 1;
    }
    haystack.to_string()
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn is_word_char_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

#[derive(Clone, Copy)]
struct BloomPreset {
    violet: &'static str,
    magenta: &'static str,
}

impl BloomPreset {
    fn css_value(self) -> String {
        format!(
            "radial-gradient(800px 650px at {}, rgba(133,0,215,0.45), transparent 70%), \
             radial-gradient(900px 700px at {}, rgba(225,0,195,0.25), transparent 70%), \
             #0B0710",
            self.violet, self.magenta
        )
    }
}

/// 4-preset bloom palette. Choice derives from a stable hash of the draft slug
/// so the same draft always lands on the same bloom orientation.
fn pick_bloom(slug: &str) -> BloomPreset {
    const PALETTE: [BloomPreset; 4] = [
        // Default — matches Vol 01
        BloomPreset { violet: "82% 12%", magenta: "14% 88%" },
        // Mirror — violet bottom-right, magenta top-left
        BloomPreset { violet: "85% 85%", magenta: "12% 18%" },
        // Diagonal — violet top-left, magenta bottom-right
        BloomPreset { violet: "18% 14%", magenta: "84% 86%" },
        // Side-by-side — violet right, magenta center
        BloomPreset { violet: "92% 50%", magenta: "20% 60%" },
    ];
    let mut acc: u32 = 5381;
    for b in slug.as_bytes() {
        acc = acc.wrapping_mul(33).wrapping_add(*b as u32);
    }
    PALETTE[(acc as usize) % PALETTE.len()]
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
    use crate::types::{ContentOrigin, SourceCitation, SourceKind};

    fn slide(headline: Option<&str>, lede: Option<&str>, accents: &[&str]) -> SlideContent {
        SlideContent {
            headline: headline.map(String::from),
            lede: lede.map(String::from),
            accent_words: accents.iter().map(|s| s.to_string()).collect(),
            origin: ContentOrigin::LlmFilled,
        }
    }

    fn editorial_draft() -> CarouselDraft {
        CarouselDraft {
            slug: "mon-rovia-streams".to_string(),
            format: CarouselFormat::Editorial,
            vol: 1,
            working_title: "Mon Rovia streams".to_string(),
            hook: slide(
                Some("30K → 1.8M"),
                Some("Mon Rovia listener growth. 12 months. 928M views across campaign assets."),
                &["1.8M"],
            ),
            build: None,
            payoff: None,
            cta: slide(None, None, &[]),
            sources: vec![SourceCitation {
                label: "Mon Rovia case file".to_string(),
                kind: SourceKind::CampaignData,
                reference: "course-index §4.1".to_string(),
            }],
            seed_field: SeedField::Win,
        }
    }

    fn value_draft_minimal() -> CarouselDraft {
        CarouselDraft {
            slug: "pre-release-curiosity".to_string(),
            format: CarouselFormat::Value,
            vol: 2,
            working_title: "Pre-release curiosity".to_string(),
            hook: slide(
                Some("Most artists post songs too early."),
                Some("You don't need more content. You need pre-release curiosity."),
                &["songs"],
            ),
            build: None,
            payoff: None,
            cta: slide(
                Some("DM us a song."),
                Some("We'll map the hook arc before release day."),
                &["song"],
            ),
            sources: vec![],
            seed_field: SeedField::Take,
        }
    }

    fn value_draft_full() -> CarouselDraft {
        let mut d = value_draft_minimal();
        d.build = Some(slide(
            Some("Tease the feeling, not the file."),
            Some("Use conflict-driven snippets to build curiosity."),
            &["feeling"],
        ));
        d.payoff = Some(slide(
            Some("Curiosity lifts saves."),
            Some("High-performing evergreen pieces target save-to-like ratios above 24%."),
            &["saves"],
        ));
        d
    }

    #[test]
    fn renders_editorial_draft_single_slide() {
        let r = Renderer::new(PathBuf::from("/tmp"));
        let html = r.to_html(&editorial_draft()).expect("renders");
        // Exactly one shell
        assert_eq!(html.matches("class=\"shell\"").count(), 1, "expected one shell");
        // Editorial masthead format
        assert!(html.contains("VOL. 01"), "expected editorial vol header");
        // No VALUE label
        assert!(!html.contains("VALUE "), "editorial should not say VALUE");
        // Accent word wrapped
        assert!(html.contains("<span class=\"accent\">1.8M</span>"));
    }

    #[test]
    fn renders_value_draft_minimal_hook_plus_cta() {
        let r = Renderer::new(PathBuf::from("/tmp"));
        let html = r.to_html(&value_draft_minimal()).expect("renders");
        // Two slides total
        assert_eq!(html.matches("class=\"shell\"").count(), 2);
        assert!(html.contains("VALUE 01/02"));
        assert!(html.contains("VALUE 02/02"));
        // Both Hook and CTA kickers present
        assert!(html.contains(">Hook<"));
        assert!(html.contains(">CTA<"));
    }

    #[test]
    fn renders_value_draft_with_all_four_slides() {
        let r = Renderer::new(PathBuf::from("/tmp"));
        let html = r.to_html(&value_draft_full()).expect("renders");
        assert_eq!(html.matches("class=\"shell\"").count(), 4);
        assert!(html.contains("VALUE 01/04"));
        assert!(html.contains("VALUE 02/04"));
        assert!(html.contains("VALUE 03/04"));
        assert!(html.contains("VALUE 04/04"));
        // Build slide uses giant numeral
        assert!(html.contains("class=\"num\">01</div>"));
        // All 4 kickers
        for kicker in ["Hook", "Build", "Payoff", "CTA"] {
            assert!(html.contains(&format!(">{kicker}<")), "missing kicker {kicker}");
        }
    }

    #[test]
    fn accent_words_are_wrapped_case_insensitive_whole_word() {
        let r = Renderer::new(PathBuf::from("/tmp"));
        let d = CarouselDraft {
            slug: "test-accent".into(),
            format: CarouselFormat::Editorial,
            vol: 99,
            working_title: "Test".into(),
            hook: slide(Some("Most artists post Songs too early."), None, &["songs"]),
            build: None,
            payoff: None,
            cta: slide(None, None, &[]),
            sources: vec![],
            seed_field: SeedField::Manual,
        };
        let html = r.to_html(&d).expect("renders");
        assert!(html.contains("<span class=\"accent\">Songs</span>"));
        // The substring "post" should NOT match the "songs" accent — whole-word only.
        // (Sanity: word boundary handling.)
        assert!(!html.contains("<span class=\"accent\">post"));
    }

    #[test]
    fn rejects_draft_with_more_than_two_accent_words_per_slide() {
        let r = Renderer::new(PathBuf::from("/tmp"));
        let mut d = editorial_draft();
        d.hook.accent_words = vec!["one".into(), "two".into(), "three".into()];
        let err = r.to_html(&d).expect_err("should reject");
        let msg = err.to_string();
        assert!(msg.contains("accent words"), "expected accent-word error, got: {msg}");
        assert!(msg.contains("max is 2"), "expected max=2 mention, got: {msg}");
    }

    #[test]
    fn output_is_self_contained_no_external_stylesheet_link() {
        let r = Renderer::new(PathBuf::from("/tmp"));
        let html = r.to_html(&editorial_draft()).expect("renders");
        // No <link rel="stylesheet" ...> means Pocket srcdoc will render correctly.
        assert!(
            !html.contains("<link rel=\"stylesheet\""),
            "renderer must inline styles, never link to external CSS"
        );
        // Styles ARE present inline.
        assert!(html.contains("<style>"));
        assert!(html.contains(".accent"));
    }

    #[test]
    fn html_escapes_dangerous_characters_in_headline_text() {
        let r = Renderer::new(PathBuf::from("/tmp"));
        let mut d = editorial_draft();
        d.hook.headline = Some("Streams & saves < likes".into());
        d.hook.accent_words = vec![];
        let html = r.to_html(&d).expect("renders");
        assert!(html.contains("Streams &amp; saves &lt; likes"));
        assert!(!html.contains("Streams & saves < likes"));
    }

    #[test]
    fn bloom_preset_is_stable_for_same_slug() {
        let a = pick_bloom("mon-rovia-streams");
        let b = pick_bloom("mon-rovia-streams");
        assert_eq!(a.violet, b.violet);
        assert_eq!(a.magenta, b.magenta);
    }

    #[test]
    fn export_html_has_no_shell_wrappers_and_export_mode_body() {
        let r = Renderer::new(PathBuf::from("/tmp"));
        let html = r.to_export_html(&value_draft_full()).expect("renders");
        // No shell wrappers in export mode (slides render at native 1080x1350).
        assert!(
            !html.contains("class=\"shell\""),
            "export HTML must not wrap slides in .shell divs"
        );
        // Body carries the export-mode class so CSS strips the scale transform.
        assert!(html.contains("<body class=\"export-mode\">"));
        // Still one section per slide.
        assert_eq!(html.matches("class=\"slide\"").count(), 4);
        // No preview chrome elements (page title, page meta, grid wrapper).
        assert!(!html.contains("<h1 class=\"page-title\""));
        assert!(!html.contains("<p class=\"page-meta\""));
        assert!(!html.contains("<div class=\"grid\""));
    }

    #[test]
    fn export_html_preserves_slide_content_and_accent_spans() {
        let r = Renderer::new(PathBuf::from("/tmp"));
        let html = r.to_export_html(&value_draft_full()).expect("renders");
        assert!(html.contains("<span class=\"accent\">songs</span>"));
        assert!(html.contains("<span class=\"accent\">saves</span>"));
        // Build slide still gets the giant numeral.
        assert!(html.contains("class=\"num\">01</div>"));
        // Kickers preserved.
        for kicker in ["Hook", "Build", "Payoff", "CTA"] {
            assert!(html.contains(&format!(">{kicker}<")));
        }
    }

    #[test]
    fn rejects_slide_with_neither_headline_nor_lede() {
        let r = Renderer::new(PathBuf::from("/tmp"));
        let mut d = value_draft_minimal();
        d.cta = slide(None, None, &[]); // empty CTA
        let err = r.to_html(&d).expect_err("should reject empty slide");
        assert!(err.to_string().contains("neither headline nor lede"));
    }
}
