/**
 * Always-on prospect web research.
 *
 * Every pre-call brief runs this so there's always *some* picture of who booked
 * the call — even when the Spotify link is missing and Chartmetric/Songstats
 * come up empty (common for managers, labels, and cold inbound).
 *
 * It searches three angles off the booking alone (name + email):
 *   - the artist (if the booker is one),
 *   - the manager / representative (if they rep someone),
 *   - the company behind the email domain (skipped for generic mailboxes).
 *
 * Grounded via Anthropic's server-side web search tool, so no extra API key.
 * Best-effort: any failure returns null and the brief composes without it.
 */

import type { Env } from "../lib/env";
import { researchWithWebSearch } from "../lib/anthropic";

export interface ProspectResearch {
  summary: string; // tight factual bullets
  citations: Array<{ title: string; url: string }>;
}

// Consumer mailbox providers — the email domain tells us nothing about a company.
const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com",
  "hotmail.com", "live.com", "icloud.com", "me.com", "aol.com", "proton.me",
  "protonmail.com", "pm.me", "msn.com", "gmx.com",
]);

const RESEARCH_SYSTEM = `You are a research assistant prepping a Rising Tides sales call. Rising Tides is a music-industry social-media marketing agency. Given only a booker's name and email, build a quick, factual picture of who they are using web search. Be concise and skeptical: only state what the sources support, never invent. If you can't confirm something, say so in one short phrase. Write tight bullet points, no preamble, no marketing fluff.`;

export async function researchProspect(
  params: { inviteeName: string; inviteeEmail: string },
  env: Env,
): Promise<ProspectResearch | null> {
  const domain = params.inviteeEmail.split("@")[1]?.toLowerCase() ?? null;
  const isGenericDomain = domain ? GENERIC_EMAIL_DOMAINS.has(domain) : true;

  const companyLine = isGenericDomain
    ? `Email domain: ${domain ?? "unknown"} (generic mailbox — skip the company angle).`
    : `Company domain: ${domain}. Research the company behind it: what they do, their roster/notable acts, size.`;

  const prompt = `Research this prospect for a sales call and return a tight factual picture.

Booker: ${params.inviteeName}
Email: ${params.inviteeEmail}
${companyLine}

First infer whether the booker is an artist, a manager/representative, or a label/company rep, then research the relevant angles:
- If an artist: who they are, genre, audience size/traction, notable releases.
- If a manager/rep: who they manage or represent, and the company they work for.
- The company behind the email domain (unless it's a generic mailbox).

Return 4-8 short factual bullets. Lead with the single most useful fact for the call. If the person/company can't be confidently identified, say so plainly rather than guessing.`;

  try {
    const res = await researchWithWebSearch(env, { prompt, system: RESEARCH_SYSTEM, maxUses: 5 });
    if (!res.text) return null;
    return { summary: res.text, citations: res.citations };
  } catch (e) {
    console.warn("prospect_research_failed", (e as Error).message);
    return null;
  }
}
