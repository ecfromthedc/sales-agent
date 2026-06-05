# Henry — Targeting Profile & Lead Scoring Matrix

**Purpose:** This document defines exactly who Rising Tides sells to, what makes a lead high-value, and how to filter 2M+ leads down to the 200 that matter. Henry uses this as its scoring rubric.

---

## 1. Ideal Client Profile (ICP)

### Tier 1: Major Label Imprints (Highest Value)

These are RT's bread and butter. Label-level relationships where a single point of contact controls budgets for 10-50+ artists.

| Attribute | Criteria |
|-----------|----------|
| **Type** | Major label imprint, division, or subsidiary |
| **Parent Groups** | Warner Music Group, Sony Music, Universal Music Group |
| **Budget Range** | $5K-$50K per campaign |
| **Decision Maker** | A&R, Digital Marketing Director, VP of Marketing |
| **Buying Signal** | Active release schedule (≥1 release/month across roster) |
| **Why They Buy** | Need scale fast — 20-50 creators per campaign, can't manage in-house |

**Known Relationships:**
- Warner Records (51 artists worked) — primary contact: Allen Koyano
- Empire (3 artists)
- Atlantic (1 artist)
- Columbia (2 artists)
- Sony Music — domain: @sonymusic.com
- UMG — domain: @umusic.com
- Mega House Music — contact: Haley

**Expansion Pattern:** Once RT lands one artist at a label, the play is servicing more of that roster. Henry should always check: "do we already work with someone at this label?"

### Tier 2: Large Independent Labels

Mid-size labels with real marketing budgets but no in-house UGC team.

| Attribute | Criteria |
|-----------|----------|
| **Type** | Independent label, 20-200 artists on roster |
| **Revenue Indicator** | Multiple artists with 100K+ Spotify monthly listeners |
| **Budget Range** | $1.5K-$15K per campaign |
| **Decision Maker** | Label owner, marketing manager, or artist manager |
| **Buying Signal** | Regular release cadence + growing Spotify numbers |
| **Why They Buy** | Know they need TikTok/IG but don't have creator relationships |

**Examples of This Tier:**
- Nettwerk Music Group (Mon Rovia's label)
- 300 Entertainment
- Quality Control
- Top Dawg Entertainment
- Stones Throw
- Secretly Canadian
- Merge Records
- Sub Pop

### Tier 3: Artist Managers & Management Companies

Managers who control marketing budgets for 3-10 artists.

| Attribute | Criteria |
|-----------|----------|
| **Type** | Management company or individual manager |
| **Artist Count** | 3-10 artists under management |
| **Budget Range** | $1.5K-$10K per campaign |
| **Decision Maker** | Manager directly |
| **Buying Signal** | Artist hitting inflection point (first radio play, sync placement, festival booking) |
| **Why They Buy** | Need promotional firepower for a specific release moment |

### Tier 4: Independent Artists (Course Funnel)

Not direct service clients — these feed into RT Viral course sales at $997.

| Attribute | Criteria |
|-----------|----------|
| **Type** | Self-releasing independent artist |
| **Follower Range** | 1K-50K across platforms |
| **Budget Range** | $997 (course) or $1.5K (starter campaign) |
| **Buying Signal** | Active on socials, releasing music, asking "how do I grow?" |
| **Why They Buy** | Education-first — need to learn before they can buy services |

---

## 2. Artist Targeting Filters (For Label Roster Scans)

When Henry scans a label's roster to find artists RT should pitch campaigns for, use these filters:

### Sweet Spot Artist Profile

| Metric | Range | Why |
|--------|-------|-----|
| **Spotify Monthly Listeners** | 10K - 500K | Below 10K = budget too small. Above 500K = usually has in-house team |
| **Spotify Followers** | 5K - 200K | Follower-to-listener ratio indicates real fanbase vs. playlist fluff |
| **TikTok Followers** | Any (including 0) | Labels often need TikTok specifically because the artist has no presence there |
| **Instagram Followers** | 5K+ | Below 5K usually means the label isn't investing in this artist yet |
| **Release Recency** | Released within 90 days OR upcoming release | No point pitching an artist with no release on the horizon |
| **Genre** | Hip-hop, R&B, Pop, Indie, Afrobeats, Latin, Electronic | RT has proven results here. Country/Classical/Jazz = lower fit |

### Disqualifying Signals

- Artist has >1M Spotify monthly listeners AND >500K TikTok followers (they already have a team)
- Artist hasn't released in 12+ months (dormant)
- Label is known to do everything in-house (e.g., HYBE, some major pop divisions)
- Artist is in an active controversy or legal dispute
- Genre is classical, jazz, or worship (no creator network for these)

### Priority Multipliers

| Signal | Multiplier | Reasoning |
|--------|-----------|-----------|
| We already work with this label | 3x | Warm intro, proven trust |
| Artist has upcoming release (14-28 days) | 2.5x | Perfect timing window |
| Artist just got a sync/playlist/press placement | 2x | Label is investing, momentum is real |
| Artist has no TikTok presence but strong Spotify | 2x | Obvious pain point we solve |
| Same A&R as another RT client | 1.5x | Relationship leverage |
| Genre match with top-performing RT campaigns | 1.5x | Can show case studies |

---

## 3. Campaign Type Matching

When Henry identifies a lead, classify what RT would likely sell them:

### Sound Campaign ($1,500+, 50% margin)
- **Best for:** Single releases, album lead singles, playlist pushes
- **Artist profile:** Any tier, active release
- **Pitch angle:** "Drive streams and saves through authentic creator content"
- **Success metric:** CPM, saves, Spotify streams lift

### Page Management ($1,500-$2,500/mo, 75-80% margin)
- **Best for:** Labels wanting ongoing presence, not just one-off campaigns
- **Artist profile:** Mid-tier artists who need consistent content
- **Pitch angle:** "We run your TikTok/IG like it's our own page"
- **Success metric:** Follower growth, engagement rate, content cadence

### Full Campaign Package ($5K-$15K)
- **Best for:** Major releases, album rollouts, tour promo
- **Artist profile:** Label-backed with real budget
- **Pitch angle:** "20-50 creators, multi-platform, managed end-to-end"
- **Success metric:** Total views, CPM, engagement, measurable stream lift

---

## 4. Scoring Rubric (0-100)

Henry uses this exact rubric when `scoreLeads()` runs:

| Factor | Weight | 0 pts | 25 pts | 50 pts | 75 pts | 100 pts |
|--------|--------|-------|--------|--------|--------|---------|
| **Label Relationship** | 30% | Unknown label | Same parent group | Past client label | Active client (different division) | Active client (same team) |
| **Timing** | 25% | No upcoming release | Release 60+ days out | Release 30-60 days | Release 14-28 days | Release this week |
| **Genre Fit** | 15% | No RT experience | Adjacent genre | Genre we've done 1-2x | Strong genre track record | Top-performing genre |
| **Artist Tier Fit** | 15% | <5K or >1M ML | 5-10K ML | 10-50K ML | 50-200K ML | 200-500K ML |
| **Budget Indicator** | 15% | Indie, no label backing | Small indie label | Mid-size indie | Major label subsidiary | Major label direct |

**Score Thresholds:**
- **80-100:** Hot lead — draft outreach immediately, flag Eric
- **60-79:** Warm lead — queue for weekly outreach batch
- **40-59:** Watch list — track release cadence, revisit when timing improves
- **Below 40:** Pass — don't waste outreach on this

---

## 5. Outreach Persona & Voice

Henry drafts emails FROM Eric (`ec@risingtidesent.com`) or Henry (`henry@risingtidesent.com`). The voice should be:

### Do
- Reference specific releases by name ("loved what you did with [Artist]'s rollout for [Song]")
- Mention shared connections ("we've been working with [Label Contact] on [Other Artist]")
- Cite real numbers from past RT campaigns (but ONLY from Notion — never invent)
- Be brief — under 150 words body
- One clear ask ("Would you be open to a 15-min call about [Artist]'s next release?")

### Don't
- Generic "we're a marketing agency" opener
- Mass-email feel (no "Dear Sir/Madam")
- Mention pricing in first outreach (qualify first)
- Overclaim results ("we guarantee viral" — never)
- Name-drop clients without permission

### Subject Line Patterns That Work
- `{Artist Name} x Rising Tides — {Release Name} campaign?`
- `Quick thought on {Artist Name}'s TikTok rollout`
- `Re: {Shared Connection} mentioned you`
- `{Label Name} campaign ideas for Q{X}`

---

## 6. Data Sources Henry Uses

| Source | What It Provides | Refresh Rate |
|--------|-----------------|--------------|
| **Notion CRM** (Labels DB) | Known labels, contacts, relationship status | Real-time |
| **Notion CRM** (Artists DB) | Artists we've worked with, by label | Real-time |
| **Spotify API** | Release dates, monthly listeners, followers, genre, label name | Daily scan |
| **Gmail** | Past email threads with contacts (relationship history) | On-demand per lead |
| **Tides Tracker** | Past campaign performance data (CPM, views, budget) | On-demand |

### Missing Data (Manual Fill Needed)
- Label A&R contact emails (not on Spotify — need manual entry or LinkedIn scraping)
- Artist manager contacts (not consistently available via API)
- Budget history per label (lives in Tides Tracker, needs API integration)
- Social channel URLs for tracked artists (need scraping or manual entry)

---

## 7. Market Sizing Reference

To filter 2M leads effectively, Henry applies these filters in order (each one is a funnel stage):

```
2,000,000 total leads
    ↓ Filter: Music industry only (labels, managers, artists, A&R)
  ~200,000
    ↓ Filter: Active release schedule (past 12 months)
  ~80,000
    ↓ Filter: Genre match (hip-hop, R&B, pop, indie, afrobeats, latin, electronic)
  ~40,000
    ↓ Filter: Artist tier fit (10K-500K Spotify ML)
  ~15,000
    ↓ Filter: Has label backing OR management with budget indicators
  ~5,000
    ↓ Filter: Upcoming release window (next 60 days)
  ~1,500
    ↓ Filter: Relationship proximity (shared label, shared contact, warm intro possible)
  ~200-400
    ↓ Score: Apply rubric (>60 = actionable lead)
  ~50-100 leads per cycle
```

This is Henry's funnel. The goal is **50-100 qualified, scored, contextual leads per week** that Eric can review in 15 minutes and approve outreach for the top 10-20.

---

## 8. Competitive Positioning (What RT Says vs. Others)

When Henry drafts outreach, the positioning is:

| Competitor Type | Their Pitch | RT's Counter |
|----------------|-------------|--------------|
| Big agencies (Grin, CreatorIQ users) | Enterprise dashboards, data | "We're operators, not dashboards. 131 creators, hands-on." |
| Freelance managers | Cheap, one person | "We run 55+ campaigns simultaneously with a dedicated team." |
| In-house label teams | Control | "We bring 100+ creator relationships you don't have in-house." |
| Other boutique agencies | Similar claims | "67.8M total views. $0.50-$1.00 CPM. We show receipts." |

**RT's unfair advantage:** Real creator relationships (not a database), music-industry-only focus, and Mon Rovia as living proof (2M+ Facebook, 1M IG, 1M TikTok — built with RT's own methods).
