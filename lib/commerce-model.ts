import { COMPLETE, safeUrl, type ShoppingItem } from './client-model.ts';
import { plannedProductKey } from './client-plans.ts';

/** Unknown email fields stay null. A delivery quantity is for this shipment, never an inferred total. */
export type NormalizedCommerceEvent = {
  id: string;
  merchant: 'amazon' | 'rakuten' | 'unknown';
  accountScope: string;
  kind: 'ordered' | 'delivered' | 'cancelled' | 'returned' | 'review';
  orderId: string | null;
  orderLineId: string | null;
  productKey: string | null;
  shipmentId: string | null;
  quantity: number | null;
  unit: string | null;
  orderedAt: string | null;
  deliveredAt: string | null;
  explicitConfirmed: boolean;
  observedAtISO: string;
  parserVersion: 1;
};
export type CommerceReview = { eventId: string; code: string; message: string; itemId?: string };
export type CommerceReceipt = {
  event: NormalizedCommerceEvent;
  outcome: 'pending' | 'bound' | 'partial' | 'completed' | 'duplicate' | 'review';
  review?: CommerceReview;
};
export type CommerceBinding = {
  key: string;
  merchant: 'amazon' | 'rakuten';
  orderId: string;
  orderLineId: string;
  productKey: string;
  quantity: number;
  unit: string;
  orderedAt: string;
  itemId: string;
  itemSnapshot: string;
  state: 'waiting' | 'partial' | 'completed' | 'review';
  shipments: { id: string; quantity: number; deliveredAt: string; eventId: string }[];
  completedAt: string | null;
};
export type CommerceLedger = {
  version: 1;
  accountScope: string;
  receipts: CommerceReceipt[];
  bindings: CommerceBinding[];
  conflicts: CommerceReview[];
};
export type CommerceProjection = { items: ShoppingItem[]; ledger: CommerceLedger; reviews: CommerceReview[]; completedItemIds: string[] };

export const emptyCommerceLedger = (accountScope: string): CommerceLedger => ({ version: 1, accountScope, receipts: [], bindings: [], conflicts: [] });
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2000;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 1e6;
function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
const bindingKey = (event: NormalizedCommerceEvent) => JSON.stringify([event.accountScope, event.merchant, event.orderId, event.orderLineId]);
const eventContent = (event: NormalizedCommerceEvent) => JSON.stringify([event.merchant, event.accountScope, event.kind,
  event.orderId, event.orderLineId, event.productKey, event.shipmentId, event.quantity, event.unit, event.orderedAt,
  event.deliveredAt, event.explicitConfirmed, event.parserVersion]);
const itemSnapshot = (item: ShoppingItem) => JSON.stringify([item.id, item.url, item.quantity, item.unit, item.status,
  item.purchaseLater, item.inventoryOnly, item.stock, item.spare, item.stockKnown, item.checkedAt, item.purchasedQuantity,
  item.purchasedAt, item.stockReconciledQuantity, item.updatedAt]);

/** Amazon ASINs include their market. Rakuten URLs retain query variants; names never identify a product. */
export function commerceProductKey(url: string, merchant: NormalizedCommerceEvent['merchant']): string | null {
  const safe = safeUrl(url);
  if (!safe || !safe.startsWith('https:')) return null;
  if (merchant === 'amazon') {
    const key = plannedProductKey(safe);
    return /^amazon:[a-z0-9.]+:[A-Z0-9]{10}$/u.test(key) ? key : null;
  }
  if (merchant === 'rakuten') {
    const parsed = new URL(safe);
    if (parsed.hostname !== 'item.rakuten.co.jp' || parsed.pathname.split('/').filter(Boolean).length !== 2) return null;
    parsed.hash = ''; parsed.pathname = `${parsed.pathname.replace(/\/+$/u, '')}/`; parsed.searchParams.sort();
    return `rakuten:${parsed.toString()}`;
  }
  return null;
}

function unreceivedCandidate(item: ShoppingItem): boolean {
  return !item.inventoryOnly && !COMPLETE.includes(item.status) && item.stock === 0 && item.spare === 0
    && item.purchasedQuantity === 0 && !item.purchasedAt && !item.checkedAt && item.stockReconciledQuantity === 0;
}

/**
 * Pure projection only. The caller must atomically save the returned snapshot and ledger.
 * Receipt IDs handle repeated email collection; shipment IDs handle distinct duplicate notifications.
 */
export function applyCommerceEvents(items: ShoppingItem[], ledger: CommerceLedger, events: readonly NormalizedCommerceEvent[]): CommerceProjection {
  const next = structuredClone(ledger);
  let nextItems = items;
  const completedItemIds: string[] = [];
  const review = (receipt: CommerceReceipt, code: string, message: string, pending = false, itemId?: string) => {
    receipt.outcome = pending ? 'pending' : 'review';
    receipt.review = { eventId: receipt.event.id, code, message, ...(itemId ? { itemId } : {}) };
  };
  for (const event of events) {
    if (!text(event.id) || event.accountScope !== ledger.accountScope) {
      const code = event.accountScope !== ledger.accountScope ? 'account-mismatch' : 'invalid-event-id';
      if (!next.conflicts.some(row => row.eventId === event.id && row.code === code)) next.conflicts.push({ eventId: text(event.id) ? event.id : '', code, message: '接続先と通知の識別情報を確認してください。' });
      continue;
    }
    const known = next.receipts.find(row => row.event.id === event.id);
    if (known) {
      if (eventContent(known.event) !== eventContent(event) && !next.conflicts.some(row => row.eventId === event.id && row.code === 'event-content-changed')) {
        next.conflicts.push({ eventId: event.id, code: 'event-content-changed', message: '同じ通知IDの内容が変わったため自動反映しません。' });
        for (const binding of next.bindings.filter(row => row.key === bindingKey(known.event) || row.key === bindingKey(event))) binding.state = 'review';
      }
      continue;
    }
    next.receipts.push({ event: structuredClone(event), outcome: 'pending' });
  }
  const pending = next.receipts.filter(receipt => receipt.outcome === 'pending');
  const eligible = (receipt: CommerceReceipt) => {
    const event = receipt.event;
    if (next.conflicts.some(row => row.eventId === event.id)) {
      review(receipt, 'event-content-changed', '通知IDの内容に矛盾があるため自動反映しません。'); return false;
    }
    if (event.explicitConfirmed !== true || event.merchant === 'unknown' || event.kind === 'review' || event.parserVersion !== 1) {
      review(receipt, 'unconfirmed-source', '通知内容が未確認のため購入完了にしません。'); return false;
    }
    if (!timestamp(event.observedAtISO) || !text(event.orderId) || !text(event.orderLineId)) {
      review(receipt, 'missing-order-identity', '注文と商品行を特定できないため確認が必要です。'); return false;
    }
    return true;
  };
  // Bind from order confirmations first, including when delivery messages arrived in an earlier collection.
  for (const receipt of pending.filter(row => row.event.kind === 'ordered')) {
    if (!eligible(receipt)) continue;
    const event = receipt.event;
    const orderedAt = timestamp(event.orderedAt);
    if (!orderedAt || orderedAt > timestamp(event.observedAtISO)! || !text(event.productKey) || !count(event.quantity) || !text(event.unit)) {
      review(receipt, 'uncertain-order-details', '注文日時・商品・数量・単位が確定していません。'); continue;
    }
    const key = bindingKey(event);
    const existing = next.bindings.find(binding => binding.key === key);
    if (existing) {
      if (existing.productKey === event.productKey && existing.quantity === event.quantity && existing.unit === event.unit && existing.orderedAt === orderedAt) receipt.outcome = 'duplicate';
      else { existing.state = 'review'; review(receipt, 'order-content-changed', '同じ注文行の数量や商品が変わったため確認が必要です。', false, existing.itemId); }
      continue;
    }
    const matching = nextItems.filter(item => commerceProductKey(item.url, event.merchant) === event.productKey);
    const candidates = matching.filter(item => unreceivedCandidate(item) && item.quantity === event.quantity && item.unit === event.unit
      && !!timestamp(item.createdAt) && timestamp(item.createdAt)! <= orderedAt
      && !next.bindings.some(binding => binding.itemId === item.id)
      && !(event.merchant === 'rakuten' && (item.color.trim() || item.size.trim())));
    if (candidates.length !== 1) {
      const reserved = next.bindings.filter(binding => binding.productKey === event.productKey && binding.state !== 'completed'
        && matching.some(item => item.id === binding.itemId));
      for (const binding of reserved) binding.state = 'review';
      review(receipt, candidates.length > 1 ? 'ambiguous-item' : 'no-safe-item', candidates.length > 1
        ? '同じ商品候補が複数あるため、注文と対応する商品を確認してください。' : '注文前の未購入商品と数量・単位を安全に対応付けできません。'); continue;
    }
    const item = candidates[0];
    next.bindings.push({ key, merchant: event.merchant as 'amazon' | 'rakuten', orderId: event.orderId!, orderLineId: event.orderLineId!,
      productKey: event.productKey, quantity: event.quantity, unit: event.unit, orderedAt, itemId: item.id,
      itemSnapshot: itemSnapshot(item), state: 'waiting', shipments: [], completedAt: null });
    receipt.outcome = 'bound'; delete receipt.review;
  }
  // A cancellation/return is never a reason to subtract guessed stock or to complete a partial order.
  for (const receipt of pending.filter(row => row.event.kind === 'cancelled' || row.event.kind === 'returned')) {
    if (!eligible(receipt)) continue;
    const binding = next.bindings.find(row => row.key === bindingKey(receipt.event));
    if (binding) binding.state = 'review';
    review(receipt, 'cancel-or-return', '取消・返品があるため注文と現在量を確認してください。', !binding, binding?.itemId);
  }
  for (const receipt of pending.filter(row => row.event.kind === 'delivered')) {
    if (!eligible(receipt)) continue;
    const event = receipt.event;
    const binding = next.bindings.find(row => row.key === bindingKey(event));
    if (!binding) { review(receipt, 'awaiting-order', '注文確認との対応付けを待っています。', true); continue; }
    const deliveredAt = timestamp(event.deliveredAt);
    if (!deliveredAt || deliveredAt < binding.orderedAt || deliveredAt > timestamp(event.observedAtISO)!
      || !text(event.shipmentId) || event.productKey !== binding.productKey || !count(event.quantity) || event.unit !== binding.unit
      || (event.orderedAt !== null && timestamp(event.orderedAt) !== binding.orderedAt)) {
      review(receipt, 'uncertain-delivery', '配達完了の日時・配送・商品・数量を確定できません。', false, binding.itemId); continue;
    }
    if (binding.state === 'review') { review(receipt, 'order-needs-review', 'この注文は確認が必要なため購入完了にしません。', false, binding.itemId); continue; }
    const knownShipment = binding.shipments.find(shipment => shipment.id === event.shipmentId);
    if (knownShipment) {
      if (knownShipment.quantity === event.quantity && knownShipment.deliveredAt === deliveredAt) { receipt.outcome = 'duplicate'; delete receipt.review; }
      else { binding.state = 'review'; review(receipt, 'shipment-content-changed', '同じ配送の数量や配達日時が変わったため確認が必要です。', false, binding.itemId); }
      continue;
    }
    const item = nextItems.find(row => row.id === binding.itemId);
    if (!item || itemSnapshot(item) !== binding.itemSnapshot || !unreceivedCandidate(item)) {
      binding.state = 'review';
      review(receipt, 'item-changed', '対応する商品や在庫・購入記録が変更されたため自動反映しません。', false, binding.itemId); continue;
    }
    const delivered = binding.shipments.reduce((sum, shipment) => sum + shipment.quantity, 0) + event.quantity;
    if (delivered > binding.quantity) { binding.state = 'review'; review(receipt, 'delivery-overflow', '配達数量が注文数量を超えるため確認が必要です。', false, binding.itemId); continue; }
    binding.shipments.push({ id: event.shipmentId, quantity: event.quantity, deliveredAt, eventId: event.id });
    delete receipt.review;
    if (delivered < binding.quantity) { binding.state = 'partial'; receipt.outcome = 'partial'; continue; }
    // Delivery completion is separate from stock accounting. Preserve all current-stock and purchase quantities.
    const projectionTime = next.receipts.reduce((latest, row) => {
      const observed = timestamp(row.event.observedAtISO); return observed && observed > latest ? observed : latest;
    }, timestamp(item.updatedAt) || timestamp(event.observedAtISO)!);
    nextItems = nextItems.map(row => row.id === item.id ? { ...row, status: 'received', purchaseLater: false, updatedAt: projectionTime } : row);
    binding.state = 'completed'; binding.completedAt = binding.shipments.reduce((latest, shipment) => shipment.deliveredAt > latest ? shipment.deliveredAt : latest, deliveredAt); receipt.outcome = 'completed';
    completedItemIds.push(item.id);
  }
  for (const receipt of pending.filter(row => row.event.kind === 'review')) eligible(receipt);
  return { items: nextItems, ledger: next, reviews: [...next.receipts.flatMap(row => row.review ? [row.review] : []), ...next.conflicts], completedItemIds };
}
