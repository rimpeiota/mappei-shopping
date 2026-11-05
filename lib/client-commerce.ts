export type CommerceStatus = {
  mode: 'review_only';
  connected: boolean;
  importedCount: number;
  reviewCount: number;
  completedCount: 0;
  lastSyncedAt: string | null;
  hasMore: boolean;
  sourceCollectorLastSuccessAt: string | null;
  sourceLimited: boolean;
  authBlocked: boolean;
};

export type CommerceSyncBoundary = {
  owner: string;
  key: string;
  revision: number;
  enabled: boolean;
  dirty: boolean;
  saving: boolean;
  paused: boolean;
  held: boolean;
  storageReadBlocked: boolean;
  upgradeRequired: boolean;
  sharedCacheBlocked: boolean;
  sharedCacheRevision: number;
  online: boolean;
  visible: boolean;
};

/** A review request may only start against the current, clean owner snapshot. */
export function commerceSyncRevision(boundary: CommerceSyncBoundary): number | null {
  if (!boundary.enabled || !boundary.owner || boundary.key !== `mappei-shopping-v1:owner:${boundary.owner}`
    || boundary.dirty || boundary.saving || boundary.paused || boundary.held || boundary.storageReadBlocked
    || boundary.upgradeRequired || boundary.sharedCacheBlocked || !boundary.online || !boundary.visible
    || !Number.isSafeInteger(boundary.revision) || boundary.revision < 0
    || boundary.sharedCacheRevision > boundary.revision) return null;
  return boundary.revision;
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is string | null => value === null
  || (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)));

export function readCommerceStatus(value: unknown): CommerceStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.mode !== 'review_only' || typeof data.connected !== 'boolean'
    || !count(data.importedCount) || !count(data.reviewCount) || data.completedCount !== 0
    || !timestamp(data.lastSyncedAt) || !timestamp(data.sourceCollectorLastSuccessAt)
    || typeof data.hasMore !== 'boolean' || typeof data.sourceLimited !== 'boolean' || typeof data.authBlocked !== 'boolean') return null;
  // Copy only the public status contract; never retain arbitrary provider fields.
  return { mode: 'review_only', connected: data.connected, importedCount: data.importedCount,
    reviewCount: data.reviewCount, completedCount: 0, lastSyncedAt: data.lastSyncedAt, hasMore: data.hasMore,
    sourceCollectorLastSuccessAt: data.sourceCollectorLastSuccessAt, sourceLimited: data.sourceLimited, authBlocked: data.authBlocked };
}

export type CommerceFailure = 'signed-out' | 'conflict' | 'unavailable' | 'invalid';
export class CommerceRequestError extends Error {
  readonly kind: CommerceFailure;
  constructor(kind: CommerceFailure) { super(kind); this.kind = kind; }
}

/** Fixed same-origin endpoints. The browser never supplies an owner or provider URL. */
export async function requestCommerceStatus(signal: AbortSignal, revision?: number,
  request: typeof fetch = fetch): Promise<CommerceStatus> {
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) throw new CommerceRequestError('invalid');
  const response = await request(revision === undefined ? '/api/commerce' : '/api/commerce/sync', {
    method: revision === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', signal,
    ...(revision === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision }) }),
  });
  if (response.status === 401 || response.status === 403) throw new CommerceRequestError('signed-out');
  if (response.status === 409) throw new CommerceRequestError('conflict');
  if (!response.ok) throw new CommerceRequestError('unavailable');
  let value: unknown;
  try { value = await response.json(); } catch { throw new CommerceRequestError('invalid'); }
  const status = readCommerceStatus(value);
  if (!status) throw new CommerceRequestError('invalid');
  return status;
}
