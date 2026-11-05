import { applyCommerceEvents, emptyCommerceLedger, type CommerceLedger, type CommerceReview } from './commerce-model.ts';
import { validateState } from './client-model.ts';
import { CommerceError, parseCommercePage, parseReviewCommerceEvent, validCommerceTimestamp, validCursor, type CommercePage, type CommerceStatus } from './commerce-contract.ts';

type ConnectionRow = { ledger_json: string; cursor: number; revision: number; last_operation_id: string; last_synced_at: string;
  has_more: number; source_last_success_at: string | null; source_limited: number; auth_blocked: number; source_error: number };
type SnapshotRow = { state_json: string; revision: number };
const unavailable = () => new CommerceError(503, '通販連携の保存状態を確認できませんでした。買い物の記録は変更していません。');
const conflict = () => new CommerceError(409, 'ほかの画面で記録が更新されました。同期してから、もう一度通知を確認してください。');
const MAX_LEDGER_BYTES = 1024 * 1024;

function readReview(value: unknown): CommerceReview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['eventId', 'code', 'message', 'itemId'].includes(key))
    || typeof row.eventId !== 'string' || row.eventId.length > 256 || typeof row.code !== 'string' || row.code.length > 100
    || typeof row.message !== 'string' || row.message.length > 1000 || (row.itemId !== undefined && (typeof row.itemId !== 'string' || row.itemId.length > 200))) throw unavailable();
  return { eventId: row.eventId, code: row.code, message: row.message, ...(row.itemId ? { itemId: row.itemId as string } : {}) };
}
function readLedger(raw: string, scope: string): CommerceLedger {
  try {
    if (new TextEncoder().encode(raw).byteLength > MAX_LEDGER_BYTES) throw unavailable();
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || Object.keys(value).some(key => !['version', 'accountScope', 'receipts', 'bindings', 'conflicts'].includes(key))
      || value.version !== 1 || value.accountScope !== scope || !Array.isArray(value.receipts) || value.receipts.length > 5000
      || !Array.isArray(value.bindings) || value.bindings.length !== 0 || !Array.isArray(value.conflicts) || value.conflicts.length > 5000) throw unavailable();
    const receipts = value.receipts.map(rawReceipt => {
      if (!rawReceipt || typeof rawReceipt !== 'object' || Array.isArray(rawReceipt)) throw unavailable();
      const receipt = rawReceipt as Record<string, unknown>;
      if (Object.keys(receipt).some(key => !['event', 'outcome', 'review'].includes(key)) || receipt.outcome !== 'review' || !receipt.review) throw unavailable();
      const event = parseReviewCommerceEvent(receipt.event, scope), review = readReview(receipt.review);
      if (review.eventId !== event.id) throw unavailable();
      return { event, outcome: 'review' as const, review };
    });
    if (new Set(receipts.map(row => row.event.id)).size !== receipts.length) throw unavailable();
    return { version: 1, accountScope: scope, receipts, bindings: [], conflicts: value.conflicts.map(readReview) };
  } catch { throw unavailable(); }
}
async function connectionRow(db: D1Database, owner: string, scope: string): Promise<ConnectionRow | null> {
  const row = await db.prepare('SELECT ledger_json, cursor, revision, last_operation_id, last_synced_at, has_more, source_last_success_at, source_limited, auth_blocked, source_error FROM shopping_commerce_connections WHERE user_id = ? AND integration_id = ?').bind(owner, scope).first<ConnectionRow>();
  if (row && (!validCursor(row.cursor) || !validCursor(row.revision) || row.revision === 0 || !validCommerceTimestamp(row.last_synced_at)
    || (row.source_last_success_at !== null && !validCommerceTimestamp(row.source_last_success_at))
    || ![0, 1].includes(row.has_more) || ![0, 1].includes(row.source_limited) || ![0, 1].includes(row.auth_blocked) || ![0, 1].includes(row.source_error))) throw unavailable();
  return row;
}
function status(row: ConnectionRow | null, ledger: CommerceLedger): CommerceStatus {
  return { mode: 'review_only', connected: true, importedCount: ledger.receipts.length,
    reviewCount: new Set([...ledger.receipts.filter(receipt => receipt.outcome === 'review').map(receipt => receipt.event.id), ...ledger.conflicts.map(review => review.eventId)]).size,
    completedCount: 0, lastSyncedAt: row?.last_synced_at ?? null, hasMore: row?.has_more === 1,
    sourceCollectorLastSuccessAt: row?.source_last_success_at ?? null, sourceLimited: row?.source_limited === 1, authBlocked: row?.auth_blocked === 1, sourceError: row?.source_error === 1 };
}
export async function readCommerceStatus(db: D1Database, owner: string, scope: string): Promise<CommerceStatus> {
  const row = await connectionRow(db, owner, scope);
  return status(row, row ? readLedger(row.ledger_json, scope) : emptyCommerceLedger(scope));
}

/**
 * Review-only ingestion. The raw shopping snapshot is never reserialized or rewritten.
 * The connection's ledger, source cursor, status, and operation ID move in one CAS statement,
 * guarded by the shopping revision read before the source request. The transactional proof
 * SELECT is tied to this operation ID, so unrelated saves cannot masquerade as our commit.
 */
export async function syncCommerceNotifications(db: D1Database, owner: string, scope: string, expectedRevision: number,
  fetchPage: (cursor: number) => Promise<CommercePage>, options: { now?: string; operationId?: string } = {}): Promise<CommerceStatus & { revision: number; addedCount: number }> {
  if (!validCursor(expectedRevision)) throw new CommerceError(400, '保存バージョンの形式を確認してください。');
  const [snapshot, row] = await Promise.all([
    db.prepare('SELECT state_json, revision FROM shopping_snapshots WHERE user_id = ?').bind(owner).first<SnapshotRow>(),
    connectionRow(db, owner, scope),
  ]);
  if (!snapshot || snapshot.revision !== expectedRevision) throw conflict();
  let readable: ReturnType<typeof validateState>;
  try { const raw = JSON.parse(snapshot.state_json); readable = raw?.version === 4 ? validateState(raw) : null; } catch { throw unavailable(); }
  if (!readable) throw unavailable();
  const ledger = row ? readLedger(row.ledger_json, scope) : emptyCommerceLedger(scope);
  const previousCursor = row?.cursor ?? 0;
  const page = parseCommercePage(await fetchPage(previousCursor), scope, previousCursor);
  const result = applyCommerceEvents(readable.items, ledger, page.events.map(entry => entry.event));
  // Future verified ingestion needs a separate accounting policy and atomic snapshot writer.
  if (result.items !== readable.items || result.completedItemIds.length || result.ledger.bindings.length) throw unavailable();
  const serialized = JSON.stringify(result.ledger);
  if (result.ledger.receipts.length > 5000 || new TextEncoder().encode(serialized).byteLength > MAX_LEDGER_BYTES) {
    throw new CommerceError(413, '配送通知の保存上限に達しました。買い物の記録は変更していません。');
  }
  const now = options.now ?? new Date().toISOString(), operationId = options.operationId ?? crypto.randomUUID();
  if (!validCommerceTimestamp(now) || !/^[A-Za-z0-9_-]{16,128}$/u.test(operationId)) throw unavailable();
  const values = [serialized, page.cursor, operationId, now, page.hasMore ? 1 : 0, page.collector.last_success_at, page.collector.limited, page.collector.auth_blocked, page.collector.last_error_code ? 1 : 0];
  const mutation = row
    ? db.prepare('UPDATE shopping_commerce_connections SET ledger_json = ?, cursor = ?, revision = revision + 1, last_operation_id = ?, last_synced_at = ?, has_more = ?, source_last_success_at = ?, source_limited = ?, auth_blocked = ?, source_error = ? WHERE user_id = ? AND integration_id = ? AND revision = ? AND cursor = ? AND EXISTS (SELECT 1 FROM shopping_snapshots WHERE user_id = ? AND revision = ?)')
      .bind(...values, owner, scope, row.revision, previousCursor, owner, expectedRevision)
    : db.prepare('INSERT INTO shopping_commerce_connections (user_id, integration_id, ledger_json, cursor, revision, last_operation_id, last_synced_at, has_more, source_last_success_at, source_limited, auth_blocked, source_error) SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM shopping_snapshots WHERE user_id = ? AND revision = ?) ON CONFLICT(user_id, integration_id) DO NOTHING')
      .bind(owner, scope, ...values, owner, expectedRevision);
  const proof = db.prepare('SELECT revision FROM shopping_snapshots WHERE user_id = ? AND revision = ? AND EXISTS (SELECT 1 FROM shopping_commerce_connections WHERE user_id = ? AND integration_id = ? AND revision = ? AND last_operation_id = ?)')
    .bind(owner, expectedRevision, owner, scope, (row?.revision ?? 0) + 1, operationId);
  const committed = await db.batch([mutation, proof]);
  if (committed[0].meta.changes !== 1 || committed[1].results.length !== 1) throw conflict();
  const saved: ConnectionRow = { ledger_json: serialized, cursor: page.cursor, revision: (row?.revision ?? 0) + 1,
    last_operation_id: operationId, last_synced_at: now, has_more: page.hasMore ? 1 : 0,
    source_last_success_at: page.collector.last_success_at, source_limited: page.collector.limited, auth_blocked: page.collector.auth_blocked, source_error: page.collector.last_error_code ? 1 : 0 };
  return { ...status(saved, result.ledger), revision: expectedRevision, addedCount: result.ledger.receipts.length - ledger.receipts.length };
}
