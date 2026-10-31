import assert from 'node:assert/strict';
import test from 'node:test';
const { scanRecoveryStorage, buildRecoveryBackup } = await import(new URL('../lib/client-recovery.ts', import.meta.url).href) as typeof import('../lib/client-recovery');
const { emptyState, newItem } = await import(new URL('../lib/client-model.ts', import.meta.url).href) as typeof import('../lib/client-model');
import type { RecoveryStorage } from '../lib/client-recovery';

const PREFIX = 'mappei-shopping-v1';
const cache = (name: string, version = 3) => JSON.stringify({ state: { ...emptyState(), version, items: [newItem(name)] }, revision: 4, dirty: true });
function storage(values: Record<string, string>): RecoveryStorage {
  const keys = Object.keys(values);
  return { length: keys.length, key: index => keys[index] ?? null, getItem: key => values[key] ?? null };
}

test('recovery includes a stranded legacy cache, every account cache, and their unsent drafts', () => {
  const values = {
    [PREFIX]: cache('旧版の棚'),
    [`${PREFIX}:anonymous`]: JSON.stringify({ state: emptyState(), revision: 0, dirty: false }),
    [`${PREFIX}:last-owner`]: 'current-account',
    [`${PREFIX}:owner:current-account`]: cache('今のリスト'),
    [`${PREFIX}:owner:previous-account`]: cache('別の保存に残ったラック'),
    [`${PREFIX}:composer`]: '旧版の未送信メモ',
    [`${PREFIX}:anonymous:composer`]: 'ログイン前の入力',
    [`${PREFIX}:owner:previous-account:composer`]: 'まだ追加していない棚のURL https://example.com/shelf',
  };
  const scan = scanRecoveryStorage(storage(values));
  assert.equal(scan.complete, true); assert.deepEqual(scan.errors, []); assert.equal(scan.entries.length, 8);
  assert.deepEqual(scan.entries.filter(entry => entry.state).flatMap(entry => entry.state!.items.map(item => item.name)), ['旧版の棚', '今のリスト', '別の保存に残ったラック']);
  assert.equal(scan.entries.find(entry => entry.storageKey === PREFIX)!.format, 'cache');
  const previous = scan.entries.find(entry => entry.storageKey === `${PREFIX}:owner:previous-account`)!;
  assert.match(previous.label, /^アカウント保存\d+$/); assert.ok(!previous.label.includes('previous-account'));
  assert.equal(previous.revision, 4); assert.equal(previous.dirty, true);
  assert.equal(scan.entries.filter(entry => entry.kind === 'draft').length, 3);
  for (const entry of scan.entries) assert.equal(entry.raw, values[entry.storageKey as keyof typeof values]);
});

test('invalid originals, whitespace, empty strings and draft text survive the private raw backup exactly', () => {
  const malformed = ' \n{"state":{"version":3,"items":[broken]}\t\r\n';
  const values = { [PREFIX]: malformed, [`${PREFIX}:anonymous`]: '', [`${PREFIX}:anonymous:composer`]: '棚\n"幅80cm"\t\\\u0000' };
  const scan = scanRecoveryStorage(storage(values));
  assert.equal(scan.complete, true); assert.equal(scan.entries.length, 3);
  assert.equal(scan.entries.find(entry => entry.storageKey === PREFIX)!.state, null);
  assert.equal(scan.entries.find(entry => entry.storageKey === PREFIX)!.format, 'invalid');
  const backup = JSON.parse(buildRecoveryBackup(scan)) as { entries: Array<{ storageKey: string; raw: string }>; complete: boolean };
  for (const entry of backup.entries) assert.equal(entry.raw, values[entry.storageKey as keyof typeof values]);
  assert.equal(backup.complete, true);
  assert.ok(!buildRecoveryBackup(scan).includes('"state": null'));
});

test('only exact known shopping namespaces are read; unrelated storage is excluded', () => {
  const unrelated = ['auth-token', 'mappei-shopping-v10', `${PREFIX}:other`, `${PREFIX}-backup`, `${PREFIX}:owner:`, `${PREFIX}:last-owner:composer`, `${PREFIX}:anonymous:extra`, `${PREFIX}:owner:${'x'.repeat(257)}`, `${PREFIX}:owner:bad\nowner`];
  const values = Object.fromEntries(unrelated.map(key => [key, 'private unrelated data']));
  const source = storage(values);
  const read: string[] = [];
  const scan = scanRecoveryStorage({ ...source, getItem: key => { read.push(key); return source.getItem(key); } });
  assert.equal(scan.entries.length, 0); assert.equal(scan.complete, true);
  for (const key of unrelated) assert.ok(!read.includes(key), key);
});

test('one unreadable account does not hide other originals or pretend the scan was complete', () => {
  const source = storage({ [PREFIX]: cache('残す棚'), [`${PREFIX}:owner:blocked`]: cache('読めないラック'), [`${PREFIX}:owner:other`]: cache('読める商品') });
  const scan = scanRecoveryStorage({ ...source, getItem: key => { if (key === `${PREFIX}:owner:blocked`) throw new Error('private owner identifier'); return source.getItem(key); } });
  assert.equal(scan.complete, false); assert.equal(scan.errors.length, 1); assert.equal(scan.errors[0].stage, 'read');
  assert.deepEqual(scan.entries.flatMap(entry => entry.state?.items.map(item => item.name) ?? []), ['残す棚', '読める商品']);
  assert.ok(!JSON.stringify(scan.errors).includes('private owner identifier'));
  assert.ok(!JSON.stringify(scan.errors).includes('blocked'));
  assert.equal(JSON.parse(buildRecoveryBackup(scan)).complete, false);
});

test('enumeration failures retain fixed originals and the last-owner cache without writes', () => {
  const source = storage({ [PREFIX]: cache('旧版の棚'), [`${PREFIX}:last-owner`]: 'retained', [`${PREFIX}:owner:retained`]: cache('選択中の棚') });
  const scan = scanRecoveryStorage({ get length(): number { throw new Error('unavailable'); }, key: source.key, getItem: source.getItem });
  assert.equal(scan.complete, false); assert.deepEqual(scan.errors, [{ stage: 'length' }]);
  assert.deepEqual(scan.entries.flatMap(entry => entry.state?.items.map(item => item.name) ?? []), ['旧版の棚', '選択中の棚']);
  const empty = scanRecoveryStorage({ get length(): number { throw new Error('unavailable'); }, key: () => null, getItem: () => { throw new Error('blocked'); } });
  assert.equal(empty.entries.length, 0); assert.equal(empty.complete, false); assert.ok(empty.errors.length > 0);
});

test('failed individual key enumeration and disappearing values are recorded while later entries survive', () => {
  const source = storage({ [`${PREFIX}:owner:first`]: cache('一つ目'), [`${PREFIX}:owner:second`]: cache('二つ目'), [`${PREFIX}:owner:third`]: cache('三つ目') });
  const scan = scanRecoveryStorage({ ...source,
    key: index => { if (index === 0) throw new Error('key failed'); return source.key(index); },
    getItem: key => key === `${PREFIX}:owner:second` ? null : source.getItem(key),
  });
  assert.equal(scan.complete, false); assert.deepEqual(scan.errors.map(error => error.stage), ['key', 'read']);
  assert.equal(scan.entries[0].state!.items[0].name, '三つ目');
});

test('v1 and v2 caches and direct legacy states can be previewed without changing their raw originals', () => {
  for (const version of [1, 2]) {
    const raw = cache(`版${version}の棚`, version);
    const direct = JSON.stringify({ ...emptyState(), version, items: [newItem(`直接保存${version}`)] });
    const scan = scanRecoveryStorage(storage({ [PREFIX]: raw, [`${PREFIX}:anonymous`]: direct }));
    assert.equal(scan.entries[0].format, 'cache'); assert.equal(scan.entries[0].raw, raw);
    assert.equal(scan.entries[0].state!.version, 3); assert.equal(scan.entries[0].state!.items[0].name, `版${version}の棚`);
    assert.equal(scan.entries[1].format, 'state'); assert.equal(scan.entries[1].raw, direct);
    assert.equal(scan.entries[1].revision, null); assert.equal(scan.entries[1].dirty, null);
  }
});

test('malformed envelopes and unknown state versions are not misidentified as direct shopping states', () => {
  const inputs = [{ ...emptyState(), state: null }, { ...emptyState(), revision: 9 }, { ...emptyState(), dirty: false }, { ...emptyState(), version: 4 }, { unrelated: true }];
  for (const input of inputs) {
    const raw = JSON.stringify(input);
    const entry = scanRecoveryStorage(storage({ [PREFIX]: raw })).entries[0];
    assert.equal(entry.state, null); assert.equal(entry.format, 'invalid'); assert.equal(entry.raw, raw);
  }
});

test('a genuinely empty accessible storage remains distinguishable from an unavailable one', () => {
  const scan = scanRecoveryStorage(storage({}));
  assert.deepEqual(scan, { entries: [], errors: [], complete: true });
});
