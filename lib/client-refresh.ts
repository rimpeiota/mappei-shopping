import { readRemoteSnapshot, validateShoppingCache, type ShoppingState } from './client-model.ts';

export type SharedRefreshCache = { sharedCacheBlocked: boolean; sharedCacheRevision: number; sharedCacheRaw: string | null };

/** Inspect the shared owner cache without repairing or replacing another tab's original. */
export function inspectSharedRefreshCache(storage: () => Pick<Storage, 'getItem'>, key: string): SharedRefreshCache {
  let raw: string | null = null;
  try {
    raw = storage().getItem(key);
    if (raw === null) return { sharedCacheBlocked: false, sharedCacheRevision: 0, sharedCacheRaw: null };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('cache shape');
    const value = parsed as { revision?: unknown; dirty?: unknown; legacyDirty?: unknown };
    if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
      || typeof value.dirty !== 'boolean' || (value.legacyDirty !== undefined && typeof value.legacyDirty !== 'boolean')) throw new Error('cache metadata');
    const cache = validateShoppingCache(parsed);
    if (!cache) throw new Error('unreadable cache');
    return { sharedCacheBlocked: cache.dirty || cache.legacyDirty, sharedCacheRevision: cache.revision, sharedCacheRaw: raw };
  } catch {
    return { sharedCacheBlocked: true, sharedCacheRevision: 0, sharedCacheRaw: raw };
  }
}

export type RefreshBoundary = SharedRefreshCache & {
  owner: string;
  key: string;
  localVersion: number;
  revision: number;
  connectionSequence: number;
  enabled: boolean;
  dirty: boolean;
  saving: boolean;
  paused: boolean;
  held: boolean;
  storageReadBlocked: boolean;
  upgradeRequired: boolean;
  online: boolean;
  visible: boolean;
};
export type RefreshedSnapshot = { owner: string; revision: number; state: ShoppingState };
export type RefreshFailure = 'signed-out' | 'account-changed' | 'invalid' | 'network' | 'timeout';
export type RefreshOutcome = 'skipped' | 'applied' | 'unchanged' | 'stale' | 'failed';
type RefreshOptions = {
  boundary: () => RefreshBoundary;
  request: (signal: AbortSignal) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
  apply: (snapshot: RefreshedSnapshot) => void;
  unchanged: () => void;
  unavailable: (reason: RefreshFailure) => void;
  timeoutMs?: number;
};

const eligible = (state: RefreshBoundary) => state.enabled && !!state.owner && !!state.key
  && !state.dirty && !state.saving && !state.paused && !state.held && !state.storageReadBlocked
  && !state.sharedCacheBlocked && !state.upgradeRequired && state.online && state.visible;
const sameBoundary = (start: RefreshBoundary, current: RefreshBoundary) => eligible(current)
  && current.owner === start.owner && current.key === start.key && current.localVersion === start.localVersion
  && current.revision === start.revision && current.connectionSequence === start.connectionSequence
  && current.sharedCacheRaw === start.sharedCacheRaw;

/** A GET can only replace an unchanged, clean screen. No request ever writes to the server. */
export function createRemoteRefreshController(options: RefreshOptions) {
  let running = false;
  let generation = 0;
  let abortRunning: (() => void) | null = null;
  const cancel = () => { generation += 1; abortRunning?.(); };
  const refresh = async (): Promise<RefreshOutcome> => {
    const start = { ...options.boundary() };
    if (running || !eligible(start)) return 'skipped';
    running = true;
    const requestGeneration = ++generation;
    const controller = new AbortController();
    let timedOut = false;
    let rejectStop: (reason: Error) => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectStop(new Error('refresh timeout'));
    }, options.timeoutMs ?? 15000);
    abortRunning = () => { controller.abort(); rejectStop(new Error('refresh cancelled')); };
    const current = () => requestGeneration === generation && sameBoundary(start, options.boundary());
    const fail = (reason: RefreshFailure): RefreshOutcome => { options.unavailable(reason); return 'failed'; };
    try {
      const response = await Promise.race([options.request(controller.signal), stopped]);
      if (!current()) return 'skipped';
      if (response.status === 401 || response.status === 403) return fail('signed-out');
      if (!response.ok) return fail('network');
      let body: unknown;
      try { body = await Promise.race([response.json() as Promise<unknown>, stopped]); }
      catch { if (!current()) return 'skipped'; return fail(timedOut ? 'timeout' : 'invalid'); }
      if (!current()) return 'skipped';
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid');
      const data = body as { owner?: unknown; revision?: unknown; state?: unknown };
      if (typeof data.owner !== 'string' || !data.owner) return fail('invalid');
      if (data.owner !== start.owner) return fail('account-changed');
      const state = readRemoteSnapshot(data.state, data.revision);
      if (!state) return fail('invalid');
      const revision = data.revision as number;
      if (revision < Math.max(start.revision, start.sharedCacheRevision)) return 'stale';
      if (revision === start.revision) { options.unchanged(); return 'unchanged'; }
      options.apply({ owner: start.owner, revision, state });
      return 'applied';
    } catch {
      if (!current()) return 'skipped';
      return fail(timedOut ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
      running = false;
      abortRunning = null;
    }
  };
  return { refresh, cancel };
}
