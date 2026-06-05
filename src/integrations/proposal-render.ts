/**
 * Proposal HTML renderer.
 *
 * Ports the locked Rising Tides "Midnight Press" house-style proposal template
 * (the Shaboozey/Cowgirl reference) into the Worker, driven by the PRD that
 * composeProposal() produces. Output is a self-contained HTML document hosted on
 * R2 and served as a live link — so embedded hyperlinks (Spotify, profiles)
 * stay clickable, unlike a flattened PDF.
 *
 * Design discipline (mirrors proposal-skill-principles.md):
 *   - Never fabricate. Missing fields render as "TBD", never invented numbers.
 *   - Brand kit is hardcoded and not up for negotiation by the model.
 */

import type { ProposalOutput } from "../lib/anthropic";

type Prd = ProposalOutput["prd"];

export function renderProposalHtml(
  proposal: ProposalOutput,
  opts: { confidentialFor?: string } = {},
): string {
  const prd = normalizePrd(proposal.prd);
  const artist = prd.artist;
  const client = opts.confidentialFor ?? artist.label ?? artist.name;

  const heroHeadline = accentLastWord(prd.headline);
  const ctx = `${esc(artist.name)} · ${esc(artist.genre || "—")}${artist.label ? ` · ${esc(artist.label)}` : ""}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Rising Tides Proposal — ${esc(artist.name)}</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Bodoni+Moda:opsz,wght@6..96,500;6..96,700&family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>
  :root{
    --rt-paper:#0B0710; --rt-paper-2:#140A1C; --rt-ink:#F3EAD4; --rt-ink-2:#D9CEB4;
    --rt-mute:rgba(243,234,212,.62); --rt-mute-lo:rgba(243,234,212,.38); --rt-rule:rgba(243,234,212,.22);
    --rt-violet:#8500D7; --rt-magenta:#E100C3; --rt-glow-v:rgba(149,70,255,.55); --rt-glow-m:rgba(225,0,195,.38);
    --rt-accent:#C9A85F; --rt-red:#C8301C;
    --rt-display:'Archivo Black','Anton',Impact,sans-serif; --rt-serif:'Bodoni Moda','Playfair Display',Georgia,serif;
    --rt-mono:'JetBrains Mono',ui-monospace,monospace; --rt-sans:'Inter',system-ui,sans-serif;
  }
  *{box-sizing:border-box} body{margin:0;background:#050308;color:var(--rt-ink);font-family:var(--rt-sans);}
  .rt-proposal{position:relative;isolation:isolate;min-height:100vh;overflow:hidden;background:var(--rt-paper);color:var(--rt-ink);}
  .rt-proposal:before{content:"";position:fixed;inset:-18%;z-index:-5;background:
    radial-gradient(900px 900px at 84% 10%, var(--rt-glow-v), transparent 58%),
    radial-gradient(900px 900px at 6% 86%, rgba(201,168,95,.23), transparent 54%),
    radial-gradient(820px 820px at 12% 22%, rgba(225,0,195,.19), transparent 58%),
    linear-gradient(180deg,#0B0710 0%,#140A1C 56%,#09050d 100%);}
  .rt-proposal:after{content:"";position:fixed;inset:0;z-index:-4;pointer-events:none;opacity:.36;mix-blend-mode:screen;background-image:
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='170' height='170'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.78' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='170' height='170' filter='url(%23n)' opacity='.44'/%3E%3C/svg%3E"),
    repeating-linear-gradient(to bottom, transparent 0, transparent 3px, rgba(255,255,255,.035) 4px);}
  .rt-vignette{position:fixed;inset:0;z-index:-3;pointer-events:none;box-shadow:inset 0 0 260px rgba(0,0,0,.78)}
  .wrap{max-width:1240px;margin:0 auto;padding:48px 44px 72px}.grid12{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:18px}.rule{border-color:var(--rt-rule)}
  .mono{font-family:var(--rt-mono);letter-spacing:.24em;text-transform:uppercase}.display{font-family:var(--rt-display);text-transform:uppercase;letter-spacing:-.045em;line-height:.86}.serif{font-family:var(--rt-serif)}
  .accent{background:linear-gradient(180deg,#F3EAD4 0%,#EAC9FF 56%,#8500D7 100%);-webkit-background-clip:text;background-clip:text;color:transparent}.gold{color:var(--rt-accent)}.muted{color:var(--rt-mute)}.soft{color:var(--rt-ink-2)}
  .card{background:rgba(20,10,28,.76);border:1px solid var(--rt-rule);box-shadow:0 0 85px rgba(133,0,215,.08) inset,0 24px 80px rgba(0,0,0,.24)}
  .stamp{display:inline-flex;border:1px solid var(--rt-accent);color:var(--rt-accent);padding:.42rem .72rem;font-family:var(--rt-mono);letter-spacing:.18em;text-transform:uppercase;font-size:10px;transform:rotate(-3deg)}
  .mark{width:38px;height:38px;display:inline-block;vertical-align:middle}.budget{font-family:var(--rt-display);font-variant-numeric:tabular-nums;letter-spacing:-.065em;line-height:.88;white-space:nowrap}
  .photo{position:relative;min-height:470px;overflow:hidden;background:#140A1C}.photo img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 18%;filter:grayscale(.12) contrast(1.08) brightness(.8)}
  .photo:after{content:"";position:absolute;inset:0;background:linear-gradient(145deg,rgba(201,168,95,.14),rgba(133,0,215,.28) 48%,rgba(11,7,16,.78));mix-blend-mode:screen}.photo .tag{position:absolute;left:22px;bottom:22px;z-index:2}
  .mini{font-size:12px;line-height:1.55}.creator-row{display:grid;grid-template-columns:1fr auto;gap:14px;align-items:baseline;border-top:1px solid var(--rt-rule);padding:12px 0}.num{font-variant-numeric:tabular-nums}.footer-note{border-top:1px solid var(--rt-rule);padding-top:18px;color:var(--rt-mute);font-size:11px;line-height:1.6}
  a{color:var(--rt-accent);text-decoration:none;border-bottom:1px solid rgba(201,168,95,.4)}
  @media(max-width:900px){.wrap{padding:30px 20px}.grid12{display:block}.grid12>*{margin-bottom:18px}.display{font-size:54px!important}.photo{min-height:340px}.budget{font-size:64px!important}.creator-row{grid-template-columns:1fr auto}}
  @media print{body{background:#fff}.wrap{max-width:none;padding:.45in}.rt-proposal{background:#0B0710}.rt-vignette{display:none}}
</style>
</head>
<body>
<div class="rt-proposal"><div class="rt-vignette"></div><main class="wrap">
  <header class="grid12 border-b rule pb-5 mb-14">
    <div class="col-span-7 mono text-[11px] muted"><span class="mark">★</span> Rising Tides · The Midnight Press</div>
    <div class="col-span-5 mono text-[11px] text-right muted">${ctx}</div>
  </header>

  <section class="grid12 items-end border-b rule pb-14 mb-12">
    <div class="col-span-12 ${artist.imageUrl ? "lg:col-span-8" : ""}">
      <p class="mono text-xs muted mb-5">${esc(artist.genre || "Campaign proposal")} · curated roster</p>
      <h1 class="display text-[70px] md:text-[88px] max-w-4xl">${heroHeadline}</h1>
      <p class="serif text-3xl leading-tight soft max-w-3xl mt-7">${esc(prd.subheadline)}</p>
    </div>
    ${artist.imageUrl ? `<div class="col-span-12 lg:col-span-4 card p-0 overflow-hidden">
      <div class="photo">
        <img alt="${esc(artist.name)}" src="${esc(artist.imageUrl)}" />
        <div class="tag"><p class="mono text-[10px] muted mb-2">Artist</p><p class="serif text-2xl soft">${esc(artist.name)}</p></div>
      </div>
    </div>` : ""}
  </section>

  <section class="grid12 mb-16">
    <div class="col-span-3"><p class="mono text-xs muted">01 — Recommendation</p></div>
    <div class="col-span-9">
      <p class="serif text-[30px] leading-tight soft max-w-4xl">${esc(prd.campaignStrategy.approach || prd.whyNow)}</p>
      <div class="grid12 mt-8">
        <div class="col-span-4 card p-5"><p class="mono text-[10px] muted mb-3">Why now</p><p class="mini soft">${esc(prd.whyNow)}</p></div>
        <div class="col-span-4 card p-5"><p class="mono text-[10px] muted mb-3">Platforms</p><p class="mini soft">${esc(prd.campaignStrategy.platforms.join(" · ") || "TBD")}</p></div>
        <div class="col-span-4 card p-5"><p class="mono text-[10px] muted mb-3">Formats</p><p class="mini soft">${esc(prd.campaignStrategy.contentFormats.join(" · ") || "TBD")}</p></div>
      </div>
    </div>
  </section>

  <section class="grid12 border-y rule py-12 mb-16">
    <div class="col-span-3"><p class="mono text-xs muted">02 — Budget options</p></div>
    <div class="col-span-9 grid md:grid-cols-2 gap-5">
      ${renderBudgetOptions(prd)}
    </div>
  </section>

  <section class="grid12 mb-16">
    <div class="col-span-3"><p class="mono text-xs muted">03 — Creator roster</p><p class="mt-5 serif text-xl soft">${esc(prd.creatorRoster.targetCount)} creators. Chosen for where they sit in the culture, not the number on their dashboard.</p></div>
    <div class="col-span-9 card p-6">
      ${renderRoster(prd)}
    </div>
  </section>

  <section class="grid12 border-t rule pt-10 mb-16">
    <div class="col-span-3"><p class="mono text-xs muted">04 — Before launch</p></div>
    <div class="col-span-9 card p-6">
      <div class="grid md:grid-cols-2 gap-x-8 gap-y-3 text-sm soft">
        ${prd.beforeLaunch.map((item, i) => `<div class="creator-row"><span>${esc(item)}</span><span class="mono text-[10px] muted">${pad(i + 1)}</span></div>`).join("\n        ") || `<div class="creator-row"><span class="muted">TBD</span></div>`}
      </div>
    </div>
  </section>

  <section class="grid12 border-t rule pt-10">
    <div class="col-span-3"><p class="mono text-xs muted">05 — Email draft</p></div>
    <div class="col-span-9 serif text-2xl leading-snug soft">
      ${(proposal.followUpEmail ?? "").split(/\n{2,}/).filter((p) => p.trim()).map((p) => `<p>${esc(p.trim())}</p>`).join("\n      ")}
      <p class="footer-note mono mt-10">Rising Tides · confidential draft · prepared for ${esc(client)}</p>
    </div>
  </section>
</main></div>
</body>
</html>`;
}

// Claude validation only guarantees a handful of fields; coerce every array and
// nested object the template touches so a sparse PRD never throws at render time.
function normalizePrd(prd: Prd): Prd {
  const cs = prd.campaignStrategy ?? ({} as Prd["campaignStrategy"]);
  const cr = prd.creatorRoster ?? ({} as Prd["creatorRoster"]);
  const tl = prd.timeline ?? ({} as Prd["timeline"]);
  return {
    ...prd,
    artist: prd.artist ?? ({} as Prd["artist"]),
    campaignStrategy: {
      ...cs,
      platforms: cs.platforms ?? [],
      creatorTypes: cs.creatorTypes ?? [],
      contentFormats: cs.contentFormats ?? [],
    },
    budgetOptions: prd.budgetOptions ?? [],
    creatorRoster: {
      ...cr,
      niches: cr.niches ?? [],
      specificNames: cr.specificNames ?? [],
    },
    timeline: { ...tl, milestones: tl.milestones ?? [] },
    beforeLaunch: prd.beforeLaunch ?? [],
    proofPoints: prd.proofPoints ?? [],
  };
}

function renderBudgetOptions(prd: Prd): string {
  if (!prd.budgetOptions.length) {
    return `<article class="card p-7"><p class="mono text-xs muted mb-8">Budget</p><div class="budget text-[64px] muted">TBD</div><p class="mini soft mt-6">Budget not yet discussed — to be confirmed before launch.</p></article>`;
  }
  return prd.budgetOptions
    .map((opt, i) => {
      const featured = i === prd.budgetOptions.length - 1 && prd.budgetOptions.length > 1;
      return `<article class="card p-7 overflow-hidden"${featured ? ` style="border-color:rgba(201,168,95,.72)"` : ""}>
        <p class="mono text-xs muted mb-8">${esc(opt.name)}</p>
        <div class="budget text-[84px]${featured ? " gold" : ""}">${esc(opt.amount)}</div>
        <div class="border-t rule mt-7 pt-6 space-y-4 text-sm soft">
          <p><b style="color:var(--rt-ink)">Scope:</b> ${esc(opt.scope)}</p>
          <p><b style="color:var(--rt-ink)">Volume:</b> ${esc(opt.creatorCount)}</p>
        </div>
      </article>`;
    })
    .join("\n      ");
}

function renderRoster(prd: Prd): string {
  const names = prd.creatorRoster.specificNames.filter(Boolean);
  const reach = prd.creatorRoster.combinedReachTarget;
  const nichesLine = prd.creatorRoster.niches.length
    ? `<div class="border-t rule mt-6 pt-6 grid12 items-end"><div class="col-span-8"><p class="mono text-xs muted">Niches</p><p class="mini soft mt-2">${esc(prd.creatorRoster.niches.join(" · "))}</p></div>${reach ? `<div class="col-span-4 text-right"><p class="mono text-[10px] muted">Combined reach</p><p class="budget text-[40px] gold">${esc(reach)}</p></div>` : ""}</div>`
    : "";

  if (!names.length) {
    return `<p class="serif text-xl soft">Roster hand-picked post-approval — ${esc(prd.creatorRoster.targetCount)} across ${esc(prd.creatorRoster.niches.join(", ") || "target niches")}.</p>${nichesLine}`;
  }

  const mid = Math.ceil(names.length / 2);
  const col = (list: string[]) =>
    list.map((n) => `<div class="creator-row"><span>${esc(n.startsWith("@") ? n : "@" + n)}</span><span class="num gold muted">—</span></div>`).join("\n          ");

  return `<div class="grid md:grid-cols-2 gap-x-8">
        <div>${col(names.slice(0, mid))}</div>
        <div>${col(names.slice(mid))}</div>
      </div>${nichesLine}`;
}

// Accent the final word of the headline, mirroring the reference template's
// single highlighted word. Falls back to the whole string if it's one word.
function accentLastWord(headline: string): string {
  const safe = esc(headline);
  const parts = safe.trim().split(/\s+/);
  if (parts.length < 2) return safe;
  const last = parts.pop() as string;
  return `${parts.join(" ")} <span class="accent">${last}</span>`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function esc(s: string | null | undefined): string {
  if (s == null) return "TBD";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
