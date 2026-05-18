# RT Carousel Agent — Handoff

**For:** the next agent / Claude session picking up this repo
**Owner:** Eric Cromartie · `ec@risingtidesent.com` · Rising Tides Entertainment
**Last handoff:** 2026-05-18

Read this whole doc before touching anything. It assumes you've never seen the project. Cross-references at the bottom point to the spec, the brand system, and the Pocket integration — read those *after* this, on demand, not upfront.

---

## 0. TL;DR (read me first)

- **What:** A repo that produces Instagram/TikTok **carousels** (1080×1350) for the Rising Tides agency page (`@risingtides.ent`), in a single brand voice — **The Midnight Press**.
- **Output:** Self-contained HTML files, one per carousel, each renders all slides side-by-side at 0.26× scale for in-browser review. Slides are the real 1080×1350 size — screenshot each one to PNG for posting.
- **Two formats only:** **Editorial** (1 slide, grid anchor) and **Value** (2–7 slides, swipe arc, ends in CTA). Posters / video / Reels / Stories are *not* in scope.
- **Where the previews live:** This repo. Each draft is `preview-{slug}.html`. When copy/design is locked, rename to spec → `rt-carousel-[format]-[slug]-[date].html`.
- **Where Eric reviews them:** RT Pocket (Telegram Mini App). Every preview also gets inlined into `~/Projects/active/rt-pocket/index.html` as a `<script type="text/html">` panel so Eric can flip through them on his phone.
- **Current work-in-flight:** Vol. 02–04 are *drafts*; Vol. 01 (Midnight Press · Mon Rovia 30K → 1.8M) is shipped. Eric wants to **fine-tune the new ones** before posting. He hasn't approved any of the hooks, the placeholder numbers, or the source citations yet.

**If you read nothing else, read §3 (current state), §6 (the workflow), and §8 (what Eric wants you to fine-tune).**

---

## 1. The project — what it is and isn't

This is the agency content engine for Rising Tides' owned Instagram page. It does **one thing**: take an idea (a case study, a contrarian take, a tactic, a course teaser), and produce a posting-ready carousel.

| In scope | Out of scope |
|---|---|
| Editorial single-slide statement pieces | Posters (separate RT pipeline) |
| Value 2–7 slide swipe arcs (educational, contrarian, case-study) | Video, Reels, Stories |
| Self-contained HTML files (one per carousel) | Multi-asset campaigns |
| Rising Tides agency brand (`@risingtides.ent`) only | Mon Rovia / artist accounts |
| Hook → Build → Payoff → CTA structure | Editorial calendar / scheduling (handled in Postiz) |

**One brand, one voice.** The Midnight Press is the only aesthetic. Don't invent secondary brands without explicit approval — Eric flagged this as a possible future split for course content (RT Viral) vs. agency content, but no decision yet.

---

## 2. Architecture & files

```
/Users/ericcromartie/Documents/Development/carousels-agent/
├── AGENTS.md                                # Full project spec (READ AFTER THIS DOC)
├── CLAUDE.md                                # Mirror of AGENTS.md (keep them in sync)
├── HANDOFF.md                               # ← you are here
├── brand/
│   ├── _brand.css                           # Shared brand tokens, fonts, textures
│   └── logos/                               # 6 SVG variants (icon/horizontal/vertical × black/white)
├── preview-midnight-press.html              # Vol. 01 · SHIPPED · Mon Rovia case file
├── preview-carousel-ideas-index.html        # Vol. 00 · DRAFT · master concept index
├── preview-pre-release-curiosity.html       # Vol. 02 · DRAFT · "Drop day isn't launch"
├── preview-save-economy.html                # Vol. 03 · DRAFT · "Your likes are lying" (24% slide)
├── preview-creator-curiosity.html           # Vol. 04 · DRAFT · "Your brief is killing the campaign"
└── sync-context-to-vaultkeeper.sh           # Existing helper, don't touch unless asked
```

**Git status as of handoff:** 4 new previews + AGENTS.md/CLAUDE.md edits are **untracked / unstaged**. Eric was asked whether to commit; he hasn't decided yet. Don't commit on your own without confirmation.

**`.DS_Store` is in the repo.** It shouldn't be. Add `.DS_Store` to a `.gitignore` next time you're cleaning up — but ask first before introducing a new file.

---

## 3. Current state (what's built, what's pending, what's in motion)

### 3.1 Shipped

- **Vol. 01 — Midnight Press · Mon Rovia case file** (`preview-midnight-press.html`)
  - Editorial single-slide ("30K → 1.8M") + 4-slide value carousel teaching the slow-build playbook
  - **This is the reference implementation.** All new carousels must match its visual fidelity, masthead, footer, type stack, and bloom-gradient backgrounds
  - Already inlined into RT Pocket as `panel-carousel-midnight-press`

### 3.2 Draft — needs Eric's fine-tuning before anything ships

All three are full 4-slide Value carousels following **Hook → Build → Payoff → CTA**, all inlined into RT Pocket for phone-side review:

| Vol | Slug | Hook | Payoff (money slide) | Status |
|---|---|---|---|---|
| 02 | `pre-release-curiosity` | "Drop day isn't launch. It's the finale." | "Pre-saves shift the bet." | Awaiting copy review |
| 03 | `save-economy` | "Your likes are lying to you." | Giant **24%** save:like ratio | Awaiting **real numbers** review (see §8) |
| 04 | `creator-curiosity` | "Your brief is killing the campaign." | "Creators don't sell. Curiosity sells." (A/B build slide: Scripted vs. Native) | Awaiting RT-portfolio data review (see §8) |

Plus the **master ideas index** (`preview-carousel-ideas-index.html`) — a concept board with each volume's hook / payoff / CTA / sources, designed as a fine-tuning surface, not a postable asset.

### 3.3 In-flight decisions (Eric hasn't decided yet)

Listed in §8. Don't pick on your own.

---

## 4. The brand (Midnight Press) — locked, do not deviate

The full brand system is in `brand/_brand.css`. Memorize the tokens — they are the spine of every slide.

### 4.1 Color tokens

```css
--rt-paper:   #0B0710;   /* near-black with violet tint, the slide background base */
--rt-paper-2: #140A1C;   /* slightly lighter, for secondary panels */
--rt-ink:     #F3EAD4;   /* warm cream, primary text */
--rt-mute:    rgba(243,234,212,0.62);   /* muted ink, for meta / masthead */
--rt-rule:    rgba(243,234,212,0.22);   /* hairlines, dividers */
--rt-violet:  #8500D7;   /* primary accent, top-right bloom */
--rt-magenta: #E100C3;   /* secondary accent, bottom-left bloom */
--rt-accent:  #C9A85F;   /* gold — stamps, "VERIFIED" badges only */
--rt-red:     #C8301C;   /* very rare — emergency/redaction */
```

### 4.2 Type stack

```css
--rt-display: 'Archivo Black','Anton',sans-serif;       /* headlines only — Hero type */
--rt-serif:   'Bodoni Moda','Playfair Display',serif;   /* lede, body copy, large quotes */
--rt-mono:    'JetBrains Mono',ui-monospace,monospace;  /* mastheads, footers, meta */
--rt-hand:    'Kalam',cursive;                          /* very rare — annotations */
```

**Hierarchy rule:** at most **1–2 emphasis words per slide** get the accent gradient:

```css
background: linear-gradient(180deg, #F3EAD4 0%, #EAC9FF 56%, #8500D7 100%);
-webkit-background-clip: text; background-clip: text; color: transparent;
```

### 4.3 The slide canvas (1080×1350)

Every slide:
- 54px top / 60px side padding
- **Masthead** (top): mono caps, letter-spaced 0.28em, hairline border-bottom — `THE MIDNIGHT PRESS · VOL. XX` left, `VALUE 0X/04` right
- **Kicker** (above hero): mono caps, 0.24em tracking, `--rt-mute` — single word like "Hook" / "Build" / "Payoff" / "CTA"
- **Hero** (display type): `font: 900 ~130px/.88 "Archivo Black"`, uppercase, tight tracking (`-.02em`)
- **Lede** (serif): `font: 500 34px/1.28 "Bodoni Moda"`, color `#e9dcc0`, max-width 880px
- **Foot** (bottom): mono caps, hairline border-top, handle left (`@risingtides.ent`), context right (`swipe →` / `build` / `receipts` / `end / vol. xx`)

### 4.4 Background bloom

Each carousel has a unique bloom direction so they don't all look the same:

| Vol | Top bloom | Bottom bloom |
|---|---|---|
| 01 (Midnight Press) | 82% 12% violet | 14% 88% magenta |
| 02 (Pre-Release) | 82% 12% violet | 14% 88% magenta (same as 01 — intentional sister) |
| 03 (Save Economy) | 18% 14% **magenta** (mirrored — distinct identity) | 88% 86% violet |
| 04 (Influencer) | 50% 0% violet (top-center) | 50% 100% magenta (bottom-center) |

If you spin up Vol. 05+, **pick a new bloom orientation** so the deck stays visually distinguishable in the grid view.

### 4.5 Non-negotiables (copied from AGENTS.md, repeated here because they matter)

- Headlines stay **crisp**. The page glows; the letters do not.
- Only **1–2 emphasis words** per composition take the accent gradient.
- Bloom pools are always **background layer** (z-index 0). They never touch type.
- Stamps and tape stay **within the safe margin**.
- Redaction is **rare**. Overused, it's a gimmick.
- **No emoji.** Gold star in mono strings is the only exception.
- The **mark is never modified** — one color, one silhouette, every time.
- **Voice > decoration.** Always.

---

## 5. The slide spine — Hook → Build → Payoff → CTA

Every Value carousel currently follows this 4-slide arc. Don't deviate without checking with Eric (see §8 — he asked about trying a 5-slide Hook → Story → Lesson → Receipt → CTA structure).

| Slide | Kicker | What it does | Type weight |
|---|---|---|---|
| 01 | **Hook** | Pattern-interrupt headline. Provocation, contrarian frame, or contradiction. 1 sentence, hero type. | Heavy display, 1–2 accent words. |
| 02 | **Build** | The mechanism. Why the hook is true. Often a number (`06`, `01`), an A/B comparison, or a 2-3 line teaching. | Serif body, sometimes a `.num` element. |
| 03 | **Payoff** | The receipt / proof / takeaway. This is the **money slide** — most likely to get screenshotted and saved. Often a single big stat or a quotable line. | Display + serif support. |
| 04 | **CTA** | The DM/comment ask. Always low-friction ("DM us a song" / "Send a brief" / "Audit your last 10"). | Display, with a clear next action. |

**Hook examples that work** (from the current drafts):
- "Drop day isn't launch. It's the finale." (Vol. 02)
- "Your likes are lying to you." (Vol. 03)
- "Your brief is killing the campaign." (Vol. 04)
- "Most artists post songs too early." (Vol. 01)

All four are **single sentences**, **provocative**, and **read like a magazine cover line, not an ad**. That's the voice. Don't slip into "Did you know..." or "Here are 5 tips..." — that's AI-obvious and Eric will reject it (see §8 — his "no AI-obvious writing" feedback memory).

---

## 6. The workflow — adding a new carousel

This is the playbook. Follow it exactly.

### Step 1: Define the concept
Write down (in chat or as a comment) the four lines:
- **Hook** — 1 sentence, provocative, single thought
- **Build** — 2–3 lines that prove the hook
- **Payoff** — 1 receipt / stat / takeaway
- **CTA** — 1 ask, low-friction

Then write down the **sources**:
- What data informs the Payoff?
- What pattern / formula informs the Hook? (Undertow? Mon Rovia playbook? Alexandria entry?)
- What case study / portfolio data informs the Build?

If you can't list at least 2 sources, the concept isn't ready. Eric will ask.

### Step 2: Build the preview HTML in this repo
- Copy `preview-pre-release-curiosity.html` as a starting scaffold
- Save as `preview-{slug}.html` (kebab-case, no dates yet — dates go on the locked file name later)
- Update the masthead `VOL. XX` (next sequential — currently Vol. 04 is highest)
- Pick a unique bloom orientation (§4.4)
- Write the 4 slides
- Add a `.refbar` div at the bottom listing all sources (mono font, dashed border, `b` tag on the word `SOURCES`)

### Step 3: Inline into RT Pocket
This is **non-negotiable** — every new preview must be reviewable on Eric's phone.

**File:** `~/Projects/active/rt-pocket/index.html`
**Skill reference:** `~/.claude/skills/rt-pocket/SKILL.md`
**Session doc (full architecture):** `~/Documents/Obsidian Vault/Rising Tides OS/Session Logs/2026-05/session-2026-05-18/RT-Pocket-And-Carousel-Build.md`

**The two diffs when inlining:**
1. **Strip the `<link rel="stylesheet" href="./brand/_brand.css">`** — the iframe `srcdoc` can't resolve relative paths. The preview HTML already has all styles inline, so this step is usually a no-op if you started from one of the existing preview files. Verify there are zero `./brand/` references.
2. **Replace any logo SVG `<img>`** with a text mark (`★ RISING TIDES`) — see how `preview-midnight-press.html` was inlined into the `panel-carousel-midnight-press` script block.

**Three edits to `index.html`:**

A. **Add a drawer card in `<main id="home">`**, in the Panels section:
```html
<a class="card-link" href="#carousel-{slug}" data-panel="carousel-{slug}">
  <div class="card">
    <h3>Vol. 0X <span class="chev">›</span></h3>
    <p class="big">Your concept name</p>
    <p class="sub">One-line description · 4 slides · src: ...</p>
  </div>
</a>
```

B. **Add the panel definition** above the `<!-- ============ APP SCRIPT ============ -->` comment:
```html
<script type="text/html" id="panel-carousel-{slug}" data-title="Vol. 0X · Your Title">
<!doctype html>
<html lang="en">
... your entire preview file content here ...
</html>
</script>
```

C. **Bump `version.txt`**:
```bash
# read it, increment NNN
echo "2026-05-18-006" > ~/Projects/active/rt-pocket/version.txt
```
Phone hot-reloads in ≤2 seconds.

### Step 4: Update AGENTS.md
Add a row to the **Working Previews** table. Slug, format, status, one-line description, sources list.

### Step 5: Tell Eric
One line:
> pushed Vol. 0X · {slug} · {one-clause why}

That's it. No preamble. He'll open Pocket on his phone and tell you what to tweak.

### Step 6: Iterate
Eric reviews on Pocket → tells you what to change → you edit BOTH `preview-{slug}.html` AND the `panel-carousel-{slug}` inline block in `index.html` (keep them in sync), then bump `version.txt` again.

### Step 7: When copy/design is locked
Rename `preview-{slug}.html` → `rt-carousel-[format]-[slug]-[YYYY-MM-DD].html` per the AGENTS.md spec. Screenshot each 1080×1350 slide to PNG for upload. Mark status as **shipped** in the Working Previews table.

---

## 7. RT Pocket integration — the rules you cannot break

Pocket is the daily-driver review surface. Eric checks carousels on his phone, in Telegram, while doing other things. **If your carousel can't be opened on Pocket, it doesn't exist yet.**

Hard rules (from `~/.claude/skills/rt-pocket/SKILL.md`):

- ❌ **NEVER create sibling HTML files** in `~/Projects/active/rt-pocket/` (e.g. `carousels/foo.html`). The static server / Cloudflare tunnel only reliably serves the root `index.html`. Subpaths 404 inside Telegram's webview.
- ❌ **NEVER touch the Telegram bot** (`rt-telegram-bot`). Pocket is a decoupled sidecar.
- ❌ **NEVER introduce a build step.** Single-file HTML by design.
- ❌ **NEVER push without bumping `version.txt`.** The phone polls every 2 seconds — without a bump it doesn't reload.
- ✅ **DO** inline every visual as a `<script type="text/html" id="panel-{slug}">` block in `index.html`.
- ✅ **DO** verify the push with: `curl -sS https://pocket.risingtidesviral.com/version.txt` — should return the new version.

**If Pocket is 404ing:** the static server probably died (Mac sleep). Restart:
```bash
cd ~/Projects/active/rt-pocket && \
  nohup python3 -m http.server 4242 --bind 127.0.0.1 > /tmp/rt-pocket-server.log 2>&1 &
disown
```

**If only some requests 404 (intermittent):** the cloudflared tunnel has stale connectors. Fix (this was actually run on 2026-05-18):
```bash
cloudflared tunnel cleanup c14684ef-26dd-4991-9806-93ec9b24ff09
# then re-launch with explicit config + tunnel ID:
nohup /opt/homebrew/bin/cloudflared tunnel --config ~/.cloudflared/config.yml run c14684ef-26dd-4991-9806-93ec9b24ff09 > /tmp/cloudflared-pocket.log 2>&1 &
disown
```

The launchd plist at `~/Library/LaunchAgents/com.risingtides.cloudflared.plist` runs `cloudflared tunnel run` with no args, which loses the config in some restart scenarios. **Known issue, not yet fixed in the plist.** Flag to Eric when relevant.

---

## 8. Open questions — Eric has NOT decided these yet

Do not pick on your own. These are pending his review:

### 8.1 The numbers in Vol. 03 and Vol. 04 are placeholders
- **Vol. 03 ("Save Economy")** cites `24-38%` save:like ratio for RT's top-quartile posts. **This is a stylized pattern, not real data.** Eric needs to decide: pull real numbers from Notion / Postiz analytics, OR keep stylized.
- **Vol. 04 ("Influencer Campaigns")** cites `3–5×` engagement for native vs. scripted creator reads. **Same — stylized pattern.** Real numbers would come from RT campaign portfolio in Notion.

**If Eric asks you to fetch real numbers:** the canonical source is Notion (RT CRM). See `mcp__293e2e71-...__notion-search` tools or `gws drive` for sheets. Do NOT make up numbers — replace them with real data or change the claim to a qualitative one.

### 8.2 Hook voice calibration
Eric flagged in feedback (memory: `no AI-obvious writing`) that copy can drift into generic "punchy AI prose." Watch for:
- Triplet structures: "It's not X. It's Y. It's Z." → suspect
- Overused contrarian openers: "Most X..." / "Stop doing Y..." → suspect
- "Did you know..." / "Here are 5..." → reject

The Midnight Press voice is **magazine-cover declarative** — one short sentence, confident, no setup. If you find yourself writing more than 12 words for a Hook, you're explaining instead of asserting.

### 8.3 Sources placement
Currently the `.refbar` (sources) sits **below the slide grid** in the preview, *not* as a slide itself. **Open question:** should it become a 5th slide that ships with the post (so receipts travel with the carousel on IG/TT)?

Tradeoff: adding it as a slide → slower swipe completion (algorithm penalty). Keeping it as preview-only → screenshots don't carry receipts. Eric leans toward "5th slide for case-file carousels (like Vol. 01), preview-only for value carousels," but hasn't confirmed.

### 8.4 Slide structure variant
Eric asked about trying a **5-slide Hook → Story → Lesson → Receipt → CTA** structure for one of the carousels (as a test against the current 4-slide H/B/P/C). No decision yet. Vol. 02 is the natural candidate to A/B test because the Mon Rovia tease arc has a clear "Story" beat.

### 8.5 Brand split
Open question: do we need a **sister brand for RT Viral course content** (different masthead, slightly warmer palette), separate from the agency Midnight Press? Right now everything is one brand. Eric flagged but hasn't decided.

### 8.6 Git hygiene
4 untracked previews + 2 modified docs are unstaged. `.DS_Store` is in the repo (should be gitignored). Eric asked the prior agent about committing — he hasn't answered yet. **Do not commit without his go-ahead.**

---

## 9. Voice and tone — read this carefully

Eric's memory has multiple `feedback_*` entries about how to communicate. Apply them when generating Hook / Build / Payoff / CTA copy:

| Memory | Implication for carousel copy |
|---|---|
| `feedback_no_ai_obvious_writing` | No "Here are 5..." / "Did you know..." / triplet rhythms. Single declarative cover lines. |
| `feedback_grounded_recommendations` | No grandiose analogies. No "this changes everything." Keep claims proportional and credible. |
| `feedback_platform_specificity` | If a carousel is about TikTok, stay TikTok-specific. Don't say "social media." |
| `feedback_no_credential_leaks` | Never embed API keys or real campaign budget numbers in a public-facing carousel until §6 of SKILL.md hardening is in place. |
| `feedback_fast_build_timelines` | Don't propose a 3-week "carousel system redesign." Ship one preview, iterate. |
| `feedback_check_prior_work_first` | Before generating a new concept, search Alexandria + this repo for prior takes on the same topic. Don't repeat what's already been said. |

When Eric reviews a draft, his feedback will be **terse and directional** ("hook lands · payoff weak · pull real numbers"). Don't overexplain back. Edit, push, report in one line.

---

## 10. References (read these on demand, not upfront)

- **Full project spec** → [AGENTS.md](AGENTS.md) (same content as `CLAUDE.md`; keep them in sync)
- **Brand system** → [brand/_brand.css](brand/_brand.css), [brand/logos/](brand/logos/)
- **RT Pocket skill (the review surface)** → `~/.claude/skills/rt-pocket/SKILL.md`
- **Session log — full Pocket + carousel architecture in one doc** → `~/Documents/Obsidian Vault/Rising Tides OS/Session Logs/2026-05/session-2026-05-18/RT-Pocket-And-Carousel-Build.md` (14 sections, ~780 lines)
- **Global RT Claude instructions** → `~/.claude/CLAUDE.md` (Anti-patterns, Library of Alexandria protocol, agentic OS layers)
- **Memory index** → `~/.claude/projects/-Users-ericcromartie-May-Work/memory/MEMORY.md` (Eric's feedback patterns, user prefs, project context)
- **Alexandria knowledge base** → `~/Documents/Obsidian Vault/Alexandria/` (Content Strategy folder is most relevant for new concepts)
- **Undertow viral formulas** → invoke via `/undertow` skill or read `~/.claude/skills/undertow/` for the 16 principles / 13 formulas that inform hook construction

---

## 11. Common failure modes (don't trip these)

1. **Editing `index.html` without bumping `version.txt`** → Eric's phone won't see your update. He'll think nothing changed and ask why.
2. **Letting `preview-{slug}.html` and the inlined `panel-carousel-{slug}` drift out of sync.** They must be functionally identical at all times. Pick one as source-of-truth — Eric uses the inlined Pocket version as final, repo file as draft — so when iterating, update both in the same edit pass.
3. **Including external `<link>` or relative `<img src="./...">` paths inside an inlined panel.** They break inside `srcdoc`. Inline all CSS, replace SVG logos with text marks.
4. **Including a literal `</script>` anywhere in the panel body** (e.g. inside a JS string). Breaks the wrapping `<script type="text/html">` tag. Escape as `<\/script>`.
5. **Posting placeholder numbers as if they were real.** The `24-38%` save:like and `3–5×` native-vs-scripted in Vol. 03/04 are *patterns*, not measured RT data. If Eric green-lights the copy, you must validate the numbers before any of these ship to IG.
6. **Falling into AI-voice on the Hook.** "In today's algorithm-driven landscape..." → instant reject. Read the existing Hooks aloud. They sound like a magazine cover. Yours should too.
7. **Committing the repo without confirmation.** Eric has not okayed a commit yet. Do not run `git commit` unless he explicitly says so.

---

## 12. Quick-start checklist for next session

When Eric says "let's keep going with the carousels":

- [ ] Check Pocket is up: `curl -sS https://pocket.risingtidesviral.com/version.txt` should return `2026-05-18-005` or later
- [ ] If 404, run §7 troubleshooting
- [ ] Read this doc, then [AGENTS.md](AGENTS.md) for spec depth
- [ ] Ask Eric: *"Which of the 4 fine-tuning angles do you want first — copy, real numbers, slide structure, or brand split?"* (mapped to §8.1–8.5)
- [ ] When iterating, **edit both** the repo `preview-{slug}.html` AND the Pocket `panel-carousel-{slug}` block, then bump version
- [ ] One-line receipt to Eric after each push: `pushed Vol. 0X · {slug} · {one-clause why}`

---

**End of handoff. Welcome aboard.**
