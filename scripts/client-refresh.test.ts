import assert from 'node:assert/strict';
import test from 'node:test';
import type { RefreshBoundary, RefreshFailure, RefreshedSnapshot } from '../lib/client-refresh';
const { createRemoteRefreshController, inspectSharedRefreshCache } = await import(new URL('../lib/client-refresh.ts', import.meta.url).href) as typeof import('../lib/client-refresh');
const { emptyState, newItem } = await import(new URL('../lib/client-model.ts', import.meta.url).href) as typeof import('../lib/client-model');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
const boundary = (): RefreshBoundary => ({ owner: 'account', key: 'cache-account', localVersion: 2, revision: 5,
  connectionSequence: 1, enabled: true, dirty: false, saving: false, paused: false, held: false,
  storageReadBlocked: false, upgradeRequired: false, online: true, visible: true,
  sharedCacheBlocked: false, sharedCacheRevision: 5, sharedCacheRaw: null });
const snapshot = (revision = 6, owner = 'account') => ({ owner, revision, state: { ...emptyState(), items: [newItem('別の端末で追加した棚', { id: 'remote-shelf' })] } });
function harness(options: { timeoutMs?: number; request?: (signal: AbortSignal) => Promise<Pick<Response, 'ok' | 'status' | 'json'>> } = {}) {
  const current = boundary();
  const caches = new Map<string, string>([[current.key, JSON.stringify({ state: emptyState(), revision: current.revision, dirty: false, legacyDirty: false })]]);
  const storage = { getItem: (key: string) => caches.get(key) ?? null };
  const reply = deferred<Pick<Response, 'ok' | 'status' | 'json'>>();
  const applied: RefreshedSnapshot[] = [];
  const failures: RefreshFailure[] = [];
  let requests = 0, unchanged = 0;
  let signal: AbortSignal | null = null;
  const controller = createRemoteRefreshController({ boundary: () => ({ ...current, ...inspectSharedRefreshCache(() => storage, current.key) }),
    request: nextSignal => { requests += 1; signal = nextSignal; return options.request?.(nextSignal) ?? reply.promise; },
    apply: value => { applied.push(value); current.revision = value.revision;
      caches.set(current.key, JSON.stringify({ state: value.state, revision: value.revision, dirty: false, legacyDirty: false })); },
    unchanged: () => { unchanged += 1; }, unavailable: reason => { failures.push(reason); }, timeoutMs: options.timeoutMs,
  });
  return { controller, current, reply, applied, failures, caches, storage, requests: () => requests, unchanged: () => unchanged, signal: () => signal };
}

test('an idle screen receives the other device’s newer snapshot through a GET without any write', async () => {
  const h = harness();
  const pending = h.controller.refresh();
  const remote = snapshot(); h.reply.resolve(Response.json(remote));
  assert.equal(await pending, 'applied'); assert.equal(h.requests(), 1); assert.deepEqual(h.applied[0], remote); assert.deepEqual(h.failures, []);
});

test('focus, visible polling, and manual refresh share a single in-flight GET', async () => {
  const h = harness();
  const first = h.controller.refresh();
  assert.equal(await h.controller.refresh(), 'skipped'); assert.equal(await h.controller.refresh(), 'skipped');
  assert.equal(h.requests(), 1);
  h.reply.resolve(Response.json(snapshot(5)));
  assert.equal(await first, 'unchanged'); assert.equal(h.unchanged(), 1); assert.deepEqual(h.applied, []);
});

test('pending edits, saves, dialogs, hidden screens, and offline or blocked states do not issue a GET', async () => {
  for (const patch of [{ dirty: true }, { saving: true }, { paused: true }, { held: true }, { visible: false }, { online: false },
    { enabled: false }, { owner: '' }, { key: '' }, { storageReadBlocked: true }, { upgradeRequired: true }]) {
    const h = harness(); Object.assign(h.current, patch);
    assert.equal(await h.controller.refresh(), 'skipped'); assert.equal(h.requests(), 0); assert.deepEqual(h.applied, []);
  }
});

test('typing while the GET is pending preserves local changes even when they save before the response', async () => {
  const h = harness();
  const pending = h.controller.refresh();
  h.current.dirty = true; h.current.localVersion += 1;
  h.current.saving = true; h.current.dirty = false;
  h.current.saving = false; h.current.revision = 6;
  h.reply.resolve(Response.json(snapshot(7)));
  assert.equal(await pending, 'skipped'); assert.deepEqual(h.applied, []); assert.deepEqual(h.failures, []);
});

test('account, cache, revision, and reconnection changes reject an old response, including switches back', async () => {
  for (const patch of [{ owner: 'other-account' }, { key: 'other-cache' }, { revision: 6 }, { connectionSequence: 2 }, { localVersion: 3 }]) {
    const h = harness(); const pending = h.controller.refresh(); Object.assign(h.current, patch);
    h.reply.resolve(Response.json(snapshot()));
    assert.equal(await pending, 'skipped'); assert.deepEqual(h.applied, []); assert.deepEqual(h.failures, []);
  }
  const h = harness(); const pending = h.controller.refresh();
  h.current.owner = 'other-account'; h.current.connectionSequence += 1;
  h.current.owner = 'account'; h.current.connectionSequence += 1;
  h.reply.resolve(Response.json(snapshot()));
  assert.equal(await pending, 'skipped'); assert.deepEqual(h.applied, []);
});

test('opening an editor after HTTP completes still protects the screen while JSON is being read', async () => {
  const body = deferred<unknown>();
  const h = harness({ request: async () => ({ ok: true, status: 200, json: () => body.promise }) });
  const pending = h.controller.refresh(); await Promise.resolve(); await Promise.resolve();
  h.current.held = true;
  body.resolve(snapshot());
  assert.equal(await pending, 'skipped'); assert.deepEqual(h.applied, []);
});

test('a stale revision cannot roll the screen backwards and an unchanged revision does not replace data', async () => {
  for (const revision of [4, 5]) {
    const h = harness(); const pending = h.controller.refresh(); h.reply.resolve(Response.json(snapshot(revision)));
    assert.equal(await pending, revision === 4 ? 'stale' : 'unchanged'); assert.deepEqual(h.applied, []);
  }
});

test('invalid remote data is reported without converting the existing list into an empty state', async () => {
  for (const body of [{ ...snapshot(), state: { version: 99, items: [] } }, { ...snapshot(), revision: '6' }, { owner: 'account', revision: 6, state: null }, {}, null]) {
    const h = harness(); const pending = h.controller.refresh(); h.reply.resolve(Response.json(body));
    assert.equal(await pending, 'failed'); assert.deepEqual(h.failures, ['invalid']); assert.deepEqual(h.applied, []);
  }
});

test('authentication changes never expose another account’s snapshot under the previous cache', async () => {
  const h = harness(); const pending = h.controller.refresh(); h.reply.resolve(Response.json(snapshot(6, 'other-account')));
  assert.equal(await pending, 'failed'); assert.deepEqual(h.failures, ['account-changed']); assert.deepEqual(h.applied, []);
  for (const status of [401, 403]) {
    const h = harness(); const pending = h.controller.refresh(); h.reply.resolve(new Response(null, { status }));
    assert.equal(await pending, 'failed'); assert.deepEqual(h.failures, ['signed-out']); assert.deepEqual(h.applied, []);
  }
});

test('unmount cancellation and a late response cannot update the screen or create an error', async () => {
  const h = harness(); const pending = h.controller.refresh();
  h.controller.cancel(); assert.equal(h.signal()!.aborted, true);
  assert.equal(await pending, 'skipped');
  h.reply.resolve(Response.json(snapshot())); await Promise.resolve();
  assert.deepEqual(h.applied, []); assert.deepEqual(h.failures, []);
});

test('a stalled network request times out and releases the controller for a later successful refresh', async () => {
  let attempt = 0;
  const h = harness({ timeoutMs: 5, request: () => ++attempt === 1 ? new Promise(() => {}) : Promise.resolve(Response.json(snapshot())) });
  assert.equal(await h.controller.refresh(), 'failed'); assert.deepEqual(h.failures, ['timeout']); assert.equal(h.signal()!.aborted, true);
  assert.equal(await h.controller.refresh(), 'applied'); assert.equal(h.applied.length, 1);
});

test('another tab’s pending or legacy changes block the request and preserve the exact shared raw cache', async () => {
  for (const flags of [{ dirty: true, legacyDirty: false }, { dirty: false, legacyDirty: true }]) {
    const h = harness();
    const raw = ` \n${JSON.stringify({ state: { ...emptyState(), items: [newItem('別タブの未保存商品')] }, revision: 5, ...flags })}\t`;
    h.caches.set(h.current.key, raw);
    assert.equal(await h.controller.refresh(), 'skipped'); assert.equal(h.requests(), 0);
    assert.deepEqual(h.applied, []); assert.equal(h.caches.get(h.current.key), raw);
  }
});

test('a dirty cache written by another tab during the GET cannot be replaced by the refreshed snapshot', async () => {
  const h = harness(); const pending = h.controller.refresh();
  const raw = JSON.stringify({ state: { ...emptyState(), items: [newItem('別タブで入力中の棚')] }, revision: 5, dirty: true, legacyDirty: false });
  h.caches.set(h.current.key, raw); h.reply.resolve(Response.json(snapshot()));
  assert.equal(await pending, 'skipped'); assert.deepEqual(h.applied, []); assert.deepEqual(h.failures, []);
  assert.equal(h.caches.get(h.current.key), raw);
});

test('malformed cache metadata, broken originals, and inaccessible storage stay untouched before and during refresh', async () => {
  const originals = [' \n{broken cache}\t', JSON.stringify({ state: emptyState(), revision: '5', dirty: false }),
    JSON.stringify({ state: emptyState(), revision: 5, dirty: 'false' }), JSON.stringify({ state: { version: 99, items: [] }, revision: 5, dirty: false })];
  for (const raw of originals) {
    const h = harness(); h.caches.set(h.current.key, raw);
    assert.equal(await h.controller.refresh(), 'skipped'); assert.equal(h.requests(), 0); assert.equal(h.caches.get(h.current.key), raw);
    const pendingHarness = harness(); const pending = pendingHarness.controller.refresh();
    pendingHarness.caches.set(pendingHarness.current.key, raw); pendingHarness.reply.resolve(Response.json(snapshot()));
    assert.equal(await pending, 'skipped'); assert.deepEqual(pendingHarness.applied, []); assert.equal(pendingHarness.caches.get(pendingHarness.current.key), raw);
  }
  const h = harness(); const original = h.caches.get(h.current.key);
  h.storage.getItem = () => { throw new Error('storage read denied'); };
  assert.equal(await h.controller.refresh(), 'skipped'); assert.equal(h.requests(), 0); assert.equal(h.caches.get(h.current.key), original);
  const inaccessible = inspectSharedRefreshCache(() => { throw new Error('storage access denied'); }, h.current.key);
  assert.equal(inaccessible.sharedCacheBlocked, true);
});

test('a clean cache saved by another tab while GET is pending is preserved, then a fresh request catches up', async () => {
  const firstReply = deferred<Pick<Response, 'ok' | 'status' | 'json'>>();
  let requests = 0;
  const h = harness({ request: () => ++requests === 1 ? firstReply.promise : Promise.resolve(Response.json(snapshot(7))) });
  const pending = h.controller.refresh();
  const newerRaw = JSON.stringify({ state: snapshot(7).state, revision: 7, dirty: false, legacyDirty: false });
  h.caches.set(h.current.key, newerRaw); firstReply.resolve(Response.json(snapshot(6)));
  assert.equal(await pending, 'skipped'); assert.equal(h.caches.get(h.current.key), newerRaw); assert.equal(h.applied.length, 0);
  assert.equal(await h.controller.refresh(), 'applied'); assert.equal(h.applied[0].revision, 7);
});

test('a remote revision older than the clean shared cache cannot roll that cache backwards', async () => {
  const h = harness();
  const newerRaw = JSON.stringify({ state: snapshot(7).state, revision: 7, dirty: false, legacyDirty: false });
  h.caches.set(h.current.key, newerRaw);
  const pending = h.controller.refresh(); h.reply.resolve(Response.json(snapshot(6)));
  assert.equal(await pending, 'stale'); assert.deepEqual(h.applied, []); assert.equal(h.caches.get(h.current.key), newerRaw);
});

test('the request boundary is copied even when the caller returns one mutable object', async () => {
  const current = boundary(); const reply = deferred<Pick<Response, 'ok' | 'status' | 'json'>>();
  const applied: RefreshedSnapshot[] = [];
  const controller = createRemoteRefreshController({ boundary: () => current, request: () => reply.promise,
    apply: value => { applied.push(value); }, unchanged: () => {}, unavailable: () => {} });
  const pending = controller.refresh(); current.localVersion += 1;
  reply.resolve(Response.json(snapshot()));
  assert.equal(await pending, 'skipped'); assert.deepEqual(applied, []);
});
