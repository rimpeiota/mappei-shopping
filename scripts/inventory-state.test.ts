import assert from 'node:assert/strict';
import test from 'node:test';
const { newItem, emptyState, validateState, validateFoodRecipe, hasShoppingData, mergeAnonymousState,
  recordPurchasedQuantity, setItemStatus, finalizePurchaseDraft, validateShoppingCache, cacheNeedsReview } =
  await import(new URL('../lib/client-model.ts', import.meta.url).href) as typeof import('../lib/client-model');

const recipe = () => ({ title: 'チキングラタン', url: 'https://www.youtube.com/watch?v=0VJNIVUSInk', servings: 2,
  ingredients: [{ name: '牛乳', quantity: 400, unit: 'ml', note: '' }, { name: '黒こしょう', quantity: null, unit: '', note: '量の記載なし' }] });

test('a persisted legacy GET snapshot migrates without losing existing shopping details', async () => {
  const item = newItem('既存の商品', { id: 'legacy', stock: 2, spare: 1, unit: '本', remaining: 30, purchasedQuantity: 3,
    status: 'purchased', purchasedAt: '2026-10-27', checkedAt: '2026-10-28', comment: '以前のメモ', favorite: true,
    prices: [{ id: 'price', store: '店舗', price: 250, date: '2026-10-27', source: '店頭' }],
    attachments: [{ id: 'file', name: 'レシート', type: 'image/png', url: '/api/attachments/file' }] });
  const legacyItem = { ...item } as Partial<typeof item>;
  delete legacyItem.inventoryOnly; delete legacyItem.stockKnown; delete legacyItem.inventorySource;
  const payload = await new Response(JSON.stringify({ owner: 'legacy-owner', revision: 7, state: { ...emptyState(), version: 1, items: [legacyItem] } })).json() as { state: unknown; revision: number };
  const migrated = validateState(payload.state);
  assert.ok(migrated); assert.equal(migrated.version, 2); assert.equal(migrated.mealRecipe, null);
  assert.deepEqual(migrated.items[0], item); assert.equal(payload.revision, 7);
  assert.equal(migrated.items[0].inventoryOnly, false); assert.equal(migrated.items[0].stockKnown, true);
});

test('current inventory and unknown amounts survive a v2 JSON round trip', () => {
  const state = { ...emptyState(), items: [newItem('冷蔵庫の牛乳', { inventoryOnly: true, stockKnown: false,
    stock: 0, spare: 0, inventorySource: '今日の確認', location: '冷蔵庫' })], mealRecipe: recipe() };
  const roundTrip = validateState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(roundTrip, state); assert.equal(roundTrip!.mealRecipe!.ingredients[1].quantity, null);
  const knownZero = { ...state, items: [newItem('牛乳', { inventoryOnly: true, stockKnown: true, stock: 0, checkedAt: '2026-10-28' })] };
  assert.equal(validateState(knownZero)!.items[0].stockKnown, true);
  assert.equal(validateState(knownZero)!.items[0].stock, 0);
});

test('invalid recipe amounts, sources, dimensions, or excessive ingredients are not accepted as food data', () => {
  assert.ok(validateFoodRecipe({ ...recipe(), url: '', servings: null }));
  for (const quantity of [-1, Infinity, NaN, '400', 1_000_001, undefined]) {
    assert.equal(validateFoodRecipe({ ...recipe(), ingredients: [{ name: '牛乳', quantity, unit: 'ml', note: '' }] }), null);
  }
  for (const url of ['javascript:alert(1)', 'http://example.com/recipe', 'https://user:password@example.com/recipe']) {
    assert.equal(validateFoodRecipe({ ...recipe(), url }), null);
  }
  for (const servings of [0, -2, Infinity, '2', undefined]) assert.equal(validateFoodRecipe({ ...recipe(), servings }), null);
  assert.equal(validateFoodRecipe({ ...recipe(), ingredients: Array.from({ length: 101 }, () => recipe().ingredients[0]) }), null);
  assert.equal(validateFoodRecipe({ ...recipe(), ingredients: [{ name: '', quantity: 0, unit: '', note: '' }] }), null);
  assert.equal(validateState({ ...emptyState(), mealRecipe: { ...recipe(), ingredients: 'invalid' } })!.mealRecipe, null);
  assert.equal(validateFoodRecipe({ ...recipe(), ingredients: [{ name: '塩', quantity: 0, unit: 'g', note: '' }] })!.ingredients[0].quantity, 0);
});

test('recipe strings are bounded and unknown required quantities remain null', () => {
  const sanitized = validateFoodRecipe({ ...recipe(), title: '題'.repeat(600), ingredients: [{ name: '材'.repeat(600), quantity: null, unit: '個'.repeat(60), note: '注'.repeat(2100) }] });
  assert.ok(sanitized); assert.equal(sanitized.title.length, 500); assert.equal(sanitized.ingredients[0].name.length, 500);
  assert.equal(sanitized.ingredients[0].unit.length, 50); assert.equal(sanitized.ingredients[0].note.length, 2000);
  assert.equal(sanitized.ingredients[0].quantity, null);
});

test('recipe-only anonymous notes count as data and merge without discarding a local-only recipe', () => {
  const local = { ...emptyState(), mealRecipe: recipe(), items: [newItem('卵', { id: 'local' })] };
  const account = { ...emptyState(), items: [newItem('牛乳', { id: 'account' })] };
  assert.equal(hasShoppingData(emptyState()), false); assert.equal(hasShoppingData({ ...emptyState(), mealRecipe: recipe() }), true);
  const merged = mergeAnonymousState(account, local);
  assert.deepEqual(merged.mealRecipe, local.mealRecipe); assert.deepEqual(merged.items.map(item => item.id), ['account', 'local']);
  const accountRecipe = { ...recipe(), title: '保存済みの料理' };
  assert.deepEqual(mergeAnonymousState({ ...account, mealRecipe: accountRecipe }, local).mealRecipe, accountRecipe);
  assert.deepEqual(account.items.map(item => item.id), ['account']);
});

test('a legacy dirty cache cannot erase a newer recipe after reload even when revisions match', () => {
  // An old client can reject v2 on GET and cache an empty v1 interpretation at revision 7.
  const restored = validateShoppingCache({ state: { ...emptyState(), version: 1 }, revision: 7, dirty: true });
  assert.ok(restored); assert.equal(restored.state.version, 2); assert.equal(restored.legacyDirty, true);
  const cloud = { ...emptyState(), mealRecipe: recipe(), items: [newItem('保存済みの牛乳')] };
  assert.equal(cacheNeedsReview(restored, cloud, 7), true);
  // A new local edit/persist must not erase the provenance flag before a confirmed choice.
  const edited = { ...restored, state: { ...restored.state, items: [newItem('新しいメモ')] }, dirty: true };
  const reloaded = validateShoppingCache(JSON.parse(JSON.stringify(edited)));
  assert.ok(reloaded); assert.equal(reloaded.legacyDirty, true);
  assert.equal(cacheNeedsReview(reloaded, cloud, 7), true);
  assert.equal(cloud.mealRecipe!.title, 'チキングラタン');
  // Legacy pending changes remain a supported migration when the cloud is also v1.
  assert.equal(cacheNeedsReview(restored, { ...emptyState(), version: 1 }, 7), false);
  assert.equal(cacheNeedsReview({ ...restored, dirty: false }, cloud, 7), false);
  assert.equal(cacheNeedsReview({ ...restored, legacyDirty: false }, cloud, 8), true);
  assert.equal(cacheNeedsReview({ ...restored, legacyDirty: false }, cloud, 7), false);
});

test('a partial purchase adds the actual fraction remaining, and a later receipt adds nothing twice', () => {
  const before = newItem('牛乳', { quantity: 1, unit: 'L', purchasedQuantity: .5, stock: .5 });
  const bought = recordPurchasedQuantity(before, before.purchasedQuantity + 1);
  assert.equal(bought.purchasedQuantity, 1); assert.equal(bought.stock, 1); assert.equal(bought.status, 'purchased');
  const received = setItemStatus(bought, 'received');
  assert.equal(received.stock, 1); assert.equal(received.purchasedQuantity, 1); assert.equal(received.status, 'received');
  assert.equal(recordPurchasedQuantity(received, 1).stock, 1);
});

test('editing a purchase reconciles once on Save and explicit current stock is not incremented again', () => {
  const original = newItem('卵', { quantity: 12, purchasedQuantity: 2, stock: 1 });
  // An input may pass through 1 -> 12 -> 3. Intermediate digit edits must not add stock.
  let draft = original;
  for (const amount of [1, 12, 3]) draft = { ...recordPurchasedQuantity(draft, amount), stock: original.stock };
  assert.equal(finalizePurchaseDraft(original, draft).stock, 2);
  assert.equal(finalizePurchaseDraft(original, { ...draft, stock: 5 }, true).stock, 5);
  const corrected = recordPurchasedQuantity(original, 1);
  assert.equal(corrected.stock, original.stock);
  assert.equal(finalizePurchaseDraft(original, { ...corrected, stock: original.stock }).stock, original.stock);
  assert.equal(setItemStatus(original, 'returned').stock, original.stock);
});

test('a purchase cannot turn an unknown preexisting current amount into a confirmed total', () => {
  const unknown = newItem('牛乳', { quantity: 2, stock: 0, stockKnown: false });
  assert.equal(recordPurchasedQuantity(unknown, 1).stockKnown, false);
});
