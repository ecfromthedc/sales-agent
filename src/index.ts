import type { Env } from './lib/env';
import { runLabelWatcher } from './agents/label-watcher';
import { runGapFinder } from './agents/gap-finder';
import { runLeadScorer } from './agents/lead-scorer';
import { runInboxCleaner } from './agents/inbox-cleaner';
import { runOutreachDrafter } from './agents/outreach-drafter';
import { getUnscoredLeads, getLeadById } from './integrations/notion';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'rt-henry', agent: 'Henry' });
    }

    // Status — last run times
    if (url.pathname === '/status') {
      const [lastScan, lastGap, lastClean] = await Promise.all([
        env.STATE.get('last_release_scan'),
        env.STATE.get('last_gap_analysis'),
        env.STATE.get('last_inbox_clean'),
      ]);
      return Response.json({
        agent: 'Henry',
        lastReleaseScan: lastScan ? JSON.parse(lastScan) : null,
        lastGapAnalysis: lastGap ? JSON.parse(lastGap) : null,
        lastInboxClean: lastClean ? JSON.parse(lastClean) : null,
      });
    }

    // Manual triggers
    if (request.method === 'POST') {
      if (url.pathname === '/runs/scan-releases') {
        const result = await runLabelWatcher(env);
        return Response.json(result);
      }

      if (url.pathname === '/runs/find-gaps') {
        const gapResult = await runGapFinder(env);

        // Auto-score any high/medium priority gaps
        const toScore = gapResult.opportunities
          .filter((o) => o.priority !== 'low')
          .map((o) => ({
            artistName: o.artistName,
            labelName: o.labelName,
            signals: o.signals,
          }));

        if (toScore.length > 0) {
          const scoreResult = await runLeadScorer(env, toScore);
          return Response.json({ gaps: gapResult, scores: scoreResult });
        }

        return Response.json(gapResult);
      }

      if (url.pathname === '/runs/clean-inbox') {
        const cleanResult = await runInboxCleaner(env);
        return Response.json(cleanResult);
      }

      if (url.pathname === '/runs/score') {
        // Pull unscored leads from Notion and score them
        const unscoredLeads = await getUnscoredLeads(env);
        if (unscoredLeads.length === 0) {
          return Response.json({ message: 'No unscored leads found.', leadsScored: 0 });
        }

        const toScore = unscoredLeads.map((lead) => ({
          artistName: lead.artist.name,
          labelName: lead.label.name,
          signals: lead.signals,
        }));

        const scoreResult = await runLeadScorer(env, toScore);
        return Response.json(scoreResult);
      }

      // Draft for specific lead
      const draftMatch = url.pathname.match(/^\/runs\/draft\/(.+)$/);
      if (draftMatch) {
        const leadId = draftMatch[1];

        const lead = await getLeadById(env, leadId);
        if (!lead) {
          return Response.json({ error: `Lead ${leadId} not found` }, { status: 404 });
        }

        const draftResult = await runOutreachDrafter(env, lead);
        return Response.json({
          draft: draftResult.draft,
          gmailDraftId: draftResult.gmailDraftId ?? null,
          savedToNotion: draftResult.savedToNotion,
        });
      }
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const hour = new Date(event.scheduledTime).getUTCHours();
    const day = new Date(event.scheduledTime).getUTCDay();

    // Every 2 hours: inbox cleaner (runs on all even-hour triggers)
    ctx.waitUntil(runInboxCleaner(env));

    // Daily at 8am UTC: release scan
    if (hour === 8) {
      ctx.waitUntil(
        runLabelWatcher(env).then(async (result) => {
          // If signals found, auto-score them
          if (result.signalsGenerated.length > 0) {
            const toScore = result.signalsGenerated.map((s) => ({
              artistName: s.description.split('(')[0].trim(),
              labelName: s.description.match(/\(([^)]+)\)/)?.[1] ?? '',
              signals: [s],
            }));
            await runLeadScorer(env, toScore);
          }

          // Optional: notify Slack
          if (env.RT_SLACK_NOTIFY_WEBHOOK && result.signalsGenerated.length > 0) {
            await fetch(env.RT_SLACK_NOTIFY_WEBHOOK, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                text: `🔍 Henry: Scanned ${result.labelsScanned} labels, found ${result.signalsGenerated.length} signals, ${result.newReleases} new releases.`,
              }),
            });
          }
        }),
      );
    }

    // Weekly Monday 9am UTC: gap analysis
    if (hour === 9 && day === 1) {
      ctx.waitUntil(
        runGapFinder(env).then(async (result) => {
          // Score high-priority gaps
          const toScore = result.opportunities
            .filter((o) => o.priority !== 'low')
            .map((o) => ({
              artistName: o.artistName,
              labelName: o.labelName,
              signals: o.signals,
            }));

          if (toScore.length > 0) {
            await runLeadScorer(env, toScore);
          }

          if (env.RT_SLACK_NOTIFY_WEBHOOK) {
            await fetch(env.RT_SLACK_NOTIFY_WEBHOOK, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                text: `📊 Henry (weekly): Found ${result.opportunities.length} gaps across ${result.labelsAnalyzed} labels. ${toScore.length} scored.`,
              }),
            });
          }
        }),
      );
    }
  },
};
