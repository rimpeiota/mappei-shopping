import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const { syncCommerceNotifications, readCommerceStatus } = await import(new URL('../lib/server-commerce-store.ts', import.meta.url).href) as typeof import('../lib/server-commerce-store');
const { emptyState, newItem } = await import(new URL('../lib/client-model.ts', import.meta.url).href) as typeof import('../lib/client-model');
import type { CommercePage } from '../lib/commerce-contract';

// D1's prepared-statement API over real SQLite, including transactional batch rollback.
// SQL is executed unchanged: these tests do not fake matching revisions or mutation results.
class SqliteD1 {
  sqlite = new DatabaseSync(':memory:');
  beforeBatch: (() => void) | null = null;
  failAt = -1;
  constructor() {
    this.sqlite.exec(readFileSync(new URL('../drizzle/0000_massive_mercury.sql', import.meta.url), 'utf8'));
    this.sqlite.exec(readFileSync(new URL('../drizzle/0001_easy_madame_hydra.sql', import.meta.url), 'utf8'));
    this.sqlite.exec(readFileSync(new URL('../drizzle/0002_source_error.sql', import.meta.url), 'utf8'));
  }
  prepare(sql: string) { return new SqliteStatement(this, sql, []); }
  async batch(statements: SqliteStatement[]) {
    this.beforeBatch?.(); this.beforeBatch = null;
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement, index) => {
        if (index === this.failAt) throw new Error('synthetic SQL transaction failure');
        return statement.execute();
      });
      this.sqlite.exec('COMMIT'); return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  asD1() { return this as unknown as D1Database; }
}
class SqliteStatement {
  private db: SqliteD1; private sql: string; private values: (string | number | null)[];
  constructor(db: SqliteD1, sql: string, values: (string | number | null)[]) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values: (string | number | null)[]) { return new SqliteStatement(this.db, this.sql, values); }
  async first<T>() { return (this.db.sqlite.prepare(this.sql).get(...this.values) ?? null) as T | null; }
  execute() {
    const statement = this.db.sqlite.prepare(this.sql);
    if (/^\s*SELECT\b/iu.test(this.sql)) return { success: true, meta: { changes: 0 }, results: statement.all(...this.values) };
    const result = statement.run(...this.values); return { success: true, meta: { changes: Number(result.changes) }, results: [] };
  }
}
const owner = 'synthetic-owner-a', scope = 'synthetic-integration-0001', time = '2026-11-04T12:00:00.000Z';
const event = (id = 'fixture-notice-1') => ({ id: createHash('sha256').update(id).digest('hex'), merchant: 'rakuten' as const, accountScope: scope, kind: 'delivered' as const,
  orderId: null, orderLineId: null, productKey: null, shipmentId: null, quantity: null, unit: null,
  orderedAt: null, deliveredAt: null, explicitConfirmed: false, observedAtISO: time, parserVersion: 1 as const });
const page = (cursor = 0, events = [{ sequence: 1, event: event() }]): CommercePage => ({ integrationId: scope,
  events, cursor: events.at(-1)?.sequence ?? cursor, hasMore: false, collector: { last_success_at: time, last_error_code: null, limited: 1, auth_blocked: 0 } });
function setup() {
  const db = new SqliteD1();
  const raw = JSON.stringify({ ...emptyState(), items: [newItem('合成検証の棚', { id: 'fixture-target', purchaseLater: true, stock: 0, comment: '保持する内容' }),
    newItem('合成検証の在庫', { id: 'fixture-stock', stock: 4, inventoryOnly: true })], customFutureField: { nested: '保存原文をそのまま保持' },
    settings: { ...emptyState().settings, unknownFutureSetting: '保持' } });
  db.sqlite.prepare('INSERT INTO shopping_snapshots(user_id,state_json,revision,updated_at) VALUES(?,?,?,?)').run(owner, raw, 7, time);
  return { db, raw };
}
function snapshot(db: SqliteD1) { return db.sqlite.prepare('SELECT * FROM shopping_snapshots WHERE user_id=?').get(owner); }
function connection(db: SqliteD1) { return db.sqlite.prepare('SELECT * FROM shopping_commerce_connections WHERE user_id=? AND integration_id=?').get(owner, scope); }
const sync = (db: SqliteD1, source: (cursor: number) => Promise<CommercePage> = async cursor => page(cursor), revision = 7) => syncCommerceNotifications(db.asD1(), owner, scope, revision, source, { now: time });

test('review ingestion commits cursor and ledger together without rewriting any snapshot byte or revision', async () => {
  const { db, raw } = setup(); const before = snapshot(db);
  const result = await sync(db);
  assert.equal(result.mode, 'review_only'); assert.equal(result.importedCount, 1); assert.equal(result.reviewCount, 1); assert.equal(result.completedCount, 0);
  assert.equal(result.addedCount, 1); assert.equal(result.revision, 7); assert.equal(result.sourceLimited, true);
  assert.deepEqual(snapshot(db), before); assert.equal(snapshot(db)?.state_json, raw);
  const row = connection(db)!; assert.equal(row.cursor, 1); assert.equal(row.revision, 1);
  const ledger = JSON.parse(row.ledger_json as string); assert.equal(ledger.receipts[0].outcome, 'review'); assert.equal(ledger.bindings.length, 0);
  assert.equal(ledger.receipts[0].event.explicitConfirmed, false);
  assert.deepEqual(await readCommerceStatus(db.asD1(), owner, scope), Object.fromEntries(Object.entries(result).filter(([key]) => !['revision', 'addedCount'].includes(key))));
});

test('unchanged and duplicated notification pages do not add duplicate receipts or complete stock', async () => {
  const { db } = setup(); const before = snapshot(db); await sync(db);
  const result = await sync(db, async cursor => { assert.equal(cursor, 1); return page(cursor, [{ sequence: 2, event: event() }]); });
  assert.equal(result.importedCount, 1); assert.equal(result.addedCount, 0); assert.equal(connection(db)?.cursor, 2);
  const empty = await sync(db, async cursor => page(cursor, [])); assert.equal(empty.addedCount, 0); assert.equal(connection(db)?.cursor, 2);
  assert.deepEqual(snapshot(db), before);
});

test('a stale shopping revision and a missing owner never fetch or import notifications', async () => {
  const { db } = setup(); let fetched = false;
  const source = async () => { fetched = true; return page(); };
  await assert.rejects(sync(db, source, 6), { status: 409 });
  await assert.rejects(syncCommerceNotifications(db.asD1(), 'synthetic-owner-b', scope, 7, source), { status: 409 });
  assert.equal(fetched, false); assert.equal(connection(db), undefined);
});

test('a real concurrent shopping save before CAS is preserved and prevents cursor advancement', async () => {
  const { db } = setup();
  db.beforeBatch = () => { db.sqlite.prepare('UPDATE shopping_snapshots SET state_json=?,revision=revision+1 WHERE user_id=?').run(JSON.stringify({ ...emptyState(), kept: 'concurrent save' }), owner); };
  await assert.rejects(sync(db), { status: 409 });
  assert.equal(snapshot(db)?.revision, 8); assert.equal(JSON.parse(snapshot(db)?.state_json as string).kept, 'concurrent save');
  assert.equal(connection(db), undefined);
});

test('two concurrent first imports execute real unique-key CAS and only one succeeds', async () => {
  const { db } = setup(); let calls = 0; let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const source = async (cursor: number) => { calls += 1; if (calls === 2) release(); await gate; return page(cursor); };
  const results = await Promise.allSettled([sync(db, source), sync(db, source)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  const failure = results.find(row => row.status === 'rejected') as PromiseRejectedResult; assert.equal(failure.reason.status, 409);
  assert.equal(connection(db)?.revision, 1); assert.equal(connection(db)?.cursor, 1); assert.equal(snapshot(db)?.revision, 7);
  assert.equal(JSON.parse(connection(db)?.ledger_json as string).receipts.length, 1);
});

test('two concurrent updates cannot lose an imported page or reuse another operation proof', async () => {
  const { db } = setup(); await sync(db); let calls = 0; let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const source = async (cursor: number) => { calls += 1; if (calls === 2) release(); await gate; return page(cursor, [{ sequence: 2, event: event('fixture-notice-2') }]); };
  const results = await Promise.allSettled([sync(db, source), sync(db, source)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(connection(db)?.revision, 2); assert.equal(connection(db)?.cursor, 2);
  assert.equal(JSON.parse(connection(db)?.ledger_json as string).receipts.length, 2);
});

test('SQLite batch rollback leaves both cursor and ledger unchanged when the proof statement fails', async () => {
  const { db } = setup(); await sync(db); const before = connection(db), beforeSnapshot = snapshot(db); db.failAt = 1;
  await assert.rejects(sync(db, async cursor => page(cursor, [{ sequence: 2, event: event('fixture-notice-2') }])));
  assert.deepEqual(connection(db), before); assert.deepEqual(snapshot(db), beforeSnapshot);
});

test('malformed, cross-scope or claimed verified pages cannot create a ledger or advance its cursor', async () => {
  const { db } = setup(); const before = snapshot(db);
  for (const raw of [page(0, [{ sequence: 1, event: { ...event(), explicitConfirmed: true } }]), { ...page(), cursor: 5 },
    { ...page(), integrationId: 'synthetic-other-integration' }, { ...page(), events: [{ sequence: 1, event: { ...event(), rawBody: 'private' } }] }]) {
    await assert.rejects(sync(db, async () => raw as CommercePage));
    assert.equal(connection(db), undefined); assert.deepEqual(snapshot(db), before);
  }
});

test('status access is owner-isolated and never includes receipt identities, URLs, token or raw mail fields', async () => {
  const { db } = setup(); await sync(db);
  const other = await readCommerceStatus(db.asD1(), 'synthetic-owner-b', scope); assert.equal(other.importedCount, 0); assert.equal(other.lastSyncedAt, null);
  const result = await readCommerceStatus(db.asD1(), owner, scope);
  assert.deepEqual(Object.keys(result).sort(), ['authBlocked', 'completedCount', 'connected', 'hasMore', 'importedCount', 'lastSyncedAt', 'mode', 'reviewCount', 'sourceCollectorLastSuccessAt', 'sourceLimited', 'sourceError'].sort());
  assert.equal(JSON.stringify(result).includes('fixture-notice'), false);
});

test('unreadable shopping snapshots or stored ledgers fail closed before the source request', async () => {
  const { db } = setup(); await sync(db); const before = connection(db); let calls = 0;
  db.sqlite.prepare('UPDATE shopping_commerce_connections SET ledger_json=?').run('{broken');
  await assert.rejects(sync(db, async () => { calls += 1; return page(); })); assert.equal(calls, 0);
  db.sqlite.prepare('UPDATE shopping_commerce_connections SET ledger_json=?').run(before?.ledger_json as string);
  db.sqlite.prepare('UPDATE shopping_snapshots SET state_json=? WHERE user_id=?').run('{broken', owner);
  await assert.rejects(sync(db, async () => { calls += 1; return page(); })); assert.equal(calls, 0);
});

test('source collection failure and auth-block state are preserved as sanitized status flags', async () => {
  const { db } = setup(); const before = snapshot(db);
  const result = await sync(db, async () => ({ ...page(), collector: { last_success_at: null, last_error_code: 'source_error', auth_blocked: 1, limited: 1 } }));
  assert.equal(result.sourceError, true); assert.equal(result.authBlocked, true); assert.equal(result.sourceCollectorLastSuccessAt, null);
  const durable = await readCommerceStatus(db.asD1(), owner, scope); assert.equal(durable.sourceError, true); assert.equal(durable.authBlocked, true);
  assert.deepEqual(snapshot(db), before); assert.equal(connection(db)?.cursor, 1);
});
