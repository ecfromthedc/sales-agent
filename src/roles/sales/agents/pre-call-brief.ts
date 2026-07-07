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
import { upsertDeal } from "../../../integrations/notion";
import { rankComparables, type ProspectSignal } from "../../../lib/comparables";
import { composeBrief } from "../../../lib/anthropic";
import { recordRun, recordError } from "../../../lib/run-state";
import { retry } from "../../../lib/retry";
import { notifySlack, buildBriefMessage, postBriefToCanvas } from "../../../integrations/slack";
import { REMINDER_PREFIX, type ReminderRecord } from "../triggers/reminder-poll";

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
  /** Slack user id of the booked host (Eric/Seeno) — @-mentioned at T-30. */
  hostSlackUserId?: string;
}

// Matches a Spotify URL anywhere in free-text. Lets us pull the artist link even
// when the Calendly form doesn't have an explicit "Spotify link" question (e.g.
// Seeno's intake asks a generic "anything to help us prepare?").
const SPOTIFY_URL_RE = /https?:\/\/open\.spotify\.com\/[^\s)]+/i;

export async function runPreCallBrief(input: PreCallBriefInput, env: Env): Promise<void> {
  const startedAt = Date.now();
  console.log("pre_call_brief_start", { invitee: input.inviteeEmail });

  const meetingTime = new Date(input.eventStartsAt).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });

  try {
    // Resolve the artist's Spotify link. Eric's form has a dedicated "Spotify
    // link" question; Seeno's intake is free-text, so we also scan every answer
    // for a pasted open.spotify.com URL.
    const spotifyLink =
      input.questionsAndAnswers.find((qa) => /spotify/i.test(qa.question))?.answer?.trim() ||
      input.questionsAndAnswers.map((qa) => qa.answer?.match(SPOTIFY_URL_RE)?.[0]).find(Boolean) ||
      null;
    console.log("pre_call_brief_step", { step: "extract_spotify", hasLink: !!spotifyLink });

    // Extract Spotify artist ID for the Chartmetric lookup
    const spotifyArtistId = spotifyLink
      ? spotifyLink.match(/artist\/([a-zA-Z0-9]{22})/)?.[1] ?? null
      : null;

    // Phase 1: Spotify + Chartmetric + Songstats + Gmail + web research in
    // parallel. Chartmetric is the authoritative numbers source; Songstats
    // rides along purely as a gap-filler for stats Chartmetric lacks (total
    // catalog streams, socials/links CM doesn't track for this artist). Each
    // call is retried independently with exponential backoff; allSettled
    // keeps partial failures from blocking the others.
    const [spotify, chartmetric, songstats, gmail, web] = await Promise.allSettled([
      spotifyLink
        ? retry(() => enrichFromSpotify(spotifyLink, env), ENRICH_RETRY)
        : Promise.resolve(null),
      retry(
        () => enrichFromChartmetric({ spotifyArtistId, artistName: input.inviteeName }, env),
        ENRICH_RETRY,
      ),
      spotifyArtistId
        ? retry(() => enrichFromSongstats(spotifyArtistId, env), ENRICH_RETRY)
        : Promise.resolve(null),
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

    // Phase 2: CRM lookup — uses the Chartmetric artist name when available,
    // falls back to the invitee name.
    const chartmetricData = chartmetric.status === "fulfilled" ? chartmetric.value : null;
    const songstatsData = songstats.status === "fulfilled" ? songstats.value : null;
    const artistName = chartmetricData?.name ?? songstatsData?.name ?? input.inviteeName;
    const relatedArtists = chartmetricData?.relatedArtists;

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
      chartmetric: chartmetric.status,
      songstats: songstats.status,
      gmail: gmail.status,
      web: web.status,
      crmMatches: crmLookup.totalCampaignsFound,
      spotifyErr: spotify.status === "rejected" ? (spotify.reason as Error)?.message : undefined,
      chartmetricErr: chartmetric.status === "rejected" ? (chartmetric.reason as Error)?.message : undefined,
      songstatsErr: songstats.status === "rejected" ? (songstats.reason as Error)?.message : undefined,
      gmailErr: gmail.status === "rejected" ? (gmail.reason as Error)?.message : undefined,
      webErr: web.status === "rejected" ? (web.reason as Error)?.message : undefined,
    });

    // Comparable-client matching: rank RT's past clients most-similar-first so
    // the brief can surface relevant proof ("we ran a campaign for an artist
    // just like you"). Reuses the CRM records already fetched above — no extra
    // network path. Candidates are same-lane by construction (artist/label/
    // related-artist matched); we rank them by genre/tier/recency.
    const spotifyData = spotify.status === "fulfilled" ? spotify.value : null;
    const chartmetricGenres = chartmetricData
      ? [chartmetricData.genrePrimary, ...chartmetricData.genresSecondary].filter(
          (g): g is string => !!g,
        )
      : [];
    const prospectSignal: ProspectSignal = {
      genres: chartmetricGenres.length > 0 ? chartmetricGenres : spotifyData?.genres ?? [],
      audience:
        chartmetricData?.spotifyMonthlyListeners ??
        chartmetricData?.spotifyFollowers ??
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
      chartmetric: chartmetricData,
      songstats: songstatsData,
      gmail: gmail.status === "fulfilled" ? gmail.value : null,
      web: web.status === "fulfilled" ? web.value : null,
      crm: crmLookup,
      comparables,
      failures: [spotify, chartmetric, songstats, gmail, web]
        .filter((r) => r.status === "rejected")
        .map((r) => (r as PromiseRejectedResult).reason?.message ?? "unknown"),
    };

    console.log("pre_call_brief_step", { step: "compose_start" });
    const brief = await composeBrief({ invitee: input, enrichment }, env);
    console.log("pre_call_brief_step", { step: "compose_done", briefLen: brief.length });

    console.log("pre_call_brief_step", { step: "notion_upsert_start" });
    // Retry transient Notion blips — upsertDeal is idempotent (query-then-write
    // keyed on invitee email + event URI), so a retry can't duplicate deals.
    const pageId = await retry(() => upsertDeal({
      dealId: input.dealId,
      inviteeEmail: input.inviteeEmail,
      inviteeName: input.inviteeName,
      eventStartsAt: input.eventStartsAt,
      eventUri: input.eventUri,
      questionsAndAnswers: input.questionsAndAnswers,
      status: "Briefed",
      brief,
      enrichment,
    }, env), { retries: 2, baseDelayMs: 500 });

    // Post full brief to Slack (best-effort; notifySlack no-ops on missing
    // token/channel and never throws into the run path).
    const channelId = input.slackChannelId ?? env.SLACK_BRIEF_CHANNEL_ID;
    await notifySlack(
      env,
      channelId,
      buildBriefMessage({
        inviteeName: input.inviteeName,
        inviteeEmail: input.inviteeEmail,
        meetingTime,
        brief,
        pageId,
      }),
    );

    // Archive the brief in the channel canvas (durable, newest on top).
    // Best-effort, same contract as notifySlack.
    await postBriefToCanvas(
      env,
      channelId,
      `# 📋 ${input.inviteeName} — ${meetingTime}\n\n${brief}\n\n---\n`,
    );

    // Schedule the T-30 refresher card (fresh popularity scores + host
    // mention). Consumed by reminder-poll on the 5-min cron. Best-effort —
    // a KV blip must not fail a brief that already shipped.
    const reminder: ReminderRecord = {
      startsAt: input.eventStartsAt,
      channelId,
      hostSlackUserId: input.hostSlackUserId,
      inviteeName: input.inviteeName,
      inviteeEmail: input.inviteeEmail,
      artistName,
      spotifyArtistId,
      pageId,
    };
    const untilStartS = Math.floor((Date.parse(input.eventStartsAt) - Date.now()) / 1000);
    if (untilStartS > 0) {
      await env.STATE.put(`${REMINDER_PREFIX}${input.eventUri}`, JSON.stringify(reminder), {
        // Self-expire an hour past the meeting in case the sweep never runs.
        expirationTtl: Math.max(untilStartS + 3600, 60),
      }).catch((e) => console.warn("reminder_schedule_failed", (e as Error).message));
    }

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
    // Loud failure: 14 bookings were dropped silently in June '26 when the
    // Anthropic account ran dry — the error only lived in logs and /status.
    // Alert the same channel the brief would have landed in. Best-effort:
    // notifySlack never throws into this path.
    await notifySlack(env, input.slackChannelId ?? env.SLACK_BRIEF_CHANNEL_ID, {
      text:
        `⚠️ Pre-call brief FAILED — *${input.inviteeName}* (${input.inviteeEmail}), ` +
        `meeting ${meetingTime}.\nError: \`${e.message.slice(0, 500)}\`\n` +
        `The poll retries automatically; if this repeats, the pipeline needs a human.`,
    });
    throw err;
  }
}
