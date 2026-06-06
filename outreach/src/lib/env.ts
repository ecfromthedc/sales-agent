export interface Env {
  // KV
  STATE: KVNamespace;

  // Secrets
  ANTHROPIC_API_KEY: string;
  NOTION_API_KEY: string;
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
  GMAIL_OAUTH_CLIENT_ID: string;
  GMAIL_OAUTH_CLIENT_SECRET: string;
  GMAIL_OAUTH_REFRESH_TOKEN: string;

  // Vars (Notion DB IDs)
  LEADS_DB_ID: string;
  LABELS_DB_ID: string;
  ARTISTS_DB_ID: string;
  OUTREACH_LOG_DB_ID: string;

  // Optional
  RT_SLACK_NOTIFY_WEBHOOK?: string;
}
