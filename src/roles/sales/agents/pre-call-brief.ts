/**
 * Pre-Call Brief Agent
 *
 * Trigger: Calendly booking created
 * Time budget: 2 min
 *
 * Steps:
 *   1. Enrich invitee via Spotify (using required Spotify link), Gmail history,
 *      Notion CRM lookup, Tides Tracker past-campaign lookup, and (if cold) web research.
 *   2. Compose a one-page brief in Eric's voice.
 *   3. Create or update the Notion deal record with the brief.
 *   4. Post a Slack ping to Eric's notification channel.
 */

import type { Env } from "../../../lib/env";
import { enrichFromSpotify } from "../../../integrations/spotify";
import { enrichFromSongstats } from "../../../integrations/songstats";
import { enrichFromChartmetric } from "../../../integrations/chartmetric";
import { searchGmailHistory } from "../../../integrations/gmail";
import { researchProspect } from "../../../integrations/web-research";
import { lookupCRM, campaignToComparable } from "../integrations/crm-lookup";
import { upsertDeal, type DealUpsertInput } from "../../../integrations/notion";
import { rankComparables, type ProspectSignal } from "../../../lib/comparables";
import { composeBrief } from "../../../lib/anthropic";
import { recordRun, recordError } from "../../../lib/run-state";
import { retry } from "../../../lib/retry";
import { notifySlack, buildBriefMessage } from "../../../integrations/slack";

// Enrichment sources are external and fail transiently (network blips, 429/5xx).
// Each call is wrapped in `retry` (exponential backoff + jitter) so a transient
// blip self-heals, while `Promise.allSettled` still guarantees one source's
// permanent failure never blocks the brief.
const ENRICH_RETRY = { retries: 2, baseDelayMs: 300, maxDelayMs: 4000 } as const;

interface PreCallBriefInput {
  inviteeEmail: string;
  inviteeName: string;
  eventStartsAt: string;
  eventUri: string;
  questionsAndAnswers: Array<{ question: string; answer: string }>;
  dealId?: string; // present on manual rerun
  /** Slack channel for the brief ping. Defaults to env.SLACK_BRIEF_CHANNEL_ID. */
  slackChannelId?: string;
}

// Matches a Spotify URL anywhere in free-text. Lets us pull the artist link even
// when the Calendly form doesn't have an explicit "Spotify link" question (e.g.
// Seeno's intake asks a generic "anything to help us prepare?").
const SPOTIFY_URL_RE = /https?:\/\/open\.spotify\.com\/[^\s)]+/i;

export async function runPreCallBrief(input: PreCallBriefInput, env: Env): Promise<void> {
  const startedAt = Date.now();
  console.log("pre_call_brief_start", { invitee: input.inviteeEmail });

  try {
    // Resolve the artist's Spotify link. Eric's form has a dedicated "Spotify
    // link" question; Seeno's intake is free-text, so we also scan every answer
    // for a pasted open.spotify.com URL.
    const spotifyLink =
      input.questionsAndAnswers.find((qa) => /spotify/i.test(qa.question))?.answer?.trim() ||
      input.questionsAndAnswers.map((qa) => qa.answer?.match(SPOTIFY_URL_RE)?.[0]).find(Boolean) ||
      null;
    console.log("pre_call_brief_step", { step: "extract_spotify", hasLink: !!spotifyLink });

    // Extract Spotify artist ID for Songstats lookup
    const spotifyArtistId = spotifyLink
      ? spotifyLink.match(/artist\/([a-zA-Z0-9]{22})/)?.[1] ?? null
      : null;

    // Phase 1: Songstats + Spotify + Chartmetric + Gmail + web research in
    // parallel (Songstats is sequential internally). Each call is retried
    // independently with exponential backoff; allSettled keeps partial failures
    // from blocking the others. Web research always runs so there's a picture
    // even when no Spotify link / no streaming data is available.
    const [spotify, songstats, chartmetric, gmail, web] = await Promise.allSettled([
      spotifyLink
        ? retry(() => enrichFromSpotify(spotifyLink, env), ENRICH_RETRY)
        : Promise.resolve(null),
      spotifyArtistId
        ? retry(() => enrichFromSongstats(spotifyArtistId, env), ENRICH_RETRY)
        : Promise.resolve(null),
      retry(
        () => enrichFromChartmetric({ spotifyArtistId, artistName: input.inviteeName }, env),
        ENRICH_RETRY,
      ),
      retry(() => searchGmailHistory(input.inviteeEmail, env), ENRICH_RETRY),
      retry(
        () =>
          researchProspect(
            { inviteeName: input.inviteeName, inviteeEmail: input.inviteeEmail },
            env,
          ),
        ENRICH_RETRY,
      ),
    ]);

    // Phase 2: CRM lookup — uses artist name from Songstats if available, falls back to invitee name
    const songstatsData = songstats.status === "fulfilled" ? songstats.value : null;
    const artistName = songstatsData?.name ?? input.inviteeName;
    const relatedArtists = songstatsData?.relatedArtists?.map((a) => a.name);

    // Extract label from Songstats platform links or notes
    const labelHint = input.questionsAndAnswers
      .find((qa) => /label|distro/i.test(qa.question))?.answer?.trim();

    const crmLookup = await retry(
      () => lookupCRM({ artistName, label: labelHint, relatedArtists }, env),
      ENRICH_RETRY,
    ).catch((e) => {
      console.warn("crm_lookup_failed", (e as Error).message);
      return { exactMatches: [], labelMatches: [], totalCampaignsFound: 0 };
    });

    console.log("pre_call_brief_step", {
      step: "enrichment_done",
      spotify: spotify.status,
      songstats: songstats.status,
      chartmetric: chartmetric.status,
      gmail: gmail.status,
      web: web.status,
      crmMatches: crmLookup.totalCampaignsFound,
      spotifyErr: spotify.status === "rejected" ? (spotify.reason as Error)?.message : undefined,
      songstatsErr: songstats.status === "rejected" ? (songstats.reason as Error)?.message : undefined,
      chartmetricErr: chartmetric.status === "rejected" ? (chartmetric.reason as Error)?.message : undefined,
      gmailErr: gmail.status === "rejected" ? (gmail.reason as Error)?.message : undefined,
      webErr: web.status === "rejected" ? (web.reason as Error)?.message : undefined,
    });

    // Comparable-client matching: rank RT's past clients most-similar-first so
    // the brief can surface relevant proof ("we ran a campaign for an artist
    // just like you"). Reuses the CRM records already fetched above — no extra
    // network path. Candidates are same-lane by construction (artist/label/
    // related-artist matched); we rank them by genre/tier/recency.
    const spotifyData = spotify.status === "fulfilled" ? spotify.value : null;
    const prospectSignal: ProspectSignal = {
      genres: songstatsData?.genres ?? spotifyData?.genres ?? [],
      audience:
        songstatsData?.spotify.monthlyListeners ??
        songstatsData?.spotify.followers ??
        spotifyData?.followers ??
        null,
    };
    const comparableCandidates = [
      ...crmLookup.exactMatches,
      ...crmLookup.labelMatches,
    ].map(campaignToComparable);
    const comparables = rankComparables(
      prospectSignal,
      comparableCandidates,
      new Date(),
      3,
    );
    console.log("pre_call_brief_step", {
      step: "comparables_ranked",
      candidates: comparableCandidates.length,
      top: comparables.map((c) => ({ name: c.candidate.artistName, score: +c.score.toFixed(3) })),
    });

    const enrichment = {
      spotify: spotifyData,
      songstats: songstatsData,
      chartmetric: chartmetric.status === "fulfilled" ? chartmetric.value : null,
      gmail: gmail.status === "fulfilled" ? gmail.value : null,
      web: web.status === "fulfilled" ? web.value : null,
      crm: crmLookup,
      comparables,
      failures: [spotify, songstats, chartmetric, gmail, web]
        .filter((r) => r.status === "rejected")
        .map((r) => (r as PromiseRejectedResult).reason?.message ?? "unknown"),
    };

    console.log("pre_call_brief_step", { step: "compose_start" });
    const brief = await composeBrief({ invitee: input, enrichment }, env);
    console.log("pre_call_brief_step", { step: "compose_done", briefLen: brief.length });

    console.log("pre_call_brief_step", { step: "notion_upsert_start" });
    const pageId = await upsertDeal({
      dealId: input.dealId,
      inviteeEmail: input.inviteeEmail,
      inviteeName: input.inviteeName,
      eventStartsAt: input.eventStartsAt,
      eventUri: input.eventUri,
      questionsAndAnswers: input.questionsAndAnswers,
      status: "Briefed",
      brief,
      enrichment,
    }, env);

    // Post full brief to Slack (best-effort; notifySlack no-ops on missing
    // token/channel and never throws into the run path).
    const meetingTime = new Date(input.eventStartsAt).toLocaleString("en-US", {
      timeZone: "America/New_York",
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
    await notifySlack(
      env,
      input.slackChannelId ?? env.SLACK_BRIEF_CHANNEL_ID,
      buildBriefMessage({
        inviteeName: input.inviteeName,
        inviteeEmail: input.inviteeEmail,
        meetingTime,
        brief,
        pageId,
      }),
    );

    console.log("pre_call_brief_complete", {
      invitee: input.inviteeEmail,
      elapsedMs: Date.now() - startedAt,
    });
    await recordRun(env, "brief");
  } catch (err) {
    const e = err as Error;
    console.error("pre_call_brief_failed", {
      invitee: input.inviteeEmail,
      message: e.message,
      stack: e.stack?.split("\n").slice(0, 6).join(" | "),
    });
    await recordError(env, "brief");
    throw err;
  }
}
