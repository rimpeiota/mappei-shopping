declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
    CLOUDFLARE_ACCOUNT_ID?: string;
    CLOUDFLARE_AI_TOKEN?: string;
    DOCOMO_EVENTS_URL?: string;
    DOCOMO_EVENT_READ_TOKEN?: string;
    DOCOMO_INTEGRATION_ID?: string;
    DOCOMO_OWNER_HASH?: string;
  }
}
