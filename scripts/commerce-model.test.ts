import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormalizedCommerceEvent } from '../lib/commerce-model';
const { newItem } = await import(new URL('../lib/client-model.ts', import.meta.url).href) as typeof import('../lib/client-model');
const { applyCommerceEvents, emptyCommerceLedger, commerceProductKey } = await import(new URL('../lib/commerce-model.ts', import.meta.url).href) as typeof import('../lib/commerce-model');
const scope = 'private-fixture-connection';
const url = 'https://www.amazon.co.jp/dp/B000000001?tag=fixture';
const productKey = commerceProductKey(url, 'amazon')!;
const createdAt = '2026-11-01T00:00:00.000Z';
const orderedAt = '2026-11-01T01:00:00.000Z';
const deliveredAt = '2026-11-02T01:00:00.000Z';
const item = (fields: Parameters<typeof newItem>[1] = {}) => newItem('合成検証用の棚', { id: 'target', url, quantity: 2, unit: '個',
  purchaseLater: true, createdAt, updatedAt: createdAt, stockKnown: false, ...fields });
const event = (fields: Partial<NormalizedCommerceEvent> = {}): NormalizedCommerceEvent => ({ id: 'order-notice', merchant: 'amazon', accountScope: scope,
  kind: 'ordered', orderId: 'opaque-order-1', orderLineId: 'opaque-line-1', productKey, shipmentId: null,
  quantity: 2, unit: '個', orderedAt, deliveredAt: null, explicitConfirmed: true, observedAtISO: '2026-11-01T02:00:00.000Z', parserVersion: 1, ...fields });
const delivery = (fields: Partial<NormalizedCommerceEvent> = {}) => event({ id: 'delivery-notice', kind: 'delivered', shipmentId: 'shipment-1', deliveredAt,
  observedAtISO: '2026-11-02T02:00:00.000Z', ...fields });
const start = (target = item()) => applyCommerceEvents([target], emptyCommerceLedger(scope), [event()]);

test('an explicit order binds one exact existing candidate without changing any shopping data', () => {
  const target = item({ comment: '保持するコメント', favorite: true });
  const result = start(target);
  assert.equal(result.items[0], target); assert.deepEqual(result.completedItemIds, []); assert.deepEqual(result.reviews, []);
  assert.equal(result.ledger.bindings.length, 1); assert.equal(result.ledger.bindings[0].itemId, target.id);
  assert.equal(result.ledger.bindings[0].state, 'waiting'); assert.equal(result.ledger.bindings[0].quantity, 2);
});

test('only fully delivered quantity marks received, preserving stock, purchase quantities, and all metadata', () => {
  for (const stockKnown of [true, false]) {
    const target = item({ stockKnown, favorite: true, comment: '寸法を確認した', price: 5000,
      deliveryDate: '2026-11-04', attachments: [{ id: 'size', name: '寸法', url: '/api/attachments/size', type: 'image/png' }] });
    const initial = start(target);
    const result = applyCommerceEvents(initial.items, initial.ledger, [delivery()]);
    assert.deepEqual(result.completedItemIds, [target.id]); assert.equal(result.items[0].status, 'received'); assert.equal(result.items[0].purchaseLater, false);
    assert.deepEqual({ ...result.items[0], status: target.status, purchaseLater: target.purchaseLater, updatedAt: target.updatedAt }, target);
    assert.equal(result.items[0].stock, 0); assert.equal(result.items[0].purchasedQuantity, 0); assert.equal(result.items[0].purchasedAt, '');
    assert.equal(result.items[0].stockKnown, stockKnown); assert.equal(result.items[0].deliveryDate, '2026-11-04');
    assert.equal(result.ledger.bindings[0].completedAt, deliveredAt); assert.deepEqual(result.reviews, []);
  }
});

test('partial shipments and both forms of repeated notification cannot prematurely complete or double count', () => {
  const initial = start();
  const one = delivery({ quantity: 1 });
  const partial = applyCommerceEvents(initial.items, initial.ledger, [one]);
  assert.equal(partial.items, initial.items); assert.equal(partial.ledger.bindings[0].state, 'partial'); assert.equal(partial.ledger.bindings[0].shipments.length, 1);
  const sameMessage = applyCommerceEvents(partial.items, partial.ledger, [one]);
  assert.equal(sameMessage.ledger.receipts.length, 2); assert.equal(sameMessage.ledger.bindings[0].shipments.length, 1);
  const duplicateMessage = applyCommerceEvents(sameMessage.items, sameMessage.ledger, [{ ...one, id: 'another-email-for-same-shipment' }]);
  assert.equal(duplicateMessage.ledger.bindings[0].shipments.length, 1); assert.equal(duplicateMessage.ledger.receipts.at(-1)!.outcome, 'duplicate');
  const complete = applyCommerceEvents(duplicateMessage.items, duplicateMessage.ledger, [delivery({ id: 'shipment-2-email', shipmentId: 'shipment-2', quantity: 1 })]);
  assert.equal(complete.items[0].status, 'received'); assert.equal(complete.ledger.bindings[0].shipments.length, 2);
  const replay = applyCommerceEvents(complete.items, complete.ledger, [one, delivery({ id: 'shipment-2-email', shipmentId: 'shipment-2', quantity: 1 })]);
  assert.equal(replay.items, complete.items); assert.deepEqual(replay.completedItemIds, []); assert.equal(replay.ledger.bindings[0].shipments.length, 2);
});

test('out-of-order email collection binds the order first and waits across collections when necessary', () => {
  const target = item();
  const batch = applyCommerceEvents([target], emptyCommerceLedger(scope), [delivery(), event()]);
  assert.equal(batch.items[0].status, 'received'); assert.deepEqual(batch.reviews, []);
  const early = applyCommerceEvents([target], emptyCommerceLedger(scope), [delivery()]);
  assert.equal(early.items[0], target); assert.equal(early.reviews[0].code, 'awaiting-order'); assert.equal(early.ledger.receipts[0].outcome, 'pending');
  const later = applyCommerceEvents(early.items, early.ledger, [event()]);
  assert.equal(later.items[0].status, 'received'); assert.deepEqual(later.reviews, []); assert.equal(later.ledger.receipts[0].outcome, 'completed');
});

test('unverified collector output and unknown order fields always produce review instead of automatic completion', () => {
  for (const fields of [{ explicitConfirmed: false }, { merchant: 'unknown' as const }, { quantity: null }, { unit: null }, { productKey: null },
    { orderId: null }, { orderLineId: null }, { orderedAt: null }, { orderedAt: '2026-11-01' }, { quantity: -1 }, { quantity: .5 }]) {
    const target = item(); const result = applyCommerceEvents([target], emptyCommerceLedger(scope), [event(fields), delivery(fields)]);
    assert.equal(result.items[0], target); assert.equal(result.completedItemIds.length, 0); assert.ok(result.reviews.length > 0);
  }
});

test('a delivery requires explicit shipment, exact product, count, unit, and a real completion time', () => {
  for (const fields of [{ explicitConfirmed: false }, { shipmentId: null }, { productKey: 'amazon:amazon.co.jp:B000000002' }, { quantity: null }, { unit: '箱' },
    { deliveredAt: null }, { deliveredAt: '2026-11-01' }, { deliveredAt: '2026-11-03T00:00:00.000Z' }, { deliveredAt: '2026-10-31T00:00:00.000Z' },
    { orderedAt: '2026-10-31T01:00:00.000Z' }]) {
    const initial = start(); const result = applyCommerceEvents(initial.items, initial.ledger, [delivery(fields)]);
    assert.equal(result.items, initial.items); assert.equal(result.completedItemIds.length, 0); assert.ok(result.reviews.length > 0);
  }
});

test('names, quantity differences, units, late-created items, and multiple matching items cannot choose a purchase', () => {
  for (const fields of [{ quantity: 1 }, { unit: '箱' }, { createdAt: '2026-11-01T01:00:01.000Z' }, { url: '' }, { url: 'https://www.amazon.com/dp/B000000001' }]) {
    const target = item(fields); const result = applyCommerceEvents([target], emptyCommerceLedger(scope), [event(), delivery()]);
    assert.equal(result.items[0], target); assert.equal(result.completedItemIds.length, 0); assert.ok(result.reviews.length > 0);
  }
  const first = item(), second = item({ id: 'other-copy' });
  const result = applyCommerceEvents([first, second], emptyCommerceLedger(scope), [event(), delivery()]);
  assert.equal(result.items[0], first); assert.equal(result.items[1], second); assert.ok(result.reviews.some(row => row.code === 'ambiguous-item'));
});

test('existing stock or manual purchase records are never auto-bound as an untouched shopping candidate', () => {
  for (const fields of [{ stock: 1 }, { spare: 1 }, { checkedAt: '2026-11-01' }, { purchasedQuantity: 1 }, { purchasedAt: '2026-11-01' },
    { stockReconciledQuantity: 1 }, { status: 'purchased' as const }, { status: 'received' as const }, { inventoryOnly: true }]) {
    const target = item(fields); const result = applyCommerceEvents([target], emptyCommerceLedger(scope), [event(), delivery()]);
    assert.equal(result.items[0], target); assert.equal(result.ledger.bindings.length, 0); assert.equal(result.completedItemIds.length, 0);
  }
});

test('manual changes or deletion after order binding require review and are never overwritten', () => {
  for (const fields of [{ stock: 1 }, { spare: 1 }, { quantity: 3 }, { purchasedQuantity: 1 }, { purchasedAt: '2026-11-01' }, { stockKnown: true },
    { unit: '箱' }, { checkedAt: '2026-11-02' }, { status: 'purchased' as const }, { purchaseLater: false }, { stockReconciledQuantity: 1 },
    { url: 'https://www.amazon.co.jp/dp/B000000002' }, { updatedAt: '2026-11-01T02:30:00.000Z' }]) {
    const initial = start(); const changed = { ...initial.items[0], ...fields };
    const result = applyCommerceEvents([changed], initial.ledger, [delivery()]);
    assert.equal(result.items[0], changed); assert.equal(result.completedItemIds.length, 0); assert.equal(result.reviews[0].code, 'item-changed');
  }
  const initial = start(); const deleted = applyCommerceEvents([], initial.ledger, [delivery()]);
  assert.deepEqual(deleted.items, []); assert.equal(deleted.reviews[0].code, 'item-changed');
});

test('the same ASIN in a later order cannot reuse an existing binding or complete its item from the wrong order', () => {
  const initial = start();
  const otherOrder = event({ id: 'order-2', orderId: 'opaque-order-2' });
  const result = applyCommerceEvents(initial.items, initial.ledger, [otherOrder, delivery({ id: 'order-2-delivery', orderId: 'opaque-order-2' })]);
  assert.equal(result.items, initial.items); assert.equal(result.ledger.bindings.length, 1); assert.equal(result.completedItemIds.length, 0);
  const rightOrder = applyCommerceEvents(result.items, result.ledger, [delivery()]);
  assert.equal(rightOrder.items, result.items); assert.equal(rightOrder.ledger.bindings[0].state, 'review');
});

test('cancellations before or after the order and returns never cause guessed completion or stock subtraction', () => {
  const cancelled = event({ id: 'cancelled', kind: 'cancelled' });
  for (const events of [[cancelled, event(), delivery()], [event(), cancelled, delivery()]]) {
    const target = item(); const result = applyCommerceEvents([target], emptyCommerceLedger(scope), events);
    assert.equal(result.items[0], target); assert.equal(result.ledger.bindings[0].state, 'review'); assert.equal(result.completedItemIds.length, 0);
  }
  const early = applyCommerceEvents([item()], emptyCommerceLedger(scope), [cancelled]);
  const later = applyCommerceEvents(early.items, early.ledger, [event(), delivery()]);
  assert.equal(later.items, early.items); assert.equal(later.ledger.bindings[0].state, 'review');
  const completed = applyCommerceEvents([item()], emptyCommerceLedger(scope), [event(), delivery()]);
  const returned = applyCommerceEvents(completed.items, completed.ledger, [event({ id: 'return', kind: 'returned' })]);
  assert.equal(returned.items, completed.items); assert.equal(returned.items[0].stock, 0); assert.equal(returned.ledger.bindings[0].state, 'review');
});

test('over-delivery and changed order or shipment facts block later automatic completion', () => {
  const initial = start();
  const overflow = applyCommerceEvents(initial.items, initial.ledger, [delivery({ quantity: 3 })]);
  assert.equal(overflow.items, initial.items); assert.equal(overflow.reviews[0].code, 'delivery-overflow');
  const changedOrder = applyCommerceEvents(initial.items, initial.ledger, [event({ id: 'changed-order', quantity: 3 }), delivery()]);
  assert.equal(changedOrder.items, initial.items); assert.equal(changedOrder.ledger.bindings[0].state, 'review');
  const partial = applyCommerceEvents(initial.items, initial.ledger, [delivery({ quantity: 1 })]);
  const changedShipment = applyCommerceEvents(partial.items, partial.ledger, [delivery({ id: 'same-shipment-corrected', quantity: 2 }),
    delivery({ id: 'remaining-shipment', shipmentId: 'shipment-2', quantity: 1 })]);
  assert.equal(changedShipment.items, partial.items); assert.equal(changedShipment.ledger.bindings[0].state, 'review');
});

test('one notification ID cannot be reused with different facts to mutate an existing order', () => {
  const initial = start();
  const result = applyCommerceEvents(initial.items, initial.ledger, [event({ quantity: 3 }), delivery()]);
  assert.equal(result.items, initial.items); assert.equal(result.ledger.bindings[0].state, 'review');
  assert.ok(result.reviews.some(row => row.code === 'event-content-changed'));
  const withinBatch = applyCommerceEvents([item()], emptyCommerceLedger(scope), [event(), event({ quantity: 3 }), delivery()]);
  assert.equal(withinBatch.ledger.bindings.length, 0); assert.equal(withinBatch.completedItemIds.length, 0);
});

test('another account scope and unknown source text cannot modify the list', () => {
  const target = item(); const result = applyCommerceEvents([target], emptyCommerceLedger(scope), [event({ accountScope: 'other-connection' }), delivery({ accountScope: 'other-connection' })]);
  assert.equal(result.items[0], target); assert.equal(result.ledger.receipts.length, 0); assert.ok(result.reviews.every(row => row.code === 'account-mismatch'));
  const reviewOnly = applyCommerceEvents([target], emptyCommerceLedger(scope), [event({ kind: 'review', explicitConfirmed: false })]);
  assert.equal(reviewOnly.items[0], target); assert.equal(reviewOnly.reviews[0].code, 'unconfirmed-source');
});

test('exact Rakuten URL variants stay separate and unspecified size or color needs review', () => {
  const rakutenUrl = 'https://item.rakuten.co.jp/fixture-shop/fixture-item/?sku=blue';
  const key = commerceProductKey(rakutenUrl, 'rakuten')!;
  assert.notEqual(key, commerceProductKey(rakutenUrl.replace('blue', 'red'), 'rakuten'));
  assert.equal(commerceProductKey('https://item.rakuten.co.jp.evil.test/shop/item/', 'rakuten'), null);
  const order = event({ merchant: 'rakuten', productKey: key }); const received = delivery({ merchant: 'rakuten', productKey: key });
  const target = item({ url: rakutenUrl });
  assert.equal(applyCommerceEvents([target], emptyCommerceLedger(scope), [order, received]).items[0].status, 'received');
  const variantUnknown = item({ url: rakutenUrl, size: 'L' });
  assert.equal(applyCommerceEvents([variantUnknown], emptyCommerceLedger(scope), [order, received]).items[0], variantUnknown);
});

test('inputs, historical records, and unrelated items are immutable throughout projection and replay', () => {
  const unrelated = item({ id: 'unrelated', url: 'https://www.amazon.co.jp/dp/B000000002', stock: 4, status: 'purchased', purchasedQuantity: 4 });
  const items = [item(), unrelated]; const ledger = emptyCommerceLedger(scope); const events = [event(), delivery()];
  const before = structuredClone({ items, ledger, events });
  const result = applyCommerceEvents(items, ledger, events);
  assert.deepEqual({ items, ledger, events }, before); assert.equal(result.items[1], unrelated);
  const saved = structuredClone(result.ledger); applyCommerceEvents(result.items, result.ledger, events);
  assert.deepEqual(result.ledger, saved);
});

test('re-reading an unchanged notification at a later observation time remains idempotent', () => {
  const initial = start();
  const result = applyCommerceEvents(initial.items, initial.ledger, [event({ observedAtISO: '2026-11-03T00:00:00.000Z' })]);
  assert.equal(result.items, initial.items); assert.equal(result.ledger.receipts.length, 1); assert.deepEqual(result.reviews, []);
});

test('out-of-order partial deliveries use the latest actual delivery time and never rewind item update time', () => {
  const target = item({ updatedAt: '2026-11-05T00:00:00.000Z' });
  const result = applyCommerceEvents([target], emptyCommerceLedger(scope), [event(),
    delivery({ id: 'later-physical-delivery', shipmentId: 'shipment-2', quantity: 1, deliveredAt: '2026-11-03T00:00:00.000Z', observedAtISO: '2026-11-03T01:00:00.000Z' }),
    delivery({ id: 'earlier-physical-delivery', shipmentId: 'shipment-1', quantity: 1 })]);
  assert.equal(result.items[0].status, 'received'); assert.equal(result.ledger.bindings[0].completedAt, '2026-11-03T00:00:00.000Z');
  assert.equal(result.items[0].updatedAt, target.updatedAt);
});
