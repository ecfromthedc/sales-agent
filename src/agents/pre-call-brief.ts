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

import type { Env } from "../lib/env";
import { enrichFromSpotify } from "../integrations/spotify";
import { enrichFromSongstats } from "../integrations/songstats";
import { enrichFromChartmetric } from "../integrations/chartmetric";
import { searchGmailHistory } from "../integrations/gmail";
import { lookupCRM } from "../integrations/crm-lookup";
import { upsertDeal, type DealUpsertInput } from "../integrations/notion";
import { composeBrief } from "../lib/anthropic";

interface PreCallBriefInput {
  inviteeEmail: string;
  inviteeName: string;
  eventStartsAt: string;
  eventUri: string;
  questionsAndAnswers: Array<{ question: string; answer: string }>;
  dealId?: string; // present on manual rerun
}

export async function runPreCallBrief(input: PreCallBriefInput, env: Env): Promise<void> {
  const startedAt = Date.now();
  console.log("pre_call_brief_start", { invitee: input.inviteeEmail });

  try {
    const spotifyLink = input.questionsAndAnswers
      .find((qa) => /spotify/i.test(qa.question))?.answer?.trim() ?? null;
    console.log("pre_call_brief_step", { step: "extract_spotify", hasLink: !!spotifyLink });

    // Extract Spotify artist ID for Songstats lookup
    const spotifyArtistId = spotifyLink
      ? spotifyLink.match(/artist\/([a-zA-Z0-9]{22})/)?.[1] ?? null
      : null;

    // Phase 1: Songstats + Spotify + Chartmetric + Gmail in parallel (Songstats is sequential internally)
    const [spotify, songstats, chartmetric, gmail] = await Promise.allSettled([
      spotifyLink ? enrichFromSpotify(spotifyLink, env) : Promise.resolve(null),
      spotifyArtistId ? enrichFromSongstats(spotifyArtistId, env) : Promise.resolve(null),
      enrichFromChartmetric({ spotifyArtistId, artistName: input.inviteeName }, env),
      searchGmailHistory(input.inviteeEmail, env),
    ]);

    // Phase 2: CRM lookup — uses artist name from Songstats if available, falls back to invitee name
    const songstatsData = songstats.status === "fulfilled" ? songstats.value : null;
    const artistName = songstatsData?.name ?? input.inviteeName;
    const relatedArtists = songstatsData?.relatedArtists?.map((a) => a.name);

    // Extract label from Songstats platform links or notes
    const labelHint = input.questionsAndAnswers
      .find((qa) => /label|distro/i.test(qa.question))?.answer?.trim();

    const crmLookup = await lookupCRM({
      artistName,
      label: labelHint,
      relatedArtists,
    }, env).catch((e) => {
      console.warn("crm_lookup_failed", (e as Error).message);
      return { exactMatches: [], labelMatches: [], totalCampaignsFound: 0 };
    });

    console.log("pre_call_brief_step", {
      step: "enrichment_done",
      spotify: spotify.status,
      songstats: songstats.status,
      chartmetric: chartmetric.status,
      gmail: gmail.status,
      crmMatches: crmLookup.totalCampaignsFound,
      spotifyErr: spotify.status === "rejected" ? (spotify.reason as Error)?.message : undefined,
      songstatsErr: songstats.status === "rejected" ? (songstats.reason as Error)?.message : undefined,
      chartmetricErr: chartmetric.status === "rejected" ? (chartmetric.reason as Error)?.message : undefined,
      gmailErr: gmail.status === "rejected" ? (gmail.reason as Error)?.message : undefined,
    });

    const enrichment = {
      spotify: spotify.status === "fulfilled" ? spotify.value : null,
      songstats: songstatsData,
      chartmetric: chartmetric.status === "fulfilled" ? chartmetric.value : null,
      gmail: gmail.status === "fulfilled" ? gmail.value : null,
      crm: crmLookup,
      failures: [spotify, songstats, chartmetric, gmail]
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

    // Post full brief to Slack (best-effort, don't block on failure)
    if (env.SLACK_BOT_TOKEN && env.SLACK_BRIEF_CHANNEL_ID) {
      try {
        const notionUrl = `https://www.notion.so/${pageId.replace(/-/g, "")}`;
        const meetingTime = new Date(input.eventStartsAt).toLocaleString("en-US", {
          timeZone: "America/New_York",
          weekday: "short", month: "short", day: "numeric",
          hour: "numeric", minute: "2-digit",
        });

        // Convert markdown-ish brief to Slack mrkdwn
        const slackBrief = brief
          .replace(/\*\*([^*]+)\*\*/g, "*$1*")   // **bold** → *bold*
          .replace(/^#{1,3}\s+/gm, "*")           // ### heading → *heading
          .replace(/\|/g, "│")                     // table pipes → unicode
          .slice(0, 2900);                         // Slack block limit

        await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            channel: env.SLACK_BRIEF_CHANNEL_ID,
            text: `📋 *${input.inviteeName}* — ${meetingTime}`,
            blocks: [
              {
                type: "header",
                text: { type: "plain_text", text: `📋 ${input.inviteeName} — ${meetingTime}` },
              },
              {
                type: "section",
                text: { type: "mrkdwn", text: slackBrief },
              },
              {
                type: "context",
                elements: [
                  { type: "mrkdwn", text: `<${notionUrl}|Open in Notion> │ ${input.inviteeEmail}` },
                ],
              },
            ],
          }),
        });
      } catch (slackErr) {
        console.warn("slack_notify_failed", (slackErr as Error).message);
      }
    }

    console.log("pre_call_brief_complete", {
      invitee: input.inviteeEmail,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    const e = err as Error;
    console.error("pre_call_brief_failed", {
      invitee: input.inviteeEmail,
      message: e.message,
      stack: e.stack?.split("\n").slice(0, 6).join(" | "),
    });
    throw err;
  }
}
