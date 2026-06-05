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
  TEST_AUTH_KEY: string;
  RAPIDAPI_KEY: string;
  CHARTMETRIC_REFRESH_TOKEN: string;     // long-lived; exchanged for 1h access tokens
  FIREFLIES_API_KEY: string;
  FIREFLIES_WEBHOOK_SECRET: string;
  SLACK_SIGNING_SECRET: string;          // verifies Slack Events API requests

  // Vars — runtime config
  NOTION_DEALS_DB_ID: string;
  NOTION_TRANSCRIPTS_DB_ID: string;
  NOTION_PITCH_ARTIFACTS_DB_ID: string;
  MEET_RECORDINGS_FOLDER_ID: string;
  MEET_RECORDINGS_FOLDER_ID_2: string;  // secondary Meet Recordings folder (some orgs have multiple)
  SLACK_BOT_TOKEN: string;
  SLACK_BRIEF_CHANNEL_ID: string;
  SLACK_PROPOSALS_CHANNEL_ID: string;
  PUBLIC_BASE_URL: string;               // e.g. https://rt-sales-call-agent.<sub>.workers.dev — for proposal live links

  // Bindings
  PITCH_PDFS: R2Bucket;
  STATE: KVNamespace;
  // AGENT_RUN: DurableObjectNamespace;
}
