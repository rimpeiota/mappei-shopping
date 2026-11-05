import { CommerceError, parseCommercePage, validCursor, validIntegrationId, type CommercePage } from './commerce-contract.ts';

export const DOCOMO_EVENT_ENDPOINT = 'https://mappei-docomo-sync-prototype.macadamia-r-o-0126.workers.dev/v1/events';
export type CommerceEnvironment = { DB?: D1Database; DOCOMO_EVENTS_URL?: string; DOCOMO_EVENT_READ_TOKEN?: string; DOCOMO_INTEGRATION_ID?: string; DOCOMO_OWNER_HASH?: string };
export type CommerceSource = { endpoint: typeof DOCOMO_EVENT_ENDPOINT; token: string; integrationId: string };
const sourceFailure = () => new CommerceError(503, '配送通知を取得できませんでした。買い物の記録は変更していません。');

/** The owner comes exclusively from Sites identity; browser selectors never choose a mailbox. */
export async function commerceSourceForOwner(owner: string, env: CommerceEnvironment): Promise<CommerceSource | null> {
  if (env.DOCOMO_EVENTS_URL !== DOCOMO_EVENT_ENDPOINT || !validIntegrationId(env.DOCOMO_INTEGRATION_ID)
    || !env.DOCOMO_EVENT_READ_TOKEN || env.DOCOMO_EVENT_READ_TOKEN.length < 32 || env.DOCOMO_EVENT_READ_TOKEN.length > 512
    || /[\u0000-\u0020\u007f]/u.test(env.DOCOMO_EVENT_READ_TOKEN) || !/^[a-f0-9]{64}$/u.test(env.DOCOMO_OWNER_HASH ?? '')) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(owner));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== env.DOCOMO_OWNER_HASH) return null;
  return { endpoint: DOCOMO_EVENT_ENDPOINT, token: env.DOCOMO_EVENT_READ_TOKEN, integrationId: env.DOCOMO_INTEGRATION_ID };
}

export async function fetchCommercePage(source: CommerceSource, cursor: number, options: {
  fetcher?: typeof fetch; timeoutMs?: number; maxBytes?: number;
} = {}): Promise<CommercePage> {
  if (source.endpoint !== DOCOMO_EVENT_ENDPOINT || !validCursor(cursor)) throw sourceFailure();
  const url = new URL(source.endpoint); url.searchParams.set('cursor', String(cursor)); url.searchParams.set('limit', '100');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
    controller.abort(); void reader?.cancel().catch(() => {}); reject(sourceFailure());
  }, options.timeoutMs ?? 10000); });
  const read = async () => {
    const response = await (options.fetcher ?? fetch)(url.toString(), { headers: { Authorization: `Bearer ${source.token}`, Accept: 'application/json' },
      cache: 'no-store', redirect: 'manual', signal: controller.signal });
    if (!response.ok || response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !response.body) throw sourceFailure();
    const maximum = options.maxBytes ?? 512 * 1024;
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) { void response.body.cancel().catch(() => {}); throw sourceFailure(); }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maximum) { void reader.cancel().catch(() => {}); throw sourceFailure(); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw sourceFailure(); }
    return parseCommercePage(payload, source.integrationId, cursor);
  };
  try { return await Promise.race([read(), deadline]); }
  catch (error) { controller.abort(); void reader?.cancel().catch(() => {}); throw error instanceof CommerceError ? error : sourceFailure(); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
