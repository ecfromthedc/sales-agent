import type { Env } from '../lib/env';
import type { Lead, OutreachDraft } from '../lib/types';
import { composeOutreach } from '../lib/anthropic';
import { getEmailHistory, searchEmailsByName, createGmailDraft } from '../integrations/gmail';
import { getArtistReleases } from '../integrations/spotify';
import { saveOutreachDraft } from '../integrations/notion';

export interface DraftResult {
  draft: OutreachDraft;
  gmailDraftId?: string;
  savedToNotion: boolean;
}

/**
 * Given a scored lead, enrich with context and draft a personalized outreach email.
 * Saves draft to Notion and optionally creates a Gmail draft for Eric to review.
 */
export async function runOutreachDrafter(env: Env, lead: Lead): Promise<DraftResult> {
  // Step 1: Enrich with context (parallel, fault-tolerant)
  const [gmailHistory, labelEmailHistory, recentReleases] = await Promise.allSettled([
    // Check if we've emailed anyone at this label before
    lead.label.contacts.length > 0
      ? getEmailHistory(env, lead.label.contacts[0].email)
      : searchEmailsByName(env, lead.label.name),

    // Check email history mentioning the artist
    searchEmailsByName(env, lead.artist.name),

    // Get recent releases for context
    lead.artist.spotifyId ? getArtistReleases(env, lead.artist.spotifyId, 5) : Promise.resolve([]),
  ]);

  const enrichment = {
    gmailHistory: [
      ...(gmailHistory.status === 'fulfilled' ? gmailHistory.value : []),
      ...(labelEmailHistory.status === 'fulfilled' ? labelEmailHistory.value : []),
    ],
    crmNotes: lead.signals.map((s) => s.description),
    recentReleases:
      recentReleases.status === 'fulfilled'
        ? (recentReleases.value as Array<{ name: string; releaseDate: string }>).map(
            (r) => `${r.name} (${r.releaseDate})`,
          )
        : [],
  };

  // Step 2: Determine recipient
  const recipient = lead.label.contacts[0] ?? {
    name: lead.label.name,
    email: '', // Will need manual lookup
  };

  // Step 3: Compose draft via AI
  const draft = await composeOutreach(
    env,
    lead.artist,
    lead.label,
    lead.signals,
    enrichment,
    recipient.name,
    recipient.email,
  );

  draft.leadId = lead.id;

  // Step 4: Save to Notion
  let savedToNotion = false;
  if (lead.notionPageId) {
    try {
      await saveOutreachDraft(env, draft, lead.notionPageId);
      savedToNotion = true;
    } catch (e) {
      console.error(`Failed to save draft to Notion: ${e}`);
    }
  }

  // Step 5: Create Gmail draft (only if we have a recipient email)
  let gmailDraftId: string | undefined;
  if (recipient.email) {
    try {
      gmailDraftId = await createGmailDraft(env, recipient.email, draft.subject, draft.body);
    } catch (e) {
      console.error(`Failed to create Gmail draft: ${e}`);
    }
  }

  return { draft, gmailDraftId, savedToNotion };
}
