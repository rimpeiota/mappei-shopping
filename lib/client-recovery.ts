import { validateShoppingCache, validateState, type ShoppingState } from './client-model.ts';

const PREFIX = 'mappei-shopping-v1';
const ANONYMOUS = `${PREFIX}:anonymous`;
const LAST_OWNER = `${PREFIX}:last-owner`;
const OWNER_PREFIX = `${PREFIX}:owner:`;
const COMPOSER = ':composer';

/** Deliberately omits all storage mutation methods. */
export interface RecoveryStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}

export type RecoveryEntry = {
  id: string;
  label: string;
  kind: 'snapshot' | 'draft' | 'owner-marker';
  /** These two fields are for a private original-data download, never a UI label. */
  storageKey: string;
  raw: string;
  state: ShoppingState | null;
  revision: number | null;
  dirty: boolean | null;
  format: 'cache' | 'state' | 'text' | 'invalid';
};
export type RecoveryError = { stage: 'length' | 'key' | 'read'; index?: number; label?: string };
export type RecoveryScan = { entries: RecoveryEntry[]; errors: RecoveryError[]; complete: boolean };

type RecognizedKey = { scope: 'legacy' | 'anonymous' | 'owner' | 'marker'; owner?: string; draft: boolean };
const validOwner = (value: string) => value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);

function recognizeKey(key: string): RecognizedKey | null {
  if (key === LAST_OWNER) return { scope: 'marker', draft: false };
  if (key === PREFIX || key === `${PREFIX}${COMPOSER}`) return { scope: 'legacy', draft: key !== PREFIX };
  if (key === ANONYMOUS || key === `${ANONYMOUS}${COMPOSER}`) return { scope: 'anonymous', draft: key !== ANONYMOUS };
  if (!key.startsWith(OWNER_PREFIX)) return null;
  const suffix = key.slice(OWNER_PREFIX.length);
  const draft = suffix.endsWith(COMPOSER) && suffix.length > COMPOSER.length;
  const owner = draft ? suffix.slice(0, -COMPOSER.length) : suffix;
  return validOwner(owner) ? { scope: 'owner', owner, draft } : null;
}

/** Parse only an identified shopping snapshot; a broken envelope is never a direct state. */
function parseSnapshot(raw: string): Pick<RecoveryEntry, 'state' | 'revision' | 'dirty' | 'format'> {
  try {
    const input: unknown = JSON.parse(raw);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('shape');
    if (Object.hasOwn(input, 'state')) {
      const cache = validateShoppingCache(input);
      if (cache) return { state: cache.state, revision: cache.revision, dirty: cache.dirty, format: 'cache' };
    } else if (!['revision', 'dirty', 'legacyDirty'].some(key => Object.hasOwn(input, key))) {
      const state = validateState(input);
      if (state) return { state, revision: null, dirty: null, format: 'state' };
    }
  } catch { /* Preserve the original even when it cannot be interpreted. */ }
  return { state: null, revision: null, dirty: null, format: 'invalid' };
}

/**
 * Copies only this app's known keys. It never connects, persists, migrates, or deletes.
 * Errors are data, so unavailable storage cannot be mistaken for an empty device.
 */
export function scanRecoveryStorage(storage: RecoveryStorage): RecoveryScan {
  const entries: RecoveryEntry[] = [];
  const errors: RecoveryError[] = [];
  // Fixed keys can still be recovered when key enumeration itself is unavailable.
  const candidates = new Set([PREFIX, ANONYMOUS, LAST_OWNER, `${PREFIX}${COMPOSER}`, `${ANONYMOUS}${COMPOSER}`]);
  const enumerated = new Set<string>();
  let length = 0;
  try {
    length = storage.length;
    if (!Number.isSafeInteger(length) || length < 0) { length = 0; errors.push({ stage: 'length' }); }
  } catch { errors.push({ stage: 'length' }); }
  for (let index = 0; index < length; index += 1) {
    try {
      const key = storage.key(index);
      if (key === null) { errors.push({ stage: 'key', index }); continue; }
      if (recognizeKey(key)) { candidates.add(key); enumerated.add(key); }
    } catch { errors.push({ stage: 'key', index }); }
  }
  const owners = new Map<string, number>();
  const labelFor = (recognized: RecognizedKey) => {
    let label: string;
    if (recognized.scope === 'marker') return 'アカウント選択情報';
    if (recognized.scope === 'owner') {
      const owner = recognized.owner!;
      if (!owners.has(owner)) owners.set(owner, owners.size + 1);
      label = `アカウント保存${owners.get(owner)}`;
    } else label = recognized.scope === 'legacy' ? '旧版' : 'ログイン前';
    return recognized.draft ? `${label}・入力下書き` : label;
  };
  for (const storageKey of candidates) {
    const recognized = recognizeKey(storageKey)!;
    const label = labelFor(recognized);
    let raw: string | null;
    try { raw = storage.getItem(storageKey); }
    catch { errors.push({ stage: 'read', label }); continue; }
    if (raw === null) {
      if (enumerated.has(storageKey)) errors.push({ stage: 'read', label });
      continue;
    }
    const kind = recognized.scope === 'marker' ? 'owner-marker' : recognized.draft ? 'draft' : 'snapshot';
    const parsed = kind === 'snapshot' ? parseSnapshot(raw) : { state: null, revision: null, dirty: null, format: 'text' as const };
    entries.push({ id: `saved-${entries.length + 1}`, label, kind, storageKey, raw, ...parsed });
    if (kind === 'owner-marker' && validOwner(raw)) {
      // last-owner supplies a second route to its cache if enumeration partly failed.
      candidates.add(`${OWNER_PREFIX}${raw}`);
      candidates.add(`${OWNER_PREFIX}${raw}${COMPOSER}`);
    }
  }
  return { entries, errors, complete: errors.length === 0 };
}

/** Raw strings survive JSON escaping and can be recovered exactly with JSON.parse. */
export function buildRecoveryBackup(scan: RecoveryScan): string {
  return JSON.stringify({ format: 'mappei-shopping-recovery', version: 1, complete: scan.complete, errors: scan.errors,
    entries: scan.entries.map(({ storageKey, label, kind, raw }) => ({ storageKey, label, kind, raw })) }, null, 2);
}
