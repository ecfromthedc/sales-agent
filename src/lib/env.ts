/**
 * Worker environment bindings.
 * Secrets are set via `wrangler secret put <NAME>`.
 * Vars are set in wrangler.toml [vars].
 */
export interface Env {
  // Secrets — runtime
  ANTHROPIC_API_KEY: string;
  NOTION_API_KEY: string;
  CALENDLY_WEBHOOK_SIGNING_KEY: string;
  CALENDLY_PERSONAL_ACCESS_TOKEN: string;
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
  GMAIL_OAUTH_REFRESH_TOKEN: string;     // covers both Gmail + Drive scopes
  GMAIL_OAUTH_CLIENT_ID: string;
  GMAIL_OAUTH_CLIENT_SECRET: string;
  TIDES_TRACKER_API_KEY: string;
  TIDES_TRACKER_BASE_URL?: string;       // optional; deprecated Tides Tracker host (crm-lookup is canonical)
  TEST_AUTH_KEY: string;
  RAPIDAPI_KEY: string;

  // Vars — runtime config
  NOTION_DEALS_DB_ID: string;
  NOTION_TRANSCRIPTS_DB_ID: string;
  NOTION_PITCH_ARTIFACTS_DB_ID: string;
  MEET_RECORDINGS_FOLDER_ID: string;
  SLACK_BOT_TOKEN: string;
  SLACK_BRIEF_CHANNEL_ID: string;
  SLACK_PROPOSALS_CHANNEL_ID?: string;   // optional; post-call pitch notices (no-ops if unset)

  // Bindings
  PITCH_PDFS: R2Bucket;
  STATE: KVNamespace;
  // AGENT_RUN: DurableObjectNamespace;
}
