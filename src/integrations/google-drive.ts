/**
 * Google Drive — polls the Meet Recordings folder for new transcript files.
 *
 * Google Meet auto-transcription (enabled in Workspace Admin) drops transcript
 * files into a "Meet Recordings" folder in the host's Drive. File naming pattern:
 *   "<Meeting Title> - Transcript YYYY/MM/DD HH:MM PDT.txt"   (older)
 *   "<Meeting Title> - YYYY/MM/DD HH:MM PDT - Transcript"      (newer Google Docs)
 *
 * We use a cron trigger (every 5 min) to list files in the folder modified since
 * the last successful poll. State persists in KV under `transcript-poll:cursor`.
 *
 * All Drive calls authenticate via the shared OAuth token broker
 * (`getGoogleAccessToken` in ./google-auth — SALE-108). This module holds NO
 * token-exchange logic of its own; same OAuth client as Gmail.
 */

import type { Env } from "../lib/env";
// SALE-109: import the auth primitive via the shared barrel (cross-role surface)
// rather than reaching into ./google-auth directly.
import { getGoogleAccessToken } from "../shared";

export interface MeetTranscriptFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
  modifiedTime: string;
  webViewLink?: string;
  inferredMeetingStart?: string; // best-effort parsed from filename
}

const DRIVE_API = "https://www.googleapis.com/drive/v3";

/**
 * List transcript files modified since `since` ISO timestamp.
 * Returns newest-first.
 */
export async function listMeetTranscriptsSince(
  since: string,
  env: Env,
): Promise<MeetTranscriptFile[]> {
  if (!env.MEET_RECORDINGS_FOLDER_ID) {
    console.warn("drive_list_skipped_no_folder_id");
    return [];
  }
  const token = await getGoogleAccessToken(env);

  // Drive query: in the recordings folder, file is either a Chat Transcript
  // OR a "Notes by Gemini" summary (Workspace Business/Enterprise generates
  // these instead of raw transcripts on some plans). Modified after `since`.
  const q = [
    `'${env.MEET_RECORDINGS_FOLDER_ID}' in parents`,
    `(name contains 'Transcript' or name contains 'Notes by Gemini')`,
    `modifiedTime > '${since}'`,
    `trashed = false`,
  ].join(" and ");

  const params = new URLSearchParams({
    q,
    fields: "files(id,name,mimeType,createdTime,modifiedTime,webViewLink)",
    orderBy: "modifiedTime desc",
    pageSize: "50",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });

  const res = await fetch(`${DRIVE_API}/files?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`drive_list_failed: ${res.status} ${await res.text()}`);
  }

  const j = (await res.json()) as { files: MeetTranscriptFile[] };
  return (j.files ?? []).map((f) => ({
    ...f,
    inferredMeetingStart: parseMeetingStartFromName(f.name),
  }));
}

/**
 * Download transcript content. Google Docs need export; plain .txt is direct.
 */
export async function downloadTranscriptText(
  file: MeetTranscriptFile,
  env: Env,
): Promise<string> {
  const token = await getGoogleAccessToken(env);

  // Google Docs MIME type → export as plain text
  if (file.mimeType === "application/vnd.google-apps.document") {
    const res = await fetch(
      `${DRIVE_API}/files/${file.id}/export?mimeType=text/plain`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`drive_export_failed: ${res.status}`);
    return res.text();
  }

  // Anything else (text/plain, .vtt, etc.) → direct download
  const res = await fetch(`${DRIVE_API}/files/${file.id}?alt=media`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`drive_download_failed: ${res.status}`);
  return res.text();
}

/**
 * Best-effort: pull the meeting timestamp out of the filename.
 * Examples:
 *   "Rising Tides Strategy Session - 2026/05/14 11:30 EDT - Transcript"
 *   "Rising Tides Strategy Session - Transcript 2026-05-14 1130 EDT"
 *
 * Returns ISO string or undefined.
 */
export function parseMeetingStartFromName(name: string): string | undefined {
  // Match YYYY[/-]MM[/-]DD HH:MM
  const m = name.match(/(\d{4})[\/-](\d{2})[\/-](\d{2})[\s,]+(\d{1,2})[:.]?(\d{2})/);
  if (!m) return undefined;
  const [, y, mo, d, hh, mm] = m;
  // Assume America/New_York since that's Eric's TZ; the exact offset varies.
  // For dedup-resolution purposes we just need it within a 1-hour window of the deal.
  return new Date(`${y}-${mo}-${d}T${hh.padStart(2, "0")}:${mm}:00-04:00`).toISOString();
}
