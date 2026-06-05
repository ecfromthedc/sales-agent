import type { Env } from '../lib/env';
import type { Artist, Label, Lead, OutreachDraft } from '../lib/types';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function headers(env: Env) {
  return {
    Authorization: `Bearer ${env.NOTION_API_KEY}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

// --- Labels DB ---

export async function getTrackedLabels(env: Env): Promise<Label[]> {
  const response = await fetch(`${NOTION_API}/databases/${env.LABELS_DB_ID}/query`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({ page_size: 100 }),
  });

  if (!response.ok) throw new Error(`Notion query failed: ${response.status}`);
  const data = (await response.json()) as { results: Array<Record<string, unknown>> };

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
  const response = await fetch(`${NOTION_API}/databases/${env.ARTISTS_DB_ID}/query`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({
      filter: {
        property: 'Label',
        rich_text: { equals: labelName },
      },
      page_size: 100,
    }),
  });

  if (!response.ok) throw new Error(`Notion query failed: ${response.status}`);
  const data = (await response.json()) as { results: Array<Record<string, unknown>> };

  return data.results.map(pageToArtist);
}

export async function getAllArtists(env: Env): Promise<Artist[]> {
  const response = await fetch(`${NOTION_API}/databases/${env.ARTISTS_DB_ID}/query`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({ page_size: 100 }),
  });

  if (!response.ok) throw new Error(`Notion query failed: ${response.status}`);
  const data = (await response.json()) as { results: Array<Record<string, unknown>> };

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
  const response = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({
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
    }),
  });

  if (!response.ok) throw new Error(`Notion create failed: ${response.status}`);
  const data = (await response.json()) as { id: string };
  return data.id;
}

export async function getUnscoredLeads(env: Env): Promise<Lead[]> {
  const response = await fetch(`${NOTION_API}/databases/${env.LEADS_DB_ID}/query`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({
      filter: {
        property: 'Status',
        select: { equals: 'new' },
      },
      page_size: 50,
    }),
  });

  if (!response.ok) throw new Error(`Notion query failed: ${response.status}`);
  const data = (await response.json()) as { results: Array<Record<string, unknown>> };

  return data.results.map(pageToLead);
}

export async function getLeadById(env: Env, pageId: string): Promise<Lead> {
  const response = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'GET',
    headers: headers(env),
  });

  if (!response.ok) throw new Error(`Notion page fetch failed: ${response.status}`);
  const page = (await response.json()) as Record<string, unknown>;

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
  await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH',
    headers: headers(env),
    body: JSON.stringify({
      properties: {
        Status: { select: { name: status } },
      },
    }),
  });
}

export async function saveOutreachDraft(env: Env, draft: OutreachDraft, leadPageId: string): Promise<void> {
  // Save to Outreach Log DB
  await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({
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
    }),
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
