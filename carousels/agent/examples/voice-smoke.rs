//! Voice smoke test — drafts ONE carousel from a seed and prints the copy.
//!
//! No Slack, no Pocket, no render — just the words, so you can eyeball whether
//! the new Eric-voice system prompt (generator.rs::build_system_prompt) actually
//! kills the AI smell. Requires ANTHROPIC_API_KEY in the env/.env.
//!
//! Run:
//!   cargo run --example voice-smoke -- "your take here"
//!   cargo run --example voice-smoke        # uses a default take

use rt_carousel_agent::config::Config;
use rt_carousel_agent::generator::Generator;
use rt_carousel_agent::render::Renderer;
use rt_carousel_agent::sources::SourceIndex;
use rt_carousel_agent::types::{Intake, SeedField};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let seed_value = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "polished content is throttling your reach — the merged feed treats anything that looks sold like an ad".to_string());

    let cfg = Config::from_env()?;
    let sources = SourceIndex::load(&cfg)?;
    eprintln!(
        "loaded sources: {} claims · {} metaphors · {} banned · {} voice_rules\n",
        sources.claims.len(),
        sources.voice_metaphors.len(),
        sources.banned_phrases.len(),
        sources.voice_rules.len()
    );

    let generator = Generator::new(&cfg, &sources)?;
    let intake = Intake {
        win: None,
        take: Some(seed_value.clone()),
        insight: None,
        course_tease: None,
        contrarian: None,
        thread_ts: None,
        channel: None,
        voice_notes: None,
        embargo: None,
    };

    eprintln!("SEED (take): {seed_value}\n{}", "─".repeat(72));
    let draft = generator.draft_one(SeedField::Take, &seed_value, &intake).await?;

    let show = |label: &str, s: &rt_carousel_agent::types::SlideContent| {
        println!("\n[{label}]");
        if let Some(h) = &s.headline {
            println!("  HEADLINE: {h}");
        }
        if let Some(l) = &s.lede {
            println!("  LEDE:     {l}");
        }
        if !s.accent_words.is_empty() {
            println!("  ACCENT:   {}", s.accent_words.join(", "));
        }
    };

    println!("WORKING TITLE: {}", draft.working_title);
    show("HOOK", &draft.hook);
    if let Some(b) = &draft.build {
        show("BUILD", b);
    }
    if let Some(p) = &draft.payoff {
        show("PAYOFF", p);
    }
    show("CTA", &draft.cta);

    println!("\n{}", "─".repeat(72));
    println!("SOURCES: {}", draft.sources.iter().map(|s| s.label.as_str()).collect::<Vec<_>>().join(" · "));

    // Render to a previewable HTML file and open it.
    let renderer = Renderer::new(cfg.repo_root.clone());
    let path = renderer.write_preview(&draft)?;
    println!("\nPREVIEW: {}", path.display());

    if std::env::args().any(|a| a == "--pngs") {
        match renderer.to_pngs(&draft).await {
            Ok(pngs) => {
                println!("PNGS:");
                for p in &pngs {
                    println!("  {}", p.display());
                }
                if let Some(first) = pngs.first() {
                    let _ = std::process::Command::new("open").arg(first).status();
                }
            }
            Err(e) => eprintln!("png render failed: {e}"),
        }
    } else {
        let _ = std::process::Command::new("open").arg(&path).status();
    }
    Ok(())
}
