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
import { searchGmailHistory } from "../integrations/gmail";
import { upsertDeal, type DealUpsertInput } from "../integrations/notion";
import { lookupPastCampaigns } from "../integrations/tides-tracker";
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

    const [spotify, gmail, pastCampaigns] = await Promise.allSettled([
      spotifyLink ? enrichFromSpotify(spotifyLink, env) : Promise.resolve(null),
      searchGmailHistory(input.inviteeEmail, env),
      lookupPastCampaigns({ email: input.inviteeEmail, name: input.inviteeName }, env),
    ]);
    console.log("pre_call_brief_step", {
      step: "enrichment_done",
      spotify: spotify.status,
      gmail: gmail.status,
      pastCampaigns: pastCampaigns.status,
      spotifyErr: spotify.status === "rejected" ? (spotify.reason as Error)?.message : undefined,
      gmailErr: gmail.status === "rejected" ? (gmail.reason as Error)?.message : undefined,
      trackerErr: pastCampaigns.status === "rejected" ? (pastCampaigns.reason as Error)?.message : undefined,
    });

    const enrichment = {
      spotify: spotify.status === "fulfilled" ? spotify.value : null,
      gmail: gmail.status === "fulfilled" ? gmail.value : null,
      pastCampaigns: pastCampaigns.status === "fulfilled" ? pastCampaigns.value : null,
      failures: [spotify, gmail, pastCampaigns]
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

    // Slack notification (best-effort, don't block on failure)
    if (env.SLACK_BOT_TOKEN && env.SLACK_BRIEF_CHANNEL_ID) {
      try {
        const notionUrl = `https://www.notion.so/${pageId.replace(/-/g, "")}`;
        const meetingTime = new Date(input.eventStartsAt).toLocaleString("en-US", {
          timeZone: "America/New_York",
          weekday: "short", month: "short", day: "numeric",
          hour: "numeric", minute: "2-digit",
        });
        await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            channel: env.SLACK_BRIEF_CHANNEL_ID,
            text: `📋 Pre-call brief ready: *${input.inviteeName}* (${meetingTime})\n<${notionUrl}|View in Notion>`,
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
