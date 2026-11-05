import type { NormalizedCommerceEvent } from './commerce-model.ts';

export type CommerceStatus = {
  mode: 'review_only'; connected: boolean; importedCount: number; reviewCount: number; completedCount: 0;
  lastSyncedAt: string | null; hasMore: boolean; sourceCollectorLastSuccessAt: string | null;
  sourceLimited: boolean; authBlocked: boolean; sourceError: boolean;
};
export type CommercePage = {
  integrationId: string; events: { sequence: number; event: NormalizedCommerceEvent }[]; cursor: number; hasMore: boolean;
  collector: { last_success_at: string | null; last_error_code: 'source_error' | null; auth_blocked: 0 | 1; limited: 0 | 1 };
};
export const disconnectedCommerceStatus = (): CommerceStatus => ({ mode: 'review_only', connected: false, importedCount: 0,
  reviewCount: 0, completedCount: 0, lastSyncedAt: null, hasMore: false, sourceCollectorLastSuccessAt: null, sourceLimited: false, authBlocked: false, sourceError: false });
export class CommerceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const invalid = (): never => { throw new CommerceError(503, '配送通知の形式を確認できなかったため、記録を変更しませんでした。'); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
export const validIntegrationId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(value);
export const validCursor = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function validCommerceTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/u);
  if (!parts) return false;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  return year >= 1970 && month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
    && Number(parts[4]) < 24 && Number(parts[5]) < 60 && Number(parts[6]) < 60
    && Number(parts[7] ?? 0) < 24 && Number(parts[8] ?? 0) < 60 && Number.isFinite(Date.parse(value));
}
const eventKeys = ['id', 'merchant', 'accountScope', 'kind', 'orderId', 'orderLineId', 'productKey', 'shipmentId', 'quantity', 'unit', 'orderedAt', 'deliveredAt', 'explicitConfirmed', 'observedAtISO', 'parserVersion'];

/** Only the prototype's unconfirmed contract is accepted. Sender/diagnostic hints cannot promote a receipt. */
export function parseReviewCommerceEvent(input: unknown, scope: string): NormalizedCommerceEvent {
  if (!record(input) || !keys(input, eventKeys) || eventKeys.some(key => !Object.hasOwn(input, key))) return invalid();
  if (typeof input.id !== 'string' || !/^[a-f0-9]{64}$/u.test(input.id) || input.accountScope !== scope || !['amazon', 'rakuten', 'unknown'].includes(String(input.merchant))
    || !['ordered', 'delivered', 'cancelled', 'returned', 'review'].includes(String(input.kind))
    || input.explicitConfirmed !== false || input.parserVersion !== 1 || !validCommerceTimestamp(input.observedAtISO)) return invalid();
  for (const key of ['orderId', 'orderLineId', 'productKey', 'shipmentId', 'unit'] as const) {
    if (input[key] !== null && !boundedText(input[key], key === 'productKey' ? 2048 : key === 'unit' ? 50 : 256)) return invalid();
  }
  if (input.quantity !== null && (typeof input.quantity !== 'number' || !Number.isSafeInteger(input.quantity) || input.quantity <= 0 || input.quantity > 1e6)) return invalid();
  if ((input.orderedAt !== null && !validCommerceTimestamp(input.orderedAt)) || (input.deliveredAt !== null && !validCommerceTimestamp(input.deliveredAt))) return invalid();
  // Construct the whitelist explicitly so provider-added raw fields can never enter the ledger.
  return { id: input.id, merchant: input.merchant as NormalizedCommerceEvent['merchant'], accountScope: scope,
    kind: input.kind as NormalizedCommerceEvent['kind'], orderId: input.orderId as string | null, orderLineId: input.orderLineId as string | null,
    productKey: input.productKey as string | null, shipmentId: input.shipmentId as string | null, quantity: input.quantity as number | null,
    unit: input.unit as string | null, orderedAt: input.orderedAt as string | null, deliveredAt: input.deliveredAt as string | null,
    explicitConfirmed: false, observedAtISO: input.observedAtISO, parserVersion: 1 };
}

export function parseCommercePage(input: unknown, scope: string, previousCursor: number): CommercePage {
  if (!validIntegrationId(scope) || !validCursor(previousCursor) || !record(input)
    || !keys(input, ['integrationId', 'events', 'cursor', 'hasMore', 'collector']) || input.integrationId !== scope
    || !Array.isArray(input.events) || input.events.length > 100 || !validCursor(input.cursor) || typeof input.hasMore !== 'boolean'
    || !record(input.collector) || !keys(input.collector, ['last_success_at', 'last_error_code', 'auth_blocked', 'limited'])
    || (input.collector.last_success_at !== null && !validCommerceTimestamp(input.collector.last_success_at))
    || (input.collector.last_error_code !== null && !boundedText(input.collector.last_error_code, 100))
    || ![0, 1].includes(input.collector.auth_blocked as number) || ![0, 1].includes(input.collector.limited as number)) return invalid();
  let last = previousCursor;
  const events = input.events.map(raw => {
    if (!record(raw) || !keys(raw, ['sequence', 'event']) || !validCursor(raw.sequence) || raw.sequence <= last) return invalid();
    last = raw.sequence;
    return { sequence: last, event: parseReviewCommerceEvent(raw.event, scope) };
  });
  if (input.cursor !== last || (events.length === 0 && input.hasMore)) return invalid();
  return { integrationId: scope, events, cursor: last, hasMore: input.hasMore,
    collector: { last_success_at: input.collector.last_success_at as string | null, last_error_code: input.collector.last_error_code ? 'source_error' : null,
      auth_blocked: input.collector.auth_blocked as 0 | 1, limited: input.collector.limited as 0 | 1 } };
}
