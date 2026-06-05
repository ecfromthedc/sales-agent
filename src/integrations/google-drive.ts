/**
 * Google Drive — polls for new Meet transcript files.
 *
 * Google Meet drops transcripts and Gemini notes into "Meet Recordings" folders
 * in the organizer's Drive. There can be multiple such folders (primary + shared).
 * We search THREE ways to guarantee we find every transcript:
 *
 *   1. Primary "Meet Recordings" folder (MEET_RECORDINGS_FOLDER_ID)
 *   2. Secondary "Meet Recordings" folder (MEET_RECORDINGS_FOLDER_ID_2, optional)
 *   3. Broad Drive-wide search for any file named "Transcript" or "Notes by Gemini"
 *      owned by the organizer, regardless of folder — catches edge cases where
 *      Google puts transcripts in unexpected locations.
 *
 * File naming patterns:
 *   "<Meeting Title> - Transcript YYYY/MM/DD HH:MM PDT.txt"   (older)
 *   "<Meeting Title> - YYYY/MM/DD HH:MM PDT - Transcript"      (newer Google Docs)
 *   "Meeting started YYYY/MM/DD HH:MM TZ - Notes by Gemini"    (Gemini notes)
 *
 * State persists in KV under `transcript-poll:cursor`.
 */

import type { Env } from "../lib/env";
import { getGoogleAccessToken } from "./google-auth";

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
 * Searches both configured folders AND does a broad Drive-wide sweep.
 * Deduplicates by file ID. Returns newest-first.
 */
export async function listMeetTranscriptsSince(
  since: string,
  env: Env,
): Promise<MeetTranscriptFile[]> {
  const token = await getGoogleAccessToken(env);

  // Build parallel search queries:
  // 1. Primary Meet Recordings folder
  // 2. Secondary Meet Recordings folder (if configured)
  // 3. Broad Drive-wide search for transcript/notes files
  const queries: string[] = [];

  if (env.MEET_RECORDINGS_FOLDER_ID) {
    queries.push(
      [
        `'${env.MEET_RECORDINGS_FOLDER_ID}' in parents`,
        `(name contains 'Transcript' or name contains 'Notes by Gemini')`,
        `modifiedTime > '${since}'`,
        `trashed = false`,
      ].join(" and "),
    );
  }

  if (env.MEET_RECORDINGS_FOLDER_ID_2) {
    queries.push(
      [
        `'${env.MEET_RECORDINGS_FOLDER_ID_2}' in parents`,
        `(name contains 'Transcript' or name contains 'Notes by Gemini')`,
        `modifiedTime > '${since}'`,
        `trashed = false`,
      ].join(" and "),
    );
  }

  // Broad sweep: any transcript/notes file anywhere in Drive, owned by me
  queries.push(
    [
      `(name contains 'Transcript' or name contains 'Notes by Gemini')`,
      `(mimeType = 'application/vnd.google-apps.document' or mimeType = 'text/plain')`,
      `modifiedTime > '${since}'`,
      `'me' in owners`,
      `trashed = false`,
    ].join(" and "),
  );

  if (queries.length === 0) {
    console.warn("drive_list_skipped_no_queries");
    return [];
  }

  // Run all queries in parallel
  const results = await Promise.allSettled(
    queries.map((q) => searchDrive(q, token)),
  );

  // Merge and deduplicate by file ID
  const seen = new Set<string>();
  const merged: MeetTranscriptFile[] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      console.error("drive_search_partial_failure", { error: (result.reason as Error).message });
      continue;
    }
    for (const file of result.value) {
      if (seen.has(file.id)) continue;
      seen.add(file.id);
      merged.push({
        ...file,
        inferredMeetingStart: parseMeetingStartFromName(file.name),
      });
    }
  }

  // Sort newest-first
  merged.sort((a, b) => new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime());

  console.log("drive_transcript_search", {
    since,
    queriesRun: queries.length,
    filesFound: merged.length,
    fileNames: merged.map((f) => f.name),
  });

  return merged;
}

async function searchDrive(q: string, token: string): Promise<MeetTranscriptFile[]> {
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
    throw new Error(`drive_search_failed: ${res.status} ${await res.text()}`);
  }

  const j = (await res.json()) as { files: MeetTranscriptFile[] };
  return j.files ?? [];
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
function parseMeetingStartFromName(name: string): string | undefined {
  // Match YYYY[/-]MM[/-]DD HH:MM
  const m = name.match(/(\d{4})[\/-](\d{2})[\/-](\d{2})[\s,]+(\d{1,2})[:.]?(\d{2})/);
  if (!m) return undefined;
  const [, y, mo, d, hh, mm] = m;
  // Assume America/New_York since that's Eric's TZ; the exact offset varies.
  // For dedup-resolution purposes we just need it within a 1-hour window of the deal.
  return new Date(`${y}-${mo}-${d}T${hh.padStart(2, "0")}:${mm}:00-04:00`).toISOString();
}
