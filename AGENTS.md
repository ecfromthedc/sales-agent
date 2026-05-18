# RT Carousel Agent

**Repo path:** `/Users/ericcromartie/Documents/Development/carousels-agent`
**Owner:** Rising Tides Entertainment — Eric Cromartie (`ec@risingtidesent.com`)
**Handle:** `@risingtides.ent`

---

## What this project does

Generates Instagram/TikTok carousel content for the Rising Tides brand page. Takes input (topic, data, Alexandria research) and outputs production-ready HTML that renders to PNG or PDF — previewable in-browser, refineable before export.

Two formats. Nothing else.

| Format | Slides | Purpose |
|--------|--------|---------|
| **Editorial** | 1 | Single-slide statement piece. Grid anchor. Functions like a business card — highlights a win, a take, or a positioning statement. |
| **Value** | 2–7 | Multi-slide storytelling. Educational, how-to, course promo, tip-of-the-spear industry insights. Packs information across a swipe arc with a hook on slide 1 and a CTA at the end. |

**Not in scope:** Posters, video content, Reels, Stories. Posters remain in the RT workflow — just not here.

---

## The Two Pillars

### Editorial Format (Single Slide)

The grid anchor. A confident, polished statement that lives on the feed permanently. Think business card meets broadsheet front page.

**Use cases:**
- Client wins / case study hero stats
- Contrarian industry takes
- Brand positioning statements
- Course announcements
- Quotable insights from Alexandria research

**Structure:**
- Masthead + section marker
- One dominant headline or stat (Display type, accent gradient on 1–2 words max)
- Supporting context line (Serif, 1–2 sentences)
- Brand footer with handle + star mark
- Optional: stamp, margin note, stat band

### Value Format (Multi-Slide, 2–7 slides)

The engagement driver. Builds intrigue on slide 1, delivers value through the arc, closes with an indirect or direct CTA.

**Use cases:**
- Educational how-to content (funnel to RT services)
- Course module teasers (RT Viral)
- Industry breakdowns (algorithm changes, platform shifts, trend analysis)
- Artist case studies (Midnight Press / Case File format)
- Myth-busting, reframes, contrarian threads

**Structure follows the curiosity-dopamine loop:**

| Beat | Slide | Job |
|------|-------|-----|
| Hook | 1 | Create intrigue. Problem, bold claim, or stat that demands a swipe. Never put the payoff here. |
| Build | 2–N | Deliver value. Each slide earns the next swipe. Data, steps, story beats, tension. |
| Payoff | N–1 | The reveal, the receipts, the answer. This is what they swiped for. |
| CTA | Last | Close. DM prompt, follow prompt, link-in-bio, course plug. Feels like a tip line, not a sales pitch. |

**Instagram algorithm note:** Carousels get 12% more engagement than other formats. If a user scrolls past, Instagram re-serves starting from slide 2 — so slide 2 must also hook independently ("Second Chance Principle").

---

## Brand System — Midnight Press

Every carousel follows the Midnight Press design language. Dark newsprint. Late edition. Something just happened and we're the first to write it down.

### Design Tokens

```css
:root {
  /* Surfaces */
  --rt-paper:   #0B0710;    /* Primary — ink-black, violet cast */
  --rt-paper-2: #140A1C;    /* Elevated surface */

  /* Text */
  --rt-ink:     #F3EAD4;    /* Aged-cream "white" — all primary text */
  --rt-ink-2:   #D9CEB4;    /* Secondary cream */
  --rt-mute:    rgba(243,234,212,0.62);  /* Labels, meta */
  --rt-mute-lo: rgba(243,234,212,0.38);  /* De-emphasized */
  --rt-rule:    rgba(243,234,212,0.22);  /* Hairline rules */

  /* Accents */
  --rt-violet:  #8500D7;    /* Brand purple — primary accent */
  --rt-magenta: #E100C3;    /* Brand magenta — secondary accent */
  --rt-glow-v:  rgba(149,70,255,0.55);  /* Violet bloom pool */
  --rt-glow-m:  rgba(225,0,195,0.38);   /* Magenta bloom pool */
  --rt-accent:  #C9A85F;    /* Old-gold — stamps, seals */
  --rt-red:     #C8301C;    /* Ink red — rare emphasis only */

  /* Typography */
  --rt-display: 'Archivo Black','Anton','Bodoni Moda',serif;
  --rt-serif:   'Bodoni Moda','Playfair Display',Georgia,serif;
  --rt-mono:    'JetBrains Mono',ui-monospace,monospace;
  --rt-hand:    'Kalam',cursive;
}
```

### Accent Gradient (use sparingly — 1–2 words per composition)

```css
background: linear-gradient(180deg, #F3EAD4 0%, #EAC9FF 55%, #8500D7 100%);
-webkit-background-clip: text;
color: transparent;
```

### Color Ratios

70% paper (dark stock) / 20% ink (type & rules) / 7% violet+magenta (bloom, accents) / 3% gold+red (seals, emphasis)

### Typography Scale (1080x1350 canvas)

| Level | Size | Family | Notes |
|-------|------|--------|-------|
| Hero numeral | 280–360px | Display | 1 per composition max |
| Headline | 120–200px | Display | Uppercase, tight-tracked, `0.82–0.88` line-height |
| Subhead | 48–70px | Display | Uppercase |
| Body lede | 28–34px | Serif | Italic for pull-quotes |
| Body | 18–24px | Serif | `line-height: 1.3` |
| Label / kicker | 11–14px | Mono | Uppercase, `0.24–0.32em` tracking |
| Hand note | 26–34px | Hand | Rotate +/-2 max |

### Typography Rules

- Display: always uppercase, tight-tracked, heavy. Never drop-shadow — the page glows, the letters stay crisp.
- Mono: always uppercase with wide letter-spacing.
- Serif: mixed-case. Italic = editorial pull-quote voice.
- Hand: lowercase, first-person, fragmentary. +/-2 rotation max.
- Never underline. Ever.

### Texture Stack (all four required — strip these and it's not Rising Tides)

1. **Glow pools** — large radial blooms (violet top-right, magenta bottom-left, ~800–1100px, blur 40px). Background layer only (z-index 0). Never on text.
2. **Paper fibre** — fractal-noise SVG, screen blend, ~35% opacity.
3. **Ink specks** — coarse fractal noise, multiply blend, ~50% opacity.
4. **Scanlines** — 1px horizontal repeating gradient, overlay blend, ~22% opacity.
5. **Vignette** — `inset box-shadow: 0 0 260px rgba(0,0,0,0.75)`.

### Editorial Furniture

- **Masthead:** Star + `RISING TIDES · THE MIDNIGHT PRESS` (mono, 0.32em tracked) left; `VOL. 0X` right. Hairline rule below.
- **Footer:** `@risingtides.ent` · caption · slide counter. Hairline rule above.
- **Section markers:** `§ 01 ——— The setup` (mono, uppercase, 0.3em tracked).
- **Stamps:** Rubber-stamp rectangles. Gold (`Confidential`, `Verified`), magenta (`Tactic 01`, `End / Vol. 01`), violet (rare). Rotated -10 to +10.
- **Tape:** Cream or violet-gradient washi-tape chips with mono text. Slight rotation.
- **Redactions:** Solid cream bars with violet glow. Rare — for mystery, not decoration.
- **Crop marks:** 16px `+` at photo corners.
- **Hand-scrawl notes:** Lowercase, fragmentary, +/-2 rotation.

### Photo Treatment

Three modes:
- **Duotone** (default): grayscale + `linear-gradient(150deg, magenta55, violetaa, paper)` screen wash
- **Halftone**: grayscale + radial-gradient dot screen at 4px pitch, multiply blend
- **Full color**: untouched except contrast 1.05 + grain + edge glow

### Canvas & Grid

| Context | Dimensions | Safe margin |
|---------|-----------|-------------|
| IG carousel | 1080 x 1350 (4:5) | 60px sides, 40px top/bottom |
| IG square | 1080 x 1080 | 60px all sides |

---

## Voice & Copy

### Do

- Speak like a reporter filing at 2am. Subject-verb-object. Short.
- Use case-file vocabulary: *subject, receipts, field note, the setup, the move, the turn, close, vol., case file N.*
- Handwritten notes in first person plural, lowercase: *"we found the song. not the audience."*
- Drop one number, not five. Make it huge.
- End with a CTA that sounds like a tip line: *"DM us a song."*

### Don't

- No emoji (exception: gold star in mono strings).
- No hashtags in body copy.
- No "we're excited to announce." No "elevate." No "ecosystem."
- No title case in display type.
- No exclamation marks.

---

## Content Pipeline

### Input Sources

1. **Direct topic from Eric** — a brief, a take, a stat, a course module
2. **Library of Alexandria** — research entries with insights already extracted and tagged
3. **Hook database** — proven viral hooks from competitor research and RT's own content
4. **Viral Formulas** — documented patterns from `~/Documents/Obsidian Vault/Rising Tides OS/memory/Content Patterns/Viral Formulas.md`
5. **Client campaign data** — real numbers from Mon Rovia, Goldford, Family Company, etc.

### Alexandria Integration

Before generating any carousel, check Alexandria for relevant research:

```bash
cd ~/Projects/active/rt-agents && source .venv/bin/activate
python3 neo4j-alexandria.py search "<topic>"
```

Key Alexandria paths:
- `Alexandria/Content Strategy/Instagram Carousel Strategy Framework.md` — algorithm mechanics, engagement patterns
- `Alexandria/Content Strategy/RT-Viral-Course/Module-2-Viral-Psychology-5-Content-Formats.md` — carousel psychology
- `Alexandria/Music Industry/Viral Strategies/` — hook frameworks, storytelling psychology
- `Alexandria/Content Strategy/N8n Carousel Generation Workflow.md` — automation reference

### Hook Frameworks (apply to every slide 1)

From the research corpus:

**Chris Chung framework:** Curiosity is the only emotion needed in the first 3 seconds. 15–25% surprise rule for pattern interrupts.

**Matthew Nadeau "10 hooks that always work":** Documented in Alexandria viral strategies.

**RT Viral Course Module 2 — carousel-specific:**
- Slide 1 = the problem (never the payoff)
- Build suspense across middle slides
- Last slide = payoff reveal
- Common stack: promise of payoff + suspense + payoff

**Save-to-like ratio > 24%** = high-value evergreen content. Design for saves.

---

## Output

### What Gets Generated

1. **Self-contained HTML file** — one file per carousel, previewable in any browser
2. Each slide rendered as a 1080x1350 artboard within the HTML
3. Uses `_brand.css` tokens + Midnight Press texture stack
4. Tweaks panel for photo treatment modes (duotone/halftone/full)

### Export Path

HTML → screenshot each artboard as PNG (1080x1350) → ready for Instagram/TikTok upload.

Alternative: HTML → PDF (multi-page, one slide per page).

### File Naming

```
rt-carousel-[format]-[slug]-[date].html
```

Examples:
- `rt-carousel-editorial-mon-rovia-streams-2026-05-18.html`
- `rt-carousel-value-tiktok-algorithm-myths-2026-05-18.html`

---

## Existing Assets & Prior Art

### RT Carousel Skill (reference, not canonical for this project)

`~/.claude/skills/rt-carousel/` — earlier skill with Remotion-based pipeline. Has useful brand config and template definitions but uses a different rendering stack (Remotion Still Images). Reference for content structure and voice rules, not for rendering approach.

### Remotion Project

`~/Projects/active/rt-carousels/` — existing Remotion compositions (ContrarianTake, TumblrQuote, DataDrop, MythBuster, EditorialWins). Reference for content patterns and slide structures.

### Brand Assets

- **CSS tokens:** `/Users/ericcromartie/Desktop/Rising Tide Team Teamplates/_brand.css`
- **Brand kit spec:** `/Users/ericcromartie/Desktop/Rising Tide Team Teamplates/# Rising Tides — Brand Kit Design Specs.md`
- **Case-File template:** `/Users/ericcromartie/Desktop/Rising Tide Team Teamplates/# Artist Case-File Carousel.md`
- **Midnight Press spec:** `/Users/ericcromartie/Desktop/Rising Tide Team Teamplates/# Midnight Press Carousel — Template Spec.md`
- **Google Drive logos:** `https://drive.google.com/drive/u/0/folders/1raKKhQUA7q_hSOpGNItiEX_exhbuQPY0`
- **Logo files needed:** `logo-icon-white.svg`, `logo-horizontal-white.svg`, `logo-vertical-white.svg`

### Known Client Data (for case study carousels)

- Mon Rovia: 30K → 1.8M listeners (928M views in 12 months)
- Goldford: 130K → 2M listeners (194M views in 6 months)
- Family Company: 50K → 167K listeners (7 weeks)

---

## Working in This Repo (for Claude Code)

1. **Every carousel must be previewable.** Generate HTML that opens in a browser and looks right before any export step.
2. **Stick to two formats.** Editorial (1 slide) and Value (2–7 slides). No posters, no Stories, no Reels.
3. **Apply the full texture stack.** Glow pools, paper fibre, ink specks, scanlines, vignette. All five layers. If it looks "clean digital," it's wrong.
4. **Respect the type hierarchy.** Display for headlines (uppercase, tight), Serif for body (mixed-case), Mono for labels (uppercase, wide-tracked), Hand for margin notes (lowercase, rotated). Four roles — don't invent a fifth.
5. **Accent gradient is rare.** Only 1–2 words per composition. It's the exclamation point of the design system — overuse kills it.
6. **Voice over decoration.** If the copy is weak, nothing in the brand kit saves it. Spend more time on the words than the layout.
7. **Check Alexandria first.** Before writing copy for any topic, search the knowledge graph for existing research, insights, and data points. Don't generate from thin air when we have real intelligence.
8. **Do not invent stats.** Only use real campaign data from known clients or verified Alexandria sources.
9. **Hook slide 1 hard.** Every value carousel lives or dies on slide 1. Apply hook frameworks. Slide 1 is the problem/intrigue — never the payoff.
10. **Design for saves, not likes.** Evergreen value content. Save-to-like ratio > 24% is the benchmark.
11. **CTA should feel like a tip line.** "DM us a song." Not "Click the link in our bio to learn more about our services."
12. **Iterate in-browser.** The HTML is the working surface. Refine copy, layout, and emphasis in the HTML before exporting. Eric will review in-browser and request changes.

---

## Content Pillars (What We Post About)

All carousel content maps to Rising Tides' value proposition:

1. **Industry intelligence** — what's changing on TikTok/IG, algorithm shifts, platform news. Positions RT as the informed operator.
2. **Case studies / receipts** — real campaign results with real numbers. Proof of concept.
3. **How-to / educational** — tactical content that demonstrates expertise. Funnel to services.
4. **RT Viral course promo** — module teasers, student wins, methodology previews. Funnel to course.
5. **Contrarian takes** — challenge conventional wisdom in music marketing. Engagement drivers.
6. **Behind the strategy** — the thinking behind a campaign, not just the results. Builds trust.

---

## Non-Negotiables

- Headlines stay **crisp**. The page glows; the letters do not.
- Only **1–2 emphasis words** per composition take the accent gradient.
- Bloom pools are always **background layer** (z-index 0). They never touch type.
- Stamps and tape stay **within the safe margin**.
- Redaction is **rare**. Overused, it's a gimmick.
- **No emoji.** Gold star in mono strings is the only exception.
- The **mark is never modified** — one color, one silhouette, every time.
- **Voice > decoration.** Always.
