import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { ReadOnlyImap } from '../src/imap.ts';
import { probeMailbox, readProbeInput } from '../src/diagnostics.ts';
import { handleRequest } from '../src/service.ts';
import { digestKey } from '../src/event.ts';

const encode = (text: string) => new TextEncoder().encode(text);
const now = Date.parse('2026-11-03T10:00:00Z');
const valid = { keyword: 'test-product', since: '2026-11-01', beforeUid: 0, trackingDigests: [] };
const read = 'synthetic-read-token-at-least-32-characters';
const admin = 'synthetic-admin-token-at-least-32-characters';
function request(value: unknown, token = admin, path = '/v1/probe') {
  return new Request('https://worker.example' + path, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(value) });
}
function memoryDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const DB = { prepare(sql: string) {
    let values: (string | number)[] = [];
    const statement = {
      bind(...args: (string | number)[]) { values = args; return statement; },
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...values), success: true }; },
      async run() { const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
    }; return statement;
  } } as unknown as D1Database;
  return { DB, sqlite };
}
function fakeSocket(reply: (command: string, tag: string) => string | Uint8Array) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const commands: string[] = [];
  const readable = new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(encode('* OK synthetic ready\r\n')); } });
  const writable = new WritableStream<Uint8Array>({ write(bytes) {
    const text = new TextDecoder().decode(bytes).trim(); const at = text.indexOf(' ');
    commands.push(text); const response = reply(text.slice(at + 1), text.slice(0, at));
    controller.enqueue(typeof response === 'string' ? encode(response) : response);
  } });
  return { readable, writable, commands, close: async () => controller.close() };
}
function literal(prefix: string, body: Uint8Array, tag: string) {
  const head = encode(prefix + `{${body.length}}\r\n`), tail = encode(`)\r\n${tag} OK done\r\n`);
  const joined = new Uint8Array(head.length + body.length + tail.length);
  joined.set(head); joined.set(body, head.length); joined.set(tail, head.length + body.length); return joined;
}

test('probe accepts a short data keyword and recent calendar date, rejects source selection, controls and oversized input', async () => {
  assert.deepEqual(await readProbeInput(request(valid), now), valid);
  for (const value of [null, [], { ...valid, owner: 'someone' }, { ...valid, mailbox: 'Sent' }, { ...valid, url: 'https://evil.test' },
    { ...valid, keyword: 'x' }, { ...valid, keyword: '!!' }, { ...valid, keyword: 'a\r\nLOGIN x' }, { ...valid, keyword: 'x'.repeat(3000) },
    { ...valid, since: '2026-10-01' }, { ...valid, since: '2026-11-04' }, { ...valid, since: '2026-02-30' },
    { ...valid, beforeUid: -1 }, { ...valid, beforeUid: 4294967296 },
    { ...valid, trackingDigests: ['raw-private-tracking'] }, { ...valid, trackingDigests: Array(6).fill('a'.repeat(64)) }]) {
    assert.equal(await readProbeInput(request(value), now), null);
  }
});

test('admin-only probe rejects event-read keys and arbitrary queries before any mailbox connection', async () => {
  const env = { EVENT_READ_TOKEN: read, COLLECT_TOKEN: admin };
  let opened = false; const open = () => { opened = true; throw new Error('must not connect'); };
  assert.equal((await handleRequest(request(valid, read), env, open)).status, 401);
  assert.equal((await handleRequest(request(valid, admin, '/v1/probe?owner=someone'), env, open)).status, 400);
  assert.equal((await handleRequest(new Request('https://worker.example/v1/probe'), env, open)).status, 405);
  assert.equal(opened, false);
});

test('recent search pages newest-first and filters provider duplicates, out-of-range UIDs and stale boundary values', async () => {
  const socket = fakeSocket((command, tag) => command.startsWith('LOGIN ') ? `${tag} OK login\r\n`
    : `* SEARCH 7 4 6 7 0 4294967296 9\r\n${tag} OK search\r\n`);
  const imap = new ReadOnlyImap(socket); await imap.login('synthetic-account', 'synthetic-password');
  assert.deepEqual(await imap.searchRecent(new Date('2026-11-01T00:00:00Z'), 9), { uids: [7,6,4], limited: false });
  assert.match(socket.commands.at(-1)!, /UID SEARCH SINCE 1-Nov-2026 UID 1:8$/u);
  assert.deepEqual(await imap.searchRecent(new Date('2026-11-01T00:00:00Z'), 1), { uids: [], limited: false });
  await assert.rejects(() => imap.searchRecent(new Date(NaN)), /invalid_cursor/u); await imap.close();
});

test('probe emits only keyword evidence and keeps durable collection cursors, events and mail unchanged', async () => {
  const { DB, sqlite } = memoryDatabase();
  sqlite.prepare('UPDATE collector_state SET uid_validity = ?, last_uid = ?, last_success_at = ?, limited = 1').run('old-validity', 123, 'old-success');
  const before = sqlite.prepare('SELECT * FROM collector_state').get();
  const env = { DB, INTEGRATION_ID: 'synthetic-integration-0001', DOCOMO_ACCOUNT_ID: 'synthetic-account', DOCOMO_IMAP_PASSWORD: 'synthetic-password', EVENT_READ_TOKEN: read, COLLECT_TOKEN: admin };
  const mail = encode('From: synthetic-shop@rakuten.co.jp\r\nTo: private-recipient@example.test\r\nSubject: delivery confirmation test-product\r\nMessage-ID: <private-message-marker@example.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nprivate-address-marker test-product');
  const socket = fakeSocket((command, tag) => {
    if (command.startsWith('LOGIN ')) return `${tag} OK login\r\n`;
    if (command.startsWith('EXAMINE ')) return `* OK [UIDVALIDITY 999] valid\r\n${tag} OK examined\r\n`;
    if (command.startsWith('UID SEARCH ')) return `* SEARCH 7\r\n${tag} OK searched\r\n`;
    if (command.includes('RFC822.SIZE')) return literal(`* 1 FETCH (UID 7 RFC822.SIZE ${mail.length} INTERNALDATE "3-Nov-2026 18:00:00 +0900" BODY[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID DATE)] `, mail, tag);
    return literal('* 1 FETCH (UID 7 BODY[] ', mail, tag);
  });
  const result = await probeMailbox(env, valid, () => new ReadOnlyImap(socket), now);
  assert.equal(result.result, 'success'); assert.equal(result.matches?.length, 1); assert.equal(result.matches?.[0].confirmed, false);
  assert.deepEqual(sqlite.prepare('SELECT * FROM collector_state').get(), before);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM commerce_events').get()!.n, 0);
  for (const marker of ['private-recipient', 'private-message-marker', 'private-address-marker', 'synthetic-shop@', 'test-product']) assert.ok(!JSON.stringify(result).includes(marker));
  assert.ok(socket.commands.every(command => !/\b(?:SELECT|STORE|COPY|MOVE|EXPUNGE|APPEND|DELETE|CREATE)\b/u.test(command)));
  sqlite.close();
});

test('probe authentication failure stops the next attempt without advancing a collection cursor', async () => {
  const { DB, sqlite } = memoryDatabase(); let attempts = 0;
  const env = { DB, INTEGRATION_ID: 'synthetic-integration-0001', DOCOMO_ACCOUNT_ID: 'synthetic-account', DOCOMO_IMAP_PASSWORD: 'synthetic-password', EVENT_READ_TOKEN: read, COLLECT_TOKEN: admin };
  const open = () => { attempts++; return new ReadOnlyImap(fakeSocket((_command, tag) => `${tag} NO private-provider-reply\r\n`)); };
  assert.equal((await probeMailbox(env, valid, open, now)).result, 'imap_authentication_failed');
  assert.equal((await probeMailbox(env, valid, open, now)).result, 'authentication_blocked'); assert.equal(attempts, 1);
  const row = sqlite.prepare('SELECT * FROM collector_state').get()!;
  assert.equal(row.last_uid, 0); assert.equal(row.lease_until, 0); assert.equal(row.auth_blocked, 1);
  assert.ok(!JSON.stringify(row).includes('private-provider-reply')); sqlite.close();
});

test('a delivery without the product name is returned only when its tracking digest was already supplied', async () => {
  const { DB, sqlite } = memoryDatabase();
  const integrationId = 'synthetic-integration-0001';
  const env = { DB, INTEGRATION_ID: integrationId, DOCOMO_ACCOUNT_ID: 'synthetic-account', DOCOMO_IMAP_PASSWORD: 'synthetic-password', EVENT_READ_TOKEN: read, COLLECT_TOKEN: admin };
  const mail = encode('From: notice@kuronekoyamato.co.jp\r\nSubject: delivery confirmation\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n追跡番号: 1234-5678-9012\n配達が完了しました。');
  const open = () => new ReadOnlyImap(fakeSocket((command, tag) => {
    if (command.startsWith('LOGIN ')) return `${tag} OK login\r\n`;
    if (command.startsWith('EXAMINE ')) return `* OK [UIDVALIDITY 999] valid\r\n${tag} OK examined\r\n`;
    if (command.startsWith('UID SEARCH ')) return `* SEARCH 7\r\n${tag} OK searched\r\n`;
    if (command.includes('RFC822.SIZE')) return literal(`* 1 FETCH (UID 7 RFC822.SIZE ${mail.length} INTERNALDATE "3-Nov-2026 18:00:00 +0900" BODY[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID DATE)] `, mail, tag);
    return literal('* 1 FETCH (UID 7 BODY[] ', mail, tag);
  }));
  const hidden = await probeMailbox(env, valid, open, now);
  assert.equal(hidden.matches?.length, 0);
  const trackingDigest = await digestKey(integrationId + '\nprobe-tracking:123456789012');
  const matched = await probeMailbox(env, { ...valid, trackingDigests: [trackingDigest] }, open, now);
  assert.equal(matched.matches?.length, 1); assert.equal(matched.matches?.[0].keywordMentioned, false);
  assert.equal(matched.matches?.[0].kindHint, 'delivered'); assert.equal(matched.matches?.[0].confirmed, false);
  assert.ok(!JSON.stringify(matched).includes('1234-5678-9012')); sqlite.close();
});
