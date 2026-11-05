import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
const { commerceSourceForOwner, DOCOMO_EVENT_ENDPOINT, fetchCommercePage } = await import(new URL('../lib/server-commerce-source.ts', import.meta.url).href) as typeof import('../lib/server-commerce-source');
const { parseCommercePage } = await import(new URL('../lib/commerce-contract.ts', import.meta.url).href) as typeof import('../lib/commerce-contract');
import type { CommercePage } from '../lib/commerce-contract';

const scope = 'synthetic-integration-0001';
const time = '2026-11-04T12:00:00.000Z';
const eventId = (value: string) => createHash('sha256').update(value).digest('hex');
const event = (overrides: Record<string, unknown> = {}) => ({ id: eventId('fixture-notice-1'), merchant: 'rakuten', accountScope: scope,
  kind: 'delivered', orderId: null, orderLineId: null, productKey: null, shipmentId: null, quantity: null, unit: null,
  orderedAt: null, deliveredAt: null, explicitConfirmed: false, observedAtISO: time, parserVersion: 1, ...overrides });
const page = (overrides: Record<string, unknown> = {}) => ({ integrationId: scope, events: [{ sequence: 1, event: event() }], cursor: 1,
  hasMore: false, collector: { last_success_at: time, last_error_code: null, limited: 1, auth_blocked: 0 }, ...overrides });
const source = { endpoint: DOCOMO_EVENT_ENDPOINT, token: 'synthetic-token-is-not-a-secret-00000000', integrationId: scope } as const;
const response = (data: unknown) => Response.json(data);
const owner = 'synthetic-owner-a';
async function ownerHash(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join(''); }

test('server config binds exactly one trusted owner to the fixed source endpoint', async () => {
  const env = { DOCOMO_EVENTS_URL: DOCOMO_EVENT_ENDPOINT, DOCOMO_EVENT_READ_TOKEN: source.token, DOCOMO_INTEGRATION_ID: scope, DOCOMO_OWNER_HASH: await ownerHash(owner) };
  assert.deepEqual(await commerceSourceForOwner(owner, env), source);
  assert.equal(await commerceSourceForOwner('synthetic-owner-b', env), null);
  for (const overrides of [{ DOCOMO_EVENTS_URL: 'https://example.com/v1/events' }, { DOCOMO_EVENTS_URL: `${DOCOMO_EVENT_ENDPOINT}?owner=other` },
    { DOCOMO_EVENTS_URL: DOCOMO_EVENT_ENDPOINT.replace('https:', 'http:') }, { DOCOMO_EVENT_READ_TOKEN: 'short' },
    { DOCOMO_EVENT_READ_TOKEN: `${source.token}\r\nheader: value` }, { DOCOMO_INTEGRATION_ID: '../other' }, { DOCOMO_OWNER_HASH: owner }]) {
    assert.equal(await commerceSourceForOwner(owner, { ...env, ...overrides }), null);
  }
});

test('source fetch sends its read token only to the fixed endpoint, with bounded pagination and no redirects', async () => {
  let called = 0;
  const result = await fetchCommercePage(source, 0, { fetcher: async (input, init) => {
    called += 1; assert.equal(String(input), `${DOCOMO_EVENT_ENDPOINT}?cursor=0&limit=100`);
    assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store');
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${source.token}`);
    assert.ok(init?.signal); return response(page());
  } });
  assert.equal(called, 1); assert.equal(result.events[0].event.explicitConfirmed, false);
  assert.deepEqual(result.collector, { last_success_at: time, last_error_code: null, limited: 1, auth_blocked: 0 });
});

test('the source page enforces scope, strict monotonic sequences and an exact durable cursor', () => {
  const valid = page(); assert.equal(parseCommercePage(valid, scope, 0).cursor, 1);
  const rejected = [page({ integrationId: 'another-integration-0001' }), page({ cursor: 2 }), page({ cursor: 0 }),
    page({ events: [], cursor: 0, hasMore: true }), page({ events: [{ sequence: 0, event: event() }], cursor: 0 }),
    page({ events: [{ sequence: 2, event: event() }, { sequence: 1, event: event({ id: 'other' }) }] }),
    page({ events: [{ sequence: 1, event: event() }, { sequence: 1, event: event({ id: 'other' }) }] }),
    page({ events: Array.from({ length: 101 }, (_, index) => ({ sequence: index + 1, event: event({ id: eventId(`notice-${index}`) }) })), cursor: 101 }),
    page({ events: [{ sequence: 1, event: event({ accountScope: 'another-integration-0001' }) }] }),
    page({ collector: null }), page({ collector: { last_success_at: time, auth_blocked: '1', limited: 0 } })];
  for (const raw of rejected) assert.throws(() => parseCommercePage(raw, scope, 0));
  assert.throws(() => parseCommercePage(valid, scope, 1));
  assert.deepEqual(parseCommercePage(page({ events: [], cursor: 3 }), scope, 3).events, []);
});

test('even a claimed confirmed delivery is rejected before any cursor can advance', () => {
  for (const overrides of [{ explicitConfirmed: true }, { explicitConfirmed: 'false' }, { parserVersion: 2 },
    { rawBody: 'raw private mail must not enter the ledger' }, { recipient: 'fixture@example.invalid' },
    { id: 'x'.repeat(257) }, { id: 'line\nbreak' }, { quantity: 1.5 }, { quantity: 0 }, { unit: '' },
    { observedAtISO: '2026-02-30T00:00:00Z' }, { observedAtISO: '2026-11-04' }, { deliveredAt: '2026-11-04T24:00:00Z' }]) {
    assert.throws(() => parseCommercePage(page({ events: [{ sequence: 1, event: event(overrides) }] }), scope, 0));
  }
});

test('HTTP failures, invalid UTF-8/JSON, and oversized or non-JSON bodies have fixed private errors', async () => {
  const sentinel = 'DO-NOT-ECHO-PROVIDER-TEXT';
  const responses = [new Response(sentinel, { status: 401 }), new Response(sentinel, { status: 302, headers: { location: 'https://example.invalid/' } }),
    new Response(sentinel, { headers: { 'content-type': 'text/html' } }), new Response(sentinel, { headers: { 'content-type': 'application/json' } }),
    new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1000000' } }), response(page())];
  for (const reply of responses) {
    await assert.rejects(fetchCommercePage(source, 0, { maxBytes: 64, fetcher: async () => reply }), error => {
      assert.ok(error instanceof Error); assert.equal(error.message.includes(sentinel), false); assert.equal(error.message.includes(source.token), false); return true;
    });
  }
});

test('the deadline covers both stalled response headers and a stalled body stream', async () => {
  const start = Date.now();
  await assert.rejects(fetchCommercePage(source, 0, { timeoutMs: 20, fetcher: () => new Promise<Response>(() => {}) }));
  let cancelled = false;
  await assert.rejects(fetchCommercePage(source, 0, { timeoutMs: 20, fetcher: async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json' } }) }));
  assert.equal(cancelled, true); assert.ok(Date.now() - start < 2000);
});

test('source shape remains safe when parsed a second time at the storage boundary', () => {
  const first = parseCommercePage(page(), scope, 0);
  assert.deepEqual(parseCommercePage(first as CommercePage, scope, 0), first);
});

test('collector failures become a fixed marker, never provider error text', () => {
  const result = parseCommercePage(page({ collector: { last_success_at: time, last_error_code: 'synthetic-provider-detail', auth_blocked: 1, limited: 0 } }), scope, 0);
  assert.equal(result.collector.last_error_code, 'source_error');
  assert.equal(JSON.stringify(result).includes('synthetic-provider-detail'), false);
  assert.deepEqual(parseCommercePage(result, scope, 0), result);
});
