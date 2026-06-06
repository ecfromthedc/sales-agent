import type { Env } from '../lib/env';
import type { Artist, Label, Lead, OutreachDraft } from '../lib/types';
import { notionFetch } from '../../../src/integrations/notion-transport';

// --- Labels DB ---

export async function getTrackedLabels(env: Env): Promise<Label[]> {
  const data = (await notionFetch(env, `/databases/${env.LABELS_DB_ID}/query`, {
    method: 'POST',
    body: { page_size: 100 },
  })) as { results: Array<Record<string, unknown>> };

  return data.results.map(pageToLabel);
}

function pageToLabel(page: Record<string, unknown>): Label {
  const props = page.properties as Record<string, unknown>;
  // TODO: Map actual Notion properties once schema is created
  return {
    id: page.id as string,
    name: getTitle(props['Name']),
    notionPageId: page.id as string,
    spotifyLabelName: getRichText(props['Spotify Label Name']) || getTitle(props['Name']),
    contacts: [],
    relationship: (getSelect(props['Relationship']) as Label['relationship']) || 'unknown',
    genres: getMultiSelect(props['Genres']),
  };
}

// --- Artists DB ---

export async function getArtistsByLabel(env: Env, labelName: string): Promise<Artist[]> {
  const data = (await notionFetch(env, `/databases/${env.ARTISTS_DB_ID}/query`, {
    method: 'POST',
    body: {
      filter: {
        property: 'Label',
        rich_text: { equals: labelName },
      },
      page_size: 100,
    },
  })) as { results: Array<Record<string, unknown>> };

  return data.results.map(pageToArtist);
}

export async function getAllArtists(env: Env): Promise<Artist[]> {
  const data = (await notionFetch(env, `/databases/${env.ARTISTS_DB_ID}/query`, {
    method: 'POST',
    body: { page_size: 100 },
  })) as { results: Array<Record<string, unknown>> };

  return data.results.map(pageToArtist);
}

function pageToArtist(page: Record<string, unknown>): Artist {
  const props = page.properties as Record<string, unknown>;
  return {
    id: page.id as string,
    name: getTitle(props['Name']),
    spotifyId: getRichText(props['Spotify ID']) || undefined,
    labelName: getRichText(props['Label']),
    tier: (getSelect(props['Tier']) as Artist['tier']) || 'emerging',
    monthlyListeners: getNumber(props['Monthly Listeners']),
    followers: getNumber(props['Followers']),
    genres: getMultiSelect(props['Genres']),
    hasWorkedWithRT: getCheckbox(props['Worked With RT']),
    notionPageId: page.id as string,
  };
}

// --- Leads DB ---

export async function createLead(env: Env, lead: Omit<Lead, 'id' | 'notionPageId'>): Promise<string> {
  const data = (await notionFetch(env, `/pages`, {
    method: 'POST',
    body: {
      parent: { database_id: env.LEADS_DB_ID },
      properties: {
        Name: { title: [{ text: { content: `${lead.artist.name} @ ${lead.label.name}` } }] },
        Status: { select: { name: lead.status } },
        Score: { number: lead.score },
        Artist: { rich_text: [{ text: { content: lead.artist.name } }] },
        Label: { rich_text: [{ text: { content: lead.label.name } }] },
        Signals: {
          rich_text: [{ text: { content: lead.signals.map((s) => s.type).join(', ') } }],
        },
      },
    },
  })) as { id: string };
  return data.id;
}

export async function getUnscoredLeads(env: Env): Promise<Lead[]> {
  const data = (await notionFetch(env, `/databases/${env.LEADS_DB_ID}/query`, {
    method: 'POST',
    body: {
      filter: {
        property: 'Status',
        select: { equals: 'new' },
      },
      page_size: 50,
    },
  })) as { results: Array<Record<string, unknown>> };

  return data.results.map(pageToLead);
}

export async function getLeadById(env: Env, pageId: string): Promise<Lead> {
  const page = (await notionFetch(env, `/pages/${pageId}`, {
    method: 'GET',
  })) as Record<string, unknown>;

  return pageToLead(page);
}

function pageToLead(page: Record<string, unknown>): Lead {
  const props = page.properties as Record<string, unknown>;
  return {
    id: page.id as string,
    notionPageId: page.id as string,
    artist: {
      id: '',
      name: getRichText(props['Artist']),
      labelName: getRichText(props['Label']),
      tier: 'emerging',
      genres: [],
      hasWorkedWithRT: false,
    },
    label: {
      id: '',
      name: getRichText(props['Label']),
      spotifyLabelName: getRichText(props['Label']),
      contacts: [],
      relationship: 'prospect',
      genres: [],
    },
    score: getNumber(props['Score']) ?? 0,
    signals: [],
    status: (getSelect(props['Status']) as Lead['status']) || 'new',
    createdAt: (page as { created_time?: string }).created_time ?? '',
    outreachDraft: getRichText(props['Outreach Draft']) || undefined,
  };
}

export async function updateLeadStatus(env: Env, pageId: string, status: Lead['status']): Promise<void> {
  await notionFetch(env, `/pages/${pageId}`, {
    method: 'PATCH',
    body: {
      properties: {
        Status: { select: { name: status } },
      },
    },
  });
}

export async function saveOutreachDraft(env: Env, draft: OutreachDraft, leadPageId: string): Promise<void> {
  // Save to Outreach Log DB
  await notionFetch(env, `/pages`, {
    method: 'POST',
    body: {
      parent: { database_id: env.OUTREACH_LOG_DB_ID },
      properties: {
        Name: { title: [{ text: { content: draft.subject } }] },
        Recipient: { rich_text: [{ text: { content: `${draft.recipientName} <${draft.recipientEmail}>` } }] },
        'Lead ID': { rich_text: [{ text: { content: leadPageId } }] },
        Status: { select: { name: 'Draft' } },
      },
      children: [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ text: { content: draft.body } }],
          },
        },
      ],
    },
  });

  // Update lead status
  await updateLeadStatus(env, leadPageId, 'drafted');
}

// --- Notion property helpers ---

function getTitle(prop: unknown): string {
  const p = prop as { title?: Array<{ plain_text: string }> } | undefined;
  return p?.title?.[0]?.plain_text ?? '';
}

function getRichText(prop: unknown): string {
  const p = prop as { rich_text?: Array<{ plain_text: string }> } | undefined;
  return p?.rich_text?.[0]?.plain_text ?? '';
}

function getSelect(prop: unknown): string {
  const p = prop as { select?: { name: string } | null } | undefined;
  return p?.select?.name ?? '';
}

function getMultiSelect(prop: unknown): string[] {
  const p = prop as { multi_select?: Array<{ name: string }> } | undefined;
  return p?.multi_select?.map((s) => s.name) ?? [];
}

function getNumber(prop: unknown): number | undefined {
  const p = prop as { number?: number | null } | undefined;
  return p?.number ?? undefined;
}

function getCheckbox(prop: unknown): boolean {
  const p = prop as { checkbox?: boolean } | undefined;
  return p?.checkbox ?? false;
}
