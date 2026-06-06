//! Visual smoke test for the Midnight Press renderer.
//!
//! Builds a `CarouselDraft` modeled on Vol 01 (Mon Rovia case file +
//! pre-release-curiosity value carousel) and writes the result to
//! `/tmp/rt-carousel-smoke-*.html`. Open in a browser to eyeball fidelity
//! against `preview-midnight-press.html` (the reference).
//!
//! Run: `cargo run --example render-smoke`
//! With PNG screenshotting (requires headless Chrome):
//! `cargo run --example render-smoke -- --pngs`
//! With Pocket inline (copies real index.html to /tmp/ and inserts there):
//! `cargo run --example render-smoke -- --pocket`

use rt_carousel_agent::config::Config;
use rt_carousel_agent::pocket::PocketInliner;
use rt_carousel_agent::render::Renderer;
use rt_carousel_agent::types::{
    CarouselDraft, CarouselFormat, ContentOrigin, SeedField, SlideContent, SourceCitation,
    SourceKind,
};
use std::path::PathBuf;

fn slide(headline: Option<&str>, lede: Option<&str>, accents: &[&str]) -> SlideContent {
    SlideContent {
        headline: headline.map(String::from),
        lede: lede.map(String::from),
        accent_words: accents.iter().map(|s| s.to_string()).collect(),
        origin: ContentOrigin::Verbatim,
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let with_pngs = std::env::args().any(|a| a == "--pngs");
    let with_pocket = std::env::args().any(|a| a == "--pocket");
    let out_dir = PathBuf::from("/tmp");
    let renderer = Renderer::new(out_dir.clone());

    let editorial = CarouselDraft {
        slug: "smoke-editorial-mon-rovia".to_string(),
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
    };

    let value = CarouselDraft {
        slug: "smoke-value-pre-release-curiosity".to_string(),
        format: CarouselFormat::Value,
        vol: 2,
        working_title: "Pre-release curiosity".to_string(),
        hook: slide(
            Some("Most artists post songs too early."),
            Some("You don't need more content. You need pre-release curiosity."),
            &["songs"],
        ),
        build: Some(slide(
            Some("Tease the feeling, not the file."),
            Some(r#"Use conflict-driven snippets: "we found the song. not the audience.""#),
            &["feeling"],
        )),
        payoff: Some(slide(
            Some("Curiosity lifts saves."),
            Some("High-performing evergreen pieces target save-to-like ratios above 24%."),
            &["saves"],
        )),
        cta: slide(
            Some("DM us a song."),
            Some("We'll map the hook arc before release day."),
            &["song"],
        ),
        sources: vec![SourceCitation {
            label: "course-index §6.1 (voice metaphors)".to_string(),
            kind: SourceKind::CourseIndex,
            reference: "course-index.md".to_string(),
        }],
        seed_field: SeedField::Take,
    };

    for draft in [&editorial, &value] {
        let path = renderer.write_preview(draft)?;
        println!(
            "preview html → {} ({} format, vol. {:02})",
            path.display(),
            match draft.format {
                CarouselFormat::Editorial => "editorial",
                CarouselFormat::Value => "value",
            },
            draft.vol,
        );

        if with_pngs {
            println!("  screenshotting slides via headless Chrome…");
            let pngs = renderer.to_pngs(draft).await?;
            for p in &pngs {
                println!("    png → {}", p.display());
            }
        }
    }

    if with_pocket {
        let real_index = dirs::home_dir()
            .expect("HOME")
            .join("Projects/active/rt-pocket/index.html");
        if !real_index.exists() {
            println!("\n--pocket: real index not found at {} — skipping", real_index.display());
        } else {
            let test_index = PathBuf::from("/tmp/rt-pocket-smoke-index.html");
            let test_version = PathBuf::from("/tmp/version.txt");
            std::fs::copy(&real_index, &test_index)?;
            // Seed a starting version so the bump assertion has something to chew on.
            std::fs::write(&test_version, "1999-01-01-001")?;

            // Override pocket index path via env so Config picks it up.
            // Important: do NOT override the real `~/Projects/active/rt-pocket/index.html`.
            // SAFETY: single-threaded smoke; no other threads observing env.
            unsafe {
                std::env::set_var("RT_POCKET_INDEX", &test_index);
            }
            let cfg = Config::from_env()?;
            let inliner = PocketInliner::new(&cfg);

            for draft in [&editorial, &value] {
                let result = inliner.inline_carousel(draft)?;
                println!(
                    "  pocket {action:?} → {hash}  (version → {version})",
                    action = result.action,
                    hash = result.hash,
                    version = result.version,
                );
            }
            println!("    test index → {}", test_index.display());
            println!("    diff against real:  diff {} {}", real_index.display(), test_index.display());
        }
    }

    if !with_pngs && !with_pocket {
        println!("\n(pass --pngs to screenshot via headless Chrome; --pocket to test the Pocket inliner against a /tmp copy)");
    }

    Ok(())
}
