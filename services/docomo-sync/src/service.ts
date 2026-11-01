import { CollectorError, LOOKBACK_DAYS, MAX_MAIL_BYTES, ReadOnlyImap } from './imap.ts';
import { inspectCandidate, normalizeMail, type NormalizedCommerceEvent } from './event.ts';

export type Env = {
  DB?: D1Database;
  INTEGRATION_ID?: string;
  MAILBOX?: string;
  DOCOMO_ACCOUNT_ID?: string;
  DOCOMO_IMAP_PASSWORD?: string;
  EVENT_READ_TOKEN?: string;
  COLLECT_TOKEN?: string;
};
type State = { uid_validity: string; last_uid: number; auth_blocked: number };
const validIntegration = (value: string | undefined): value is string => !!value && /^[A-Za-z0-9_-]{16,128}$/u.test(value);
export function configured(env: Env): boolean {
  return !!env.DB && validIntegration(env.INTEGRATION_ID) && !!env.DOCOMO_ACCOUNT_ID && !!env.DOCOMO_IMAP_PASSWORD
    && typeof env.EVENT_READ_TOKEN === 'string' && env.EVENT_READ_TOKEN.length >= 32;
}

/** The caller supplies a TLS socket factory; no socket or credentials are created during builds. */
export async function collect(env: Env, open: () => ReadOnlyImap, now = Date.now()): Promise<string> {
  if (!configured(env)) return 'not_configured';
  const db = env.DB!;
  const prior = await db.prepare('SELECT uid_validity, last_uid, auth_blocked FROM collector_state WHERE id = 1').first<State>();
  if (!prior) throw new CollectorError('database_schema_missing');
  if (prior.auth_blocked) return 'authentication_blocked';
  const leaseUntil = now + 240000;
  const lease = await db.prepare('UPDATE collector_state SET lease_until = ? WHERE id = 1 AND lease_until <= ? AND auth_blocked = 0').bind(leaseUntil, now).run();
  if (!lease.meta.changes) {
    const current = await db.prepare('SELECT auth_blocked FROM collector_state WHERE id = 1').first<{ auth_blocked: number }>();
    return current?.auth_blocked ? 'authentication_blocked' : 'already_running';
  }
  let imap: ReadOnlyImap | undefined;
  try {
    imap = open();
    await imap.login(env.DOCOMO_ACCOUNT_ID!, env.DOCOMO_IMAP_PASSWORD!);
    const mailbox = env.MAILBOX || 'INBOX';
    const validity = await imap.examine(mailbox);
    const lastUid = prior.uid_validity === validity ? prior.last_uid : 0;
    if (prior.uid_validity !== validity) await db.prepare('UPDATE collector_state SET uid_validity = ?, last_uid = 0 WHERE id = 1 AND lease_until = ?').bind(validity, leaseUntil).run();
    const cutoff = now - LOOKBACK_DAYS * 86400000;
    const page = await imap.search(new Date(cutoff), lastUid);
    for (const uid of page.uids) {
      const header = await imap.headers(uid);
      if (header.internalDate >= cutoff && header.internalDate <= now + 300000) {
        const candidate = await inspectCandidate(header.bytes);
        if (candidate.candidate) {
          // Large messages remain review-only based on headers; attachments are never downloaded separately.
          const tooLarge = header.size > MAX_MAIL_BYTES;
          const raw = tooLarge ? header.bytes : await imap.body(uid);
          const event = await normalizeMail(raw, { integrationId: env.INTEGRATION_ID!, mailbox, uidValidity: validity, uid,
            observedAtISO: new Date(now).toISOString() }, tooLarge);
          await db.prepare('INSERT OR IGNORE INTO commerce_events (event_id, account_scope, payload, observed_at) VALUES (?, ?, ?, ?)')
            .bind(event.id, event.accountScope, JSON.stringify(event), event.observedAtISO).run();
        }
      }
      // Advance only after the event is durable. A retry before this line has the same event ID.
      await db.prepare('UPDATE collector_state SET last_uid = ? WHERE id = 1 AND lease_until = ?').bind(uid, leaseUntil).run();
    }
    await db.prepare('UPDATE collector_state SET last_success_at = ?, last_error_code = NULL, limited = ? WHERE id = 1 AND lease_until = ?')
      .bind(new Date(now).toISOString(), page.limited ? 1 : 0, leaseUntil).run();
    return page.limited ? 'more_pending' : 'success';
  } catch (error) {
    // Exception text can include provider replies. Persist only our fixed error codes.
    const code = error instanceof CollectorError ? error.code : 'collector_failed';
    await db.prepare('UPDATE collector_state SET last_error_code = ?, auth_blocked = ? WHERE id = 1 AND lease_until = ?')
      .bind(code, code === 'imap_authentication_failed' ? 1 : 0, leaseUntil).run();
    return code;
  } finally {
    await imap?.close();
    await db.prepare('UPDATE collector_state SET lease_until = 0 WHERE id = 1 AND lease_until = ?').bind(leaseUntil).run();
  }
}

function response(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
async function authorized(request: Request, token: string): Promise<boolean> {
  const received = request.headers.get('authorization') ?? '';
  if (received.length > 1024) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(received)), crypto.subtle.digest('SHA-256', encoder.encode(`Bearer ${token}`))]);
  const left = new Uint8Array(a), right = new Uint8Array(b);
  let different = 0; for (let index = 0; index < left.length; index += 1) different |= left[index] ^ right[index];
  return different === 0;
}

/** Some transports expose an already-ended stream even when the POST has no body. */
async function hasEmptyBody(request: Request): Promise<boolean> {
  const body = request.body;
  const length = request.headers.get('content-length');
  if (length !== null && length.trim() !== '0') {
    void body?.cancel().catch(() => {});
    return false;
  }
  if (body === null) return true;
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let empty = false;
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('body_timeout')), 1000); }),
    ]);
    const bytes = result.value;
    empty = result.done === true && (!bytes || bytes.byteLength === 0);
    return empty;
  } catch { return false; }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!empty) void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* The rejected pending read must not delay rejection. */ }
  }
}

/** Event-read only: no caller can trigger polling, issue IMAP commands, supply an owner, or mutate mail. */
export async function handleRequest(request: Request, env: Env, open?: () => ReadOnlyImap): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') return response({ service: 'docomo-sync-prototype', mode: 'review_only' });
  if (url.pathname === '/v1/collect') {
    if (request.method !== 'POST') return response({ error: 'method_not_allowed' }, 405);
    if (!env.COLLECT_TOKEN || env.COLLECT_TOKEN.length < 32 || env.COLLECT_TOKEN === env.EVENT_READ_TOKEN
      || !await authorized(request, env.COLLECT_TOKEN)) return response({ error: 'unauthorized' }, 401);
    if (url.search || !await hasEmptyBody(request)) return response({ error: 'invalid_query' }, 400);
    if (!configured(env) || !open) return response({ error: 'not_configured' }, 503);
    try {
      const result = await collect(env, open);
      return response({ result }, result === 'success' || result === 'more_pending' ? 200 : result === 'already_running' ? 409 : 503);
    } catch { return response({ error: 'collection_failed' }, 503); }
  }
  if (url.pathname !== '/v1/events') return response({ error: 'not_found' }, 404);
  if (request.method !== 'GET') return response({ error: 'method_not_allowed' }, 405);
  if (!env.EVENT_READ_TOKEN || env.EVENT_READ_TOKEN.length < 32 || !await authorized(request, env.EVENT_READ_TOKEN)) return response({ error: 'unauthorized' }, 401);
  if (!env.DB || !validIntegration(env.INTEGRATION_ID)) return response({ error: 'not_configured' }, 503);
  if ([...url.searchParams.keys()].some(key => !['cursor', 'limit'].includes(key))) return response({ error: 'invalid_query' }, 400);
  const rawCursor = url.searchParams.get('cursor') ?? '0', rawLimit = url.searchParams.get('limit') ?? '50';
  if (!/^\d{1,16}$/u.test(rawCursor) || !/^\d{1,3}$/u.test(rawLimit)) return response({ error: 'invalid_query' }, 400);
  const cursor = Number(rawCursor), limit = Number(rawLimit);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) return response({ error: 'invalid_query' }, 400);
  try {
    const rows = await env.DB.prepare('SELECT sequence, payload FROM commerce_events WHERE account_scope = ? AND sequence > ? ORDER BY sequence LIMIT ?')
      .bind(env.INTEGRATION_ID, cursor, limit + 1).all<{ sequence: number; payload: string }>();
    const included = rows.results.slice(0, limit);
    const events = included.map(row => ({ sequence: row.sequence, event: JSON.parse(row.payload) as NormalizedCommerceEvent }));
    const state = await env.DB.prepare('SELECT last_success_at, last_error_code, auth_blocked, limited FROM collector_state WHERE id = 1').first();
    return response({ integrationId: env.INTEGRATION_ID, events, cursor: included.at(-1)?.sequence ?? cursor, hasMore: rows.results.length > limit, collector: state });
  } catch { return response({ error: 'event_read_failed' }, 503); }
}
