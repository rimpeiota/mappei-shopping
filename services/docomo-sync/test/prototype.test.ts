import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { ReadOnlyImap, MAX_MAIL_BYTES, parseInternalDate } from '../src/imap.ts';
import { inspectCandidate, normalizeMail } from '../src/event.ts';
import { collect, handleRequest } from '../src/service.ts';

const encode = (text: string) => new TextEncoder().encode(text);
const source = { integrationId: 'test-integration-0001', mailbox: 'INBOX', uidValidity: '42', uid: 7, observedAtISO: '2026-11-01T00:00:00.000Z' };
const mail = (subject: string, from = 'Amazon <shipment-tracking@amazon.co.jp>', body = '確認が必要なテストです') => encode(
  `From: ${from}\r\nTo: private-recipient@example.test\r\nMessage-ID: <synthetic-001@example.test>\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`);

function fakeSocket(onCommand: (command: string, tag: string) => Uint8Array | string, chunkSize = 7) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const commands: string[] = [];
  const send = (value: Uint8Array | string) => {
    const bytes = typeof value === 'string' ? encode(value) : value;
    for (let index = 0; index < bytes.length; index += chunkSize) controller.enqueue(bytes.slice(index, index + chunkSize));
  };
  const readable = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const writable = new WritableStream<Uint8Array>({ write(bytes) {
    const text = new TextDecoder().decode(bytes).trim(); commands.push(text);
    const first = text.indexOf(' '); send(onCommand(text.slice(first + 1), text.slice(0, first)));
  } });
  send('* OK test IMAP ready\r\n');
  return { readable, writable, close: async () => controller.close(), commands };
}
function literalReply(prefix: string, bytes: Uint8Array, suffix: string): Uint8Array {
  const head = encode(`${prefix}{${bytes.length}}\r\n`), tail = encode(suffix), result = new Uint8Array(head.length + bytes.length + tail.length);
  result.set(head); result.set(bytes, head.length); result.set(tail, head.length + bytes.length); return result;
}

test('normalization keeps no raw mail, recipient, subject, or unsafe delivery association', async () => {
  const raw = mail('配達が完了しました', undefined, '住所 private-address-marker\n商品番号 unknown');
  const event = await normalizeMail(raw, source);
  assert.equal(event.kind, 'delivered'); assert.equal(event.explicitConfirmed, false);
  for (const key of ['orderId','orderLineId','shipmentId','productKey','quantity','unit','deliveredAt','orderedAt'] as const) assert.equal(event[key], null);
  const serialized = JSON.stringify(event);
  for (const privateText of ['private-recipient','private-address-marker','shipment-tracking','配達が完了しました','synthetic-001']) assert.ok(!serialized.includes(privateText));
  assert.match(event.id, /^[0-9a-f]{64}$/u);
  assert.equal((await normalizeMail(raw, { ...source, uidValidity: '43', uid: 999 })).id, event.id);
  assert.notEqual((await normalizeMail(raw, { ...source, integrationId: 'other-integration-0002' })).id, event.id);
});

test('sender domains and physical-delivery wording are candidate hints only', async () => {
  assert.deepEqual(await inspectCandidate(mail('ご注文ありがとうございます')), { merchant: 'amazon', candidate: true });
  assert.equal((await inspectCandidate(mail('配達完了', 'fraud@amazon.co.jp.evil.test'))).candidate, false);
  assert.equal((await inspectCandidate(mail('ご注文ありがとうございます', 'shop@rakuten.co.jp'))).merchant, 'rakuten');
  assert.equal((await inspectCandidate(mail('日記', 'friend@example.test'))).candidate, false);
  assert.equal((await normalizeMail(mail('発送しました'), source)).kind, 'review');
  assert.equal((await normalizeMail(mail('配達予定のお知らせ'), source)).kind, 'review');
  assert.equal((await normalizeMail(mail('配達が完了しました'), source, true)).kind, 'review');
});

test('encoded Japanese MIME subjects are decoded without keeping original headers', async () => {
  const subject = Buffer.from('配達が完了しました').toString('base64');
  const event = await normalizeMail(mail(`=?UTF-8?B?${subject}?=`), source);
  assert.equal(event.kind, 'delivered'); assert.equal(event.explicitConfirmed, false);
});

test('read-only IMAP handles fragmented UTF-8 literals and uses EXAMINE and PEEK only', async () => {
  const bytes = mail('配達が完了しました');
  const socket = fakeSocket((command, tag) => {
    if (command.startsWith('LOGIN ')) return `${tag} OK authenticated\r\n`;
    if (command.startsWith('EXAMINE ')) return `* OK [UIDVALIDITY 42] valid\r\n${tag} OK [READ-ONLY] examined\r\n`;
    if (command.startsWith('UID SEARCH ')) return `* SEARCH 6 7 8\r\n${tag} OK searched\r\n`;
    if (command.includes('RFC822.SIZE')) return literalReply(`* 1 FETCH (UID 7 RFC822.SIZE ${bytes.length} INTERNALDATE "1-Nov-2026 09:00:00 +0900" BODY[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID DATE)] `, bytes, `)\r\n${tag} OK fetched\r\n`);
    return literalReply('* 1 FETCH (UID 7 BODY[] ', bytes, `)\r\n${tag} OK fetched\r\n`);
  }, 1);
  const imap = new ReadOnlyImap(socket);
  await imap.login('synthetic-account', 'synthetic-secret');
  assert.equal(await imap.examine('INBOX'), '42');
  assert.deepEqual(await imap.search(new Date('2026-10-02T00:00:00Z'), 6), { uids: [7,8], limited: false });
  assert.deepEqual((await imap.headers(7)).bytes, bytes);
  assert.deepEqual(await imap.body(7), bytes);
  assert.ok(socket.commands.some(command => command.includes('EXAMINE "INBOX"')));
  assert.ok(socket.commands.some(command => command.includes('BODY.PEEK[]')));
  assert.ok(socket.commands.every(command => !/\b(?:SELECT|STORE|COPY|MOVE|EXPUNGE|APPEND|DELETE|CREATE)\b/u.test(command)));
  await imap.close();
});

test('UID batches are ascending and bounded at 100 even when server returns unordered duplicates', async () => {
  const socket = fakeSocket((command, tag) => command.startsWith('LOGIN ') ? `${tag} OK login\r\n`
    : `* SEARCH ${Array.from({ length: 120 }, (_, index) => 120 - index).join(' ')} 2\r\n${tag} OK search\r\n`);
  const imap = new ReadOnlyImap(socket); await imap.login('test', 'test');
  const page = await imap.search(new Date('2026-10-02'), 0);
  assert.equal(page.uids.length, 100); assert.equal(page.limited, true); assert.equal(page.uids[0], 1); assert.equal(page.uids.at(-1), 100);
  await imap.close();
});

test('oversized literals and injection-shaped credentials fail before mail bytes or commands are accepted', async () => {
  const socket = fakeSocket((command, tag) => command.startsWith('LOGIN ') ? `${tag} OK login\r\n` : `* 1 FETCH (UID 7 BODY[] {${MAX_MAIL_BYTES + 1}}\r\n`);
  const imap = new ReadOnlyImap(socket); await imap.login('test', 'test');
  await assert.rejects(() => imap.body(7), /imap_literal_too_large/u); await imap.close();
  const other = fakeSocket((_command, tag) => `${tag} OK login\r\n`);
  const invalid = new ReadOnlyImap(other);
  await assert.rejects(() => invalid.login('account\r\nM9 DELETE INBOX', 'test'), /invalid_configuration/u);
  assert.equal(other.commands.length, 0); await invalid.close();
});

test('authentication failures never include server text or credentials in returned errors', async () => {
  const socket = fakeSocket((_command, tag) => `${tag} NO secret-containing-provider-reply\r\n`);
  const imap = new ReadOnlyImap(socket);
  await assert.rejects(() => imap.login('test', 'test'), { message: 'imap_authentication_failed' }); await imap.close();
});

test('date parsing validates leap days and zones', () => {
  assert.equal(parseInternalDate('1-Nov-2026 09:00:00 +0900'), Date.parse('2026-11-01T00:00:00Z'));
  for (const date of ['29-Feb-2026 00:00:00 +0000','1-Nov-2026 25:00:00 +0000','invalid']) assert.equal(parseInternalDate(date), null);
});

test('unconfigured collection cannot open a mailbox connection', async () => {
  let opened = false;
  assert.equal(await collect({}, () => { opened = true; throw new Error('must not connect'); }), 'not_configured');
  assert.equal(opened, false);
});

test('event endpoint is authenticated, bounded, read-only and does not accept owner selection', async () => {
  const token = 'synthetic-event-token-at-least-32-characters';
  const request = (path: string, method = 'GET', auth = true) => new Request(`https://worker.example${path}`, { method, headers: auth ? { authorization: `Bearer ${token}` } : {} });
  assert.equal((await handleRequest(request('/v1/events', 'GET', false), { EVENT_READ_TOKEN: token })).status, 401);
  assert.equal((await handleRequest(request('/v1/events', 'POST'), { EVENT_READ_TOKEN: token })).status, 405);
  const env = { EVENT_READ_TOKEN: token, INTEGRATION_ID: source.integrationId, DB: {} as D1Database };
  for (const path of ['/v1/events?owner=someone','/v1/events?limit=101','/v1/events?cursor=-1','/v1/events?cursor=9007199254740992']) assert.equal((await handleRequest(request(path), env)).status, 400);
  assert.equal((await handleRequest(request('/health'), {})).status, 200);
  assert.equal((await handleRequest(request('/v1/events'), { EVENT_READ_TOKEN: token })).status, 503);
});

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
    };
    return statement;
  } } as unknown as D1Database;
  return { DB, sqlite };
}

test('one-shot collection requires a separate admin key, POST, and no caller-selected input', async () => {
  const read = 'synthetic-read-token-at-least-32-characters';
  const admin = 'synthetic-collect-token-at-least-32-characters';
  const env = { EVENT_READ_TOKEN: read, COLLECT_TOKEN: admin };
  let opened = 0;
  const open = () => { opened += 1; throw new Error('must remain unconnected'); };
  const call = (method: string, key: string, path = '/v1/collect', body?: string) => handleRequest(new Request(`https://worker.example${path}`, {
    method, headers: { authorization: `Bearer ${key}` }, ...(body === undefined ? {} : { body }),
  }), env, open);
  assert.equal((await call('GET', admin)).status, 405);
  assert.equal((await call('POST', read)).status, 401);
  assert.equal((await call('POST', admin, '/v1/collect?owner=someone')).status, 400);
  assert.equal((await call('POST', admin, '/v1/collect', '{}')).status, 400);
  assert.equal((await call('POST', admin)).status, 503);
  assert.equal((await handleRequest(new Request('https://worker.example/v1/collect', { method: 'POST', headers: { authorization: `Bearer ${read}` } }), { EVENT_READ_TOKEN: read, COLLECT_TOKEN: read }, open)).status, 401);
  assert.equal(opened, 0);
});

test('durable event/read API survives a UIDVALIDITY reset without duplicate or changed first observation', async () => {
  const { DB, sqlite } = memoryDatabase();
  const bytes = mail('配達が完了しました', undefined, 'private-address-marker');
  const env = { DB, INTEGRATION_ID: source.integrationId, DOCOMO_ACCOUNT_ID: 'synthetic-account', DOCOMO_IMAP_PASSWORD: 'synthetic-password', EVENT_READ_TOKEN: 'synthetic-event-token-at-least-32-characters' };
  const open = (validity: number) => new ReadOnlyImap(fakeSocket((command, tag) => {
    if (command.startsWith('LOGIN ')) return `${tag} OK login\r\n`;
    if (command.startsWith('EXAMINE ')) return `* OK [UIDVALIDITY ${validity}] valid\r\n${tag} OK examined\r\n`;
    if (command.startsWith('UID SEARCH ')) return `* SEARCH 7\r\n${tag} OK search\r\n`;
    if (command.includes('RFC822.SIZE')) return literalReply(`* 1 FETCH (UID 7 RFC822.SIZE ${bytes.length} INTERNALDATE "1-Nov-2026 09:00:00 +0900" BODY[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID DATE)] `, bytes, `)\r\n${tag} OK fetch\r\n`);
    return literalReply('* 1 FETCH (UID 7 BODY[] ', bytes, `)\r\n${tag} OK fetch\r\n`);
  }));
  const now = Date.parse(source.observedAtISO);
  assert.equal(await collect(env, () => open(42), now), 'success');
  const first = sqlite.prepare('SELECT payload FROM commerce_events').get()!.payload;
  assert.equal(await collect(env, () => open(43), now + 60000), 'success');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM commerce_events').get()!.n, 1);
  assert.equal(sqlite.prepare('SELECT payload FROM commerce_events').get()!.payload, first);
  assert.ok(!String(first).includes('private-address-marker'));
  const response = await handleRequest(new Request('https://worker.example/v1/events?cursor=0&limit=1', { headers: { authorization: `Bearer ${env.EVENT_READ_TOKEN}` } }), env);
  const saved = await response.json();
  assert.equal(saved.events.length, 1); assert.equal(saved.events[0].event.explicitConfirmed, false); assert.equal(saved.cursor, 1); assert.equal(saved.hasMore, false);
  sqlite.close();
});

test('the separate admin endpoint can verify one read-only collection before any cron exists', async () => {
  const { DB, sqlite } = memoryDatabase();
  const env = { DB, INTEGRATION_ID: source.integrationId, DOCOMO_ACCOUNT_ID: 'synthetic-account', DOCOMO_IMAP_PASSWORD: 'synthetic-password',
    EVENT_READ_TOKEN: 'synthetic-event-token-at-least-32-characters', COLLECT_TOKEN: 'synthetic-admin-token-at-least-32-characters' };
  let connections = 0;
  const result = await handleRequest(new Request('https://worker.example/v1/collect', { method: 'POST', headers: { authorization: `Bearer ${env.COLLECT_TOKEN}` } }), env, () => {
    connections += 1;
    return new ReadOnlyImap(fakeSocket((command, tag) => {
      if (command.startsWith('LOGIN ')) return `${tag} OK login\r\n`;
      if (command.startsWith('EXAMINE ')) return `* OK [UIDVALIDITY 42] valid\r\n${tag} OK examined\r\n`;
      return `* SEARCH\r\n${tag} OK searched\r\n`;
    }));
  });
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { result: 'success' }); assert.equal(connections, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM commerce_events').get()!.n, 0);
  assert.equal(sqlite.prepare('SELECT lease_until FROM collector_state').get()!.lease_until, 0);
  sqlite.close();
});

test('empty POST streams are accepted without accepting caller input or starting more than one collection', async () => {
  const { DB, sqlite } = memoryDatabase();
  const env = { DB, INTEGRATION_ID: source.integrationId, DOCOMO_ACCOUNT_ID: 'synthetic-account', DOCOMO_IMAP_PASSWORD: 'synthetic-password',
    EVENT_READ_TOKEN: 'synthetic-event-token-at-least-32-characters', COLLECT_TOKEN: 'synthetic-admin-token-at-least-32-characters' };
  let connections = 0;
  const open = () => {
    connections += 1;
    return new ReadOnlyImap(fakeSocket((command, tag) => {
      if (command.startsWith('LOGIN ')) return `${tag} OK login\r\n`;
      if (command.startsWith('EXAMINE ')) return `* OK [UIDVALIDITY 42] valid\r\n${tag} OK examined\r\n`;
      return `* SEARCH\r\n${tag} OK searched\r\n`;
    }));
  };
  for (const body of [new Uint8Array(0), new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } })]) {
    const request = new Request('https://worker.example/v1/collect', { method: 'POST', headers: {
      authorization: `Bearer ${env.COLLECT_TOKEN}`, 'content-length': '0',
    }, body, duplex: 'half' } as RequestInit);
    assert.notEqual(request.body, null);
    const result = await handleRequest(request, env, open);
    assert.equal(result.status, 200); assert.deepEqual(await result.json(), { result: 'success' });
  }
  assert.equal(connections, 2);
  sqlite.close();
});

test('nonempty, errored, nonterminal, and stalled POST bodies are rejected before mailbox access', async () => {
  const { DB, sqlite } = memoryDatabase();
  const env = { DB, INTEGRATION_ID: source.integrationId, DOCOMO_ACCOUNT_ID: 'synthetic-account', DOCOMO_IMAP_PASSWORD: 'synthetic-password',
    EVENT_READ_TOKEN: 'synthetic-event-token-at-least-32-characters', COLLECT_TOKEN: 'synthetic-admin-token-at-least-32-characters' };
  let connections = 0, cancelled = 0;
  const bodies: { body?: BodyInit; length?: string }[] = [
    { body: 'private-body-marker' },
    { length: '1' },
    { length: 'invalid' },
    { body: new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('private-stream-error')); } }) },
    { body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(0)); }, cancel() { cancelled += 1; } }) },
    { body: new ReadableStream<Uint8Array>({ cancel() { cancelled += 1; } }) },
  ];
  for (const { body, length } of bodies) {
    const request = new Request('https://worker.example/v1/collect', { method: 'POST', headers: {
      authorization: `Bearer ${env.COLLECT_TOKEN}`, ...(length === undefined ? {} : { 'content-length': length }),
    }, ...(body === undefined ? {} : { body, duplex: 'half' }) } as RequestInit);
    const result = await handleRequest(request, env, () => { connections += 1; throw new Error('must not connect'); });
    assert.equal(result.status, 400); assert.deepEqual(await result.json(), { error: 'invalid_query' });
  }
  assert.equal(connections, 0); assert.equal(cancelled, 2);
  assert.equal(sqlite.prepare('SELECT last_success_at FROM collector_state').get()!.last_success_at, null);
  sqlite.close();
});

test('one authentication failure blocks further unattended login attempts and retains only an error code', async () => {
  const { DB, sqlite } = memoryDatabase();
  const env = { DB, INTEGRATION_ID: source.integrationId, DOCOMO_ACCOUNT_ID: 'synthetic-account', DOCOMO_IMAP_PASSWORD: 'synthetic-password', EVENT_READ_TOKEN: 'synthetic-event-token-at-least-32-characters' };
  let attempts = 0;
  const open = () => { attempts += 1; return new ReadOnlyImap(fakeSocket((_command, tag) => `${tag} NO private-provider-reply\r\n`)); };
  assert.equal(await collect(env, open), 'imap_authentication_failed');
  assert.equal(await collect(env, open), 'authentication_blocked'); assert.equal(attempts, 1);
  const state = sqlite.prepare('SELECT last_error_code, auth_blocked, lease_until FROM collector_state').get()!;
  assert.equal(state.last_error_code, 'imap_authentication_failed'); assert.equal(state.auth_blocked, 1); assert.equal(state.lease_until, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM commerce_events').get()!.n, 0);
  sqlite.close();
});

test('a collection with a stale pre-lease read cannot log in after another collection blocks authentication', async () => {
  const { DB, sqlite } = memoryDatabase();
  let releaseSecond!: () => void;
  const secondLease = new Promise<void>(resolve => { releaseSecond = resolve; });
  let leases = 0, attempts = 0;
  const delayedDB = { prepare(sql: string) {
    const statement = DB.prepare(sql);
    const wrapped = {
      bind(...values: unknown[]) { statement.bind(...values); return wrapped; },
      first: statement.first.bind(statement), all: statement.all.bind(statement),
      async run() {
        if (sql.startsWith('UPDATE collector_state SET lease_until = ? WHERE') && ++leases === 2) await secondLease;
        return statement.run();
      },
    };
    return wrapped;
  } } as unknown as D1Database;
  const env = { DB: delayedDB, INTEGRATION_ID: source.integrationId, DOCOMO_ACCOUNT_ID: 'synthetic-account', DOCOMO_IMAP_PASSWORD: 'synthetic-password', EVENT_READ_TOKEN: 'synthetic-event-token-at-least-32-characters' };
  const open = () => { attempts += 1; return new ReadOnlyImap(fakeSocket((_command, tag) => `${tag} NO private-provider-reply\r\n`)); };
  const first = collect(env, open), second = collect(env, open);
  assert.equal(await first, 'imap_authentication_failed');
  releaseSecond();
  assert.equal(await second, 'authentication_blocked'); assert.equal(attempts, 1);
  assert.equal(sqlite.prepare('SELECT auth_blocked FROM collector_state').get()!.auth_blocked, 1);
  sqlite.close();
});
