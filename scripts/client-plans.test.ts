import assert from 'node:assert/strict';
import test from 'node:test';
const { newItem, emptyState, validateState, validateShoppingCache, cacheNeedsReview } = await import(new URL('../lib/client-model.ts', import.meta.url).href) as typeof import('../lib/client-model');
const { importPlannedProducts, moveToShoppingList, getShoppingItems, getPlannedItems, plannedProductKey } = await import(new URL('../lib/client-plans.ts', import.meta.url).href) as typeof import('../lib/client-plans');
const { compareFood } = await import(new URL('../lib/client-food.ts', import.meta.url).href) as typeof import('../lib/client-food');
const { applyCooking } = await import(new URL('../lib/client-cooking.ts', import.meta.url).href) as typeof import('../lib/client-cooking');
const { addFoodShortages } = await import(new URL('../lib/client-food-actions.ts', import.meta.url).href) as typeof import('../lib/client-food-actions');

const product = { name: '検証用の棚', url: 'https://www.amazon.co.jp/dp/B000000001?tag=sample' };
const recipe = { title: '検証用の料理', url: '', servings: 2, ingredients: [{ name: '牛乳', quantity: 400, unit: 'ml', note: '' }] };

test('imported future plans are separate records, never daily errands, purchases, or stock', () => {
  const existing = newItem('今日買う卵', { id: 'existing', quantity: 2, price: 300 });
  const before = structuredClone(existing);
  const result = importPlannedProducts([existing], [product, { name: '検証用の椅子', url: 'https://www.amazon.co.jp/dp/B000000002', quantity: 2, unit: '脚', category: '家具' }]);
  assert.equal(result.error, null); assert.equal(result.added.length, 2); assert.equal(result.skipped, 0); assert.equal(result.invalid, 0);
  assert.equal(result.items[0], existing); assert.deepEqual(existing, before);
  assert.equal(result.added[0].purchaseLater, true); assert.equal(result.added[0].status, 'planned'); assert.equal(result.added[0].store, 'Amazon');
  assert.equal(result.added[0].stock, 0); assert.equal(result.added[0].purchasedQuantity, 0); assert.equal(result.added[0].checkedAt, '');
  assert.equal(result.added[0].stockKnown, false); assert.equal(result.added[0].url, product.url);
  assert.deepEqual(getShoppingItems(result.items), [existing]); assert.deepEqual(getPlannedItems(result.items), result.added);
  assert.equal(result.added[1].unit, '脚'); assert.equal(result.added[1].quantity, 2); assert.equal(result.added[1].category, '家具');
  const state = { ...emptyState(), items: result.items };
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(state))), state);
});

test('ASIN deduplication covers candidate duplicates and all existing collections without changing them', () => {
  const variants = [
    'https://www.amazon.co.jp/商品名/dp/B000000001/ref=abc?tag=x',
    'https://amazon.co.jp/gp/product/b000000001?psc=1',
    'https://m.amazon.co.jp/gp/aw/d/B000000001#fragment',
  ];
  assert.ok(variants.every(url => plannedProductKey(url) === plannedProductKey(product.url)));
  for (const fields of [{}, { purchaseLater: true }, { status: 'purchased' as const, stock: 1 }, { inventoryOnly: true }]) {
    const existing = newItem('本人が編集した商品名', { ...fields, url: product.url, favorite: true, comment: '保持するメモ' });
    const before = structuredClone(existing);
    const result = importPlannedProducts([existing], variants.map(url => ({ ...product, url })));
    assert.equal(result.added.length, 0); assert.equal(result.skipped, 3); assert.equal(result.items[0], existing); assert.deepEqual(existing, before);
  }
  const candidates = importPlannedProducts([], [product, ...variants.map(url => ({ ...product, url })), { ...product, url: 'https://www.amazon.co.jp/dp/B000000002' }]);
  assert.equal(candidates.added.length, 2); assert.equal(candidates.skipped, 3);
  const again = importPlannedProducts(candidates.items, [product]);
  assert.equal(again.items, candidates.items); assert.equal(again.added.length, 0); assert.equal(again.skipped, 1);
});

test('similar titles and different Amazon variants or marketplaces are not conflated', () => {
  const result = importPlannedProducts([], [product, { ...product, url: 'https://www.amazon.co.jp/dp/B000000002' }, { ...product, url: 'https://www.amazon.com/dp/B000000001' }]);
  assert.equal(result.added.length, 3);
  assert.notEqual(plannedProductKey('https://www.amazon.co.jp.evil.test/dp/B000000001'), plannedProductKey(product.url));
  assert.equal(plannedProductKey('https://example.com/item#one'), plannedProductKey('https://example.com/item#two'));
});

test('promotion keeps the same saved product and its metadata instead of adding another copy', () => {
  const item = newItem('検証用の棚', { id: 'same-product', purchaseLater: true, favorite: true, url: product.url, price: 5000,
    comment: '寸法を確認', attachments: [{ id: 'size', name: '寸法', url: '/api/attachments/size', type: 'image/png' }] });
  const before = structuredClone(item);
  const moved = moveToShoppingList(item);
  assert.equal(moved.purchaseLater, false); assert.equal(moved.id, item.id);
  assert.deepEqual({ ...moved, purchaseLater: item.purchaseLater, updatedAt: item.updatedAt }, item); assert.deepEqual(item, before);
  assert.equal(moveToShoppingList(moved), moved); assert.deepEqual(getShoppingItems([moved]), [moved]); assert.deepEqual(getPlannedItems([moved]), []);
});

test('a saved completed or cancelled candidate remains reachable in its dedicated collection', () => {
  const items = (['purchased', 'received', 'cancelled', 'returned', 'exchanged'] as const).map(status => newItem('保存済み商品', { purchaseLater: true, status }));
  assert.deepEqual(getPlannedItems(items), items); assert.deepEqual(getShoppingItems(items), []);
});

test('future food candidates do not hide recipe shortages or block adding today’s missing amount', () => {
  const known = newItem('牛乳', { inventoryOnly: true, stock: 100, unit: 'ml', checkedAt: '2026-11-01' });
  const future = newItem('牛乳', { purchaseLater: true, quantity: 1, unit: '本', stockKnown: false });
  const [row] = compareFood(recipe, [known, future]);
  assert.equal(row.have, 100); assert.equal(row.planned, 0); assert.equal(row.toBuy, 300); assert.equal(row.status, 'shortage');
  const next = addFoodShortages([known, future], recipe);
  assert.equal(next.length, 3); assert.equal(next[1], future); assert.equal(next[2].purchaseLater, false); assert.equal(next[2].quantity, 300);
  assert.equal(compareFood(recipe, next)[0].toBuy, 0);
});

test('v1 to v3 snapshots migrate without changing existing items or losing v3 cooking history', () => {
  const milk = newItem('牛乳', { inventoryOnly: true, stock: 1000, unit: 'ml', checkedAt: '2026-11-01' });
  const cooked = applyCooking([milk], [], recipe, 2, 'saved-cooking', '2026-11-01T00:00:00.000Z');
  for (const version of [1, 2, 3]) {
    const legacyItem: Partial<typeof milk> = { ...(version === 3 ? cooked.items[0] : milk) };
    delete legacyItem.purchaseLater;
    const raw = { ...emptyState(), version, items: [legacyItem], mealRecipe: recipe, cookingHistory: version === 3 ? cooked.history : [] };
    const original = JSON.stringify(raw);
    const migrated = validateState(raw)!;
    assert.equal(migrated.version, 4); assert.equal(migrated.items[0].purchaseLater, false); assert.deepEqual(migrated.mealRecipe, recipe);
    assert.deepEqual(migrated.cookingHistory, version === 3 ? cooked.history : []); assert.equal(JSON.stringify(raw), original);
  }
});

test('v3 dirty caches require review before replacing v4 future plans at the same revision', () => {
  const local = validateShoppingCache({ state: { ...emptyState(), version: 3 }, revision: 7, dirty: true })!;
  const remote = { ...emptyState(), items: [newItem('保存した棚', { purchaseLater: true })] };
  assert.equal(local.legacyDirty, true); assert.equal(cacheNeedsReview(local, remote, 7), true);
  const reloaded = validateShoppingCache(JSON.parse(JSON.stringify(local)))!;
  assert.equal(reloaded.legacyDirty, true); assert.equal(cacheNeedsReview(reloaded, remote, 7), true);
  assert.equal(cacheNeedsReview({ ...reloaded, dirty: false }, remote, 7), false);
});

test('v4 malformed or missing collection flags cannot silently expose future plans in the daily list', () => {
  for (const value of [undefined, null, 'true', 1]) {
    assert.equal(validateState({ ...emptyState(), items: [{ ...newItem('棚'), purchaseLater: value }] }), null);
  }
});

test('invalid imported rows are skipped without erasing existing data or treating URLs as product names', () => {
  const items = [newItem('残す商品')];
  const rows = [null, {}, { ...product, quantity: 0 }, { ...product, quantity: '1' }, { ...product, unit: '' }, { ...product, url: 'javascript:alert(1)' },
    { ...product, name: product.url }, { ...product, url: 'https://user:pass@amazon.co.jp/dp/B000000001' }, { ...product, category: 3 }, product];
  const result = importPlannedProducts(items, rows);
  assert.equal(result.invalid, 9); assert.equal(result.added.length, 1); assert.equal(result.items[0], items[0]);
  for (const input of [null, {}, [], Array.from({ length: 1001 }, () => product)]) {
    const rejected = importPlannedProducts(items, input);
    assert.equal(rejected.items, items); assert.ok(rejected.error); assert.equal(rejected.added.length, 0);
  }
});

test('exceeding total capacity rejects the entire import instead of reporting a partial unsaved result', () => {
  const items = Array.from({ length: 9999 }, (_, index) => newItem('既存商品', { id: `saved-${index}` }));
  const result = importPlannedProducts(items, [product, { ...product, url: 'https://www.amazon.co.jp/dp/B000000002' }]);
  assert.equal(result.items, items); assert.equal(result.added.length, 0); assert.match(result.error!, /追加しませんでした/u);
  const fits = importPlannedProducts(items, [product, { ...product, url: 'https://www.amazon.co.jp/gp/product/B000000001' }]);
  assert.equal(fits.error, null); assert.equal(fits.items.length, 10000); assert.equal(fits.added.length, 1); assert.equal(fits.skipped, 1);
});
