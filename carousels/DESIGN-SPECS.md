# Midnight Press — Design Specs

**Brand system:** Midnight Press
**Owner:** Rising Tides Entertainment — `@risingtides.ent`
**Mantra:** Dark newsprint. Late edition. Something just happened and we're the first to write it down.

> Pure design reference — visual language only. No content structure, no copy rules, no pipeline.

---

## 1. Design Tokens

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

### Accent gradient (rare — 1–2 words per composition)

```css
background: linear-gradient(180deg, #F3EAD4 0%, #EAC9FF 55%, #8500D7 100%);
-webkit-background-clip: text;
color: transparent;
```

It's the exclamation point of the design system. Overuse kills it.

### Color ratios

**70%** paper (dark stock) / **20%** ink (type & rules) / **7%** violet+magenta (bloom, accents) / **3%** gold+red (seals, emphasis)

---

## 2. Typography

### Scale (reference: 1080 × 1350 canvas)

| Level | Size | Family | Notes |
|-------|------|--------|-------|
| Hero numeral | 280–360px | Display | 1 per composition max |
| Headline | 120–200px | Display | Uppercase, tight-tracked, `0.82–0.88` line-height |
| Subhead | 48–70px | Display | Uppercase |
| Body lede | 28–34px | Serif | Italic for pull-quotes |
| Body | 18–24px | Serif | `line-height: 1.3` |
| Label / kicker | 11–14px | Mono | Uppercase, `0.24–0.32em` tracking |
| Hand note | 26–34px | Hand | Rotate ±2 max |

### Four roles — don't invent a fifth

- **Display** — always uppercase, tight-tracked, heavy. **Never drop-shadow** — the page glows, the letters stay crisp.
- **Mono** — always uppercase, wide letter-spacing.
- **Serif** — mixed-case. Italic = editorial pull-quote voice.
- **Hand** — lowercase, first-person, fragmentary. ±2 rotation max.
- **Never underline. Ever.**

---

## 3. Texture Stack (all required — strip these and it's not Rising Tides)

1. **Glow pools** — large radial blooms (violet top-right, magenta bottom-left, ~800–1100px, blur 40px). Background layer only (`z-index: 0`). **Never on text.**
2. **Paper fibre** — fractal-noise SVG, screen blend, ~35% opacity.
3. **Ink specks** — coarse fractal noise, multiply blend, ~50% opacity.
4. **Scanlines** — 1px horizontal repeating gradient, overlay blend, ~22% opacity.
5. **Vignette** — `inset box-shadow: 0 0 260px rgba(0,0,0,0.75)`.

If it looks "clean digital," it's wrong.

---

## 4. Editorial Furniture

- **Masthead** — Star + `RISING TIDES · THE MIDNIGHT PRESS` (mono, 0.32em tracked) left; `VOL. 0X` right. Hairline rule below.
- **Footer** — `@risingtides.ent` · caption · slide counter. Hairline rule above.
- **Section markers** — `§ 01 ——— The setup` (mono, uppercase, 0.3em tracked).
- **Stamps** — rubber-stamp rectangles. Gold (`Confidential`, `Verified`), magenta (`Tactic 01`, `End / Vol. 01`), violet (rare). Rotated −10 to +10. Stay within safe margin.
- **Tape** — cream or violet-gradient washi-tape chips with mono text. Slight rotation.
- **Redactions** — solid cream bars with violet glow. **Rare** — for mystery, not decoration.
- **Crop marks** — 16px `+` at photo corners.
- **Hand-scrawl notes** — lowercase, fragmentary, ±2 rotation.

---

## 5. Photo Treatment

Three modes:

- **Duotone** (default) — grayscale + `linear-gradient(150deg, magenta55, violetaa, paper)` screen wash
- **Halftone** — grayscale + radial-gradient dot screen at 4px pitch, multiply blend
- **Full color** — untouched except contrast 1.05 + grain + edge glow

---

## 6. Canvas & Grid

| Context | Dimensions | Safe margin |
|---------|-----------|-------------|
| IG carousel | 1080 × 1350 (4:5) | 60px sides, 40px top/bottom |
| IG square | 1080 × 1080 | 60px all sides |

---

## 7. Non-Negotiables

- Headlines stay **crisp** — the page glows, the letters do not.
- Only **1–2 emphasis words** per composition take the accent gradient.
- Bloom pools are always **background layer** (`z-index: 0`). They never touch type.
- Stamps and tape stay **within the safe margin**.
- Redaction is **rare**. Overused, it's a gimmick.
- **No emoji.** Gold star in mono strings is the only exception.
- The **mark is never modified** — one color, one silhouette, every time.
- **Voice > decoration.** Always.
