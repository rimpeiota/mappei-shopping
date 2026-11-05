import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommerceSyncBoundary } from '../lib/client-commerce';
const { commerceSyncRevision, readCommerceStatus, requestCommerceStatus, CommerceRequestError } = await import(new URL('../lib/client-commerce.ts', import.meta.url).href) as typeof import('../lib/client-commerce');

const status = () => ({ mode: 'review_only', connected: true, importedCount: 30, reviewCount: 30, completedCount: 0,
  lastSyncedAt: null, hasMore: false, sourceCollectorLastSuccessAt: '2026-11-01T14:57:13.160Z', sourceLimited: true, authBlocked: false });
const boundary = (): CommerceSyncBoundary => ({ owner: 'account', key: 'mappei-shopping-v1:owner:account', revision: 7,
  enabled: true, dirty: false, saving: false, paused: false, held: false, storageReadBlocked: false,
  upgradeRequired: false, sharedCacheBlocked: false, sharedCacheRevision: 7, online: true, visible: true });

test('review requests require the current clean owner snapshot and preserve revision zero', () => {
  assert.equal(commerceSyncRevision(boundary()), 7);
  assert.equal(commerceSyncRevision({ ...boundary(), revision: 0, sharedCacheRevision: 0 }), 0);
  for (const patch of [{ owner: '' }, { key: 'mappei-shopping-v1:anonymous' }, { enabled: false }, { dirty: true },
    { saving: true }, { paused: true }, { held: true }, { storageReadBlocked: true }, { upgradeRequired: true },
    { sharedCacheBlocked: true }, { sharedCacheRevision: 8 }, { online: false }, { visible: false }, { revision: -1 }, { revision: NaN }]) {
    assert.equal(commerceSyncRevision({ ...boundary(), ...patch }), null, JSON.stringify(patch));
  }
});

test('only the review status is retained; arbitrary mail and provider fields are discarded', () => {
  assert.deepEqual(readCommerceStatus({ ...status(), rawMail: 'not for the UI', token: 'not for the UI', revision: 7 }), status());
  assert.deepEqual(readCommerceStatus({ ...status(), connected: false, importedCount: 0, reviewCount: 0 }), { ...status(), connected: false, importedCount: 0, reviewCount: 0 });
});

test('invalid counters, completion claims, mode, and dates fail closed', () => {
  for (const patch of [{ mode: 'automatic' }, { importedCount: -1 }, { importedCount: 1.5 }, { reviewCount: '30' },
    { completedCount: 1 }, { hasMore: 1 }, { sourceLimited: null }, { authBlocked: undefined },
    { lastSyncedAt: 'not a date' }, { sourceCollectorLastSuccessAt: 123 }]) {
    assert.equal(readCommerceStatus({ ...status(), ...patch }), null, JSON.stringify(patch));
  }
  assert.equal(readCommerceStatus(null), null);
  assert.equal(readCommerceStatus([]), null);
});

test('status GET is fixed, same-origin, non-cached and abortable without any owner or source fields', async () => {
  const controller = new AbortController();
  const calls: [RequestInfo | URL, RequestInit | undefined][] = [];
  const request = (async (url, init) => { calls.push([url, init]); return Response.json(status()); }) as typeof fetch;
  assert.deepEqual(await requestCommerceStatus(controller.signal, undefined, request), status());
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/commerce');
  assert.deepEqual(calls[0][1], { method: 'GET', cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
});

test('sync POST sends only a revision and never shopping data, owner, events, or provider URL', async () => {
  const controller = new AbortController();
  let called = false;
  const request = (async (url, init) => {
    called = true; assert.equal(url, '/api/commerce/sync'); assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { revision: 7 });
    assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.cache, 'no-store'); assert.equal(init?.signal, controller.signal);
    assert.deepEqual(init?.headers, { 'Content-Type': 'application/json' });
    return Response.json({ ...status(), revision: 7, addedCount: 30 });
  }) as typeof fetch;
  assert.deepEqual(await requestCommerceStatus(controller.signal, 7, request), status());
  assert.equal(called, true);
});

test('invalid revision cannot issue any request', async () => {
  let calls = 0;
  const request = (async () => { calls += 1; return Response.json(status()); }) as typeof fetch;
  for (const revision of [-1, NaN, Infinity, 1.5]) {
    await assert.rejects(requestCommerceStatus(new AbortController().signal, revision, request), (error: unknown) => error instanceof CommerceRequestError && error.kind === 'invalid');
  }
  assert.equal(calls, 0);
});

test('access, revision conflict, network status, and malformed replies have bounded public errors', async () => {
  for (const [httpStatus, kind] of [[401, 'signed-out'], [403, 'signed-out'], [409, 'conflict'], [500, 'unavailable']] as const) {
    const request = (async () => new Response('private provider error', { status: httpStatus })) as typeof fetch;
    await assert.rejects(requestCommerceStatus(new AbortController().signal, 7, request), (error: unknown) => error instanceof CommerceRequestError && error.kind === kind && !error.message.includes('private'));
  }
  for (const request of [(async () => new Response('not JSON')), (async () => Response.json({ ...status(), completedCount: 1 }))]) {
    await assert.rejects(requestCommerceStatus(new AbortController().signal, undefined, request as typeof fetch), (error: unknown) => error instanceof CommerceRequestError && error.kind === 'invalid');
  }
});
