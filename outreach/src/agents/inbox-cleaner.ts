import type { Env } from '../lib/env';
import { archiveEmailsByQuery } from '../integrations/gmail';

/**
 * Blocklisted senders whose emails get archived from Henry's inbox.
 * These are Cloudflare-routed notification emails that clutter outreach work.
 *
 * Add new addresses here as they surface.
 * Format: exact "from" address.
 */
const ARCHIVE_SENDERS = [
  'notification@service.tiktok.com',
  'ttsmarketplace@email.tiktok.com',
];

/**
 * Senders that look similar to blocklisted ones but should STAY in the inbox.
 * This list exists purely as documentation — the cleaner only touches ARCHIVE_SENDERS.
 */
const _KEEP_SENDERS = [
  'register@account.tiktok.com',
];

export interface CleanerResult {
  archived: number;
  errors: string[];
  sendersChecked: number;
}

/**
 * Sweep Henry's inbox every 2 hours.
 * Archives emails from known junk senders so outreach stays clean.
 */
export async function runInboxCleaner(env: Env): Promise<CleanerResult> {
  const result: CleanerResult = {
    archived: 0,
    errors: [],
    sendersChecked: ARCHIVE_SENDERS.length,
  };

  for (const sender of ARCHIVE_SENDERS) {
    try {
      const count = await archiveEmailsByQuery(env, `from:${sender} in:inbox`, 100);
      result.archived += count;
    } catch (e) {
      result.errors.push(`${sender}: ${e}`);
    }
  }

  // Save state
  await env.STATE.put(
    'last_inbox_clean',
    JSON.stringify({
      timestamp: new Date().toISOString(),
      archived: result.archived,
    }),
  );

  return result;
}
