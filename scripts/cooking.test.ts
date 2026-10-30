import assert from 'node:assert/strict';
import test from 'node:test';
import type { FoodRecipe } from '../lib/client-food';
const { planCooking, applyCooking, undoCooking, validateCookingHistory, cookingRecipeKey } = await import(new URL('../lib/client-cooking.ts', import.meta.url).href) as typeof import('../lib/client-cooking');
const { newItem, togglePurchased, recordPurchasedQuantity } = await import(new URL('../lib/client-model.ts', import.meta.url).href) as typeof import('../lib/client-model');
const { setCurrentFood, addPurchasedFood } = await import(new URL('../lib/client-food-actions.ts', import.meta.url).href) as typeof import('../lib/client-food-actions');

const AT = '2026-10-31T09:00:00.000Z';
const LATER = '2026-10-31T09:01:00.000Z';
const recipe = (name = '牛乳', quantity: number | null = 400, unit = 'ml', servings: number | null = 2): FoodRecipe => ({
  title: '確認用の料理', url: '', servings, ingredients: [{ name, quantity, unit, note: '' }],
});
const stock = (name = '牛乳', quantity = 1, unit = 'L') => newItem(name, {
  stock: quantity, spare: 0, unit, stockKnown: true, inventoryOnly: true, checkedAt: '2026-10-30',
});

test('cooking preview converts litres and grams and leaves the inputs untouched', () => {
  const milk = stock(); const flour = stock('小麦粉', 50, 'g');
  const data = recipe('牛乳', 800, 'ml', 4);
  data.ingredients.push({ name: '小麦粉', quantity: .06, unit: 'kg', note: '' });
  const before = structuredClone([milk, flour]);
  const plan = planCooking(data, [milk, flour]);
  assert.deepEqual(plan.rows.map(row => [row.status, row.quantity, row.before, row.after]), [
    ['ready', 400, 1000, 600], ['ready', .03, .05, .02],
  ]);
  assert.deepEqual([milk, flour], before);
  const result = applyCooking([milk, flour], [], data, 2, 'meal-1', AT);
  assert.equal(result.error, undefined);
  assert.equal(result.items[0].stock, .6); assert.equal(result.items[1].stock, 20);
});

test('fractional duplicate ingredients are aggregated once using conservative aliases', () => {
  const data = recipe('玉ねぎ', .25, '個');
  data.ingredients.push({ name: '玉葱', quantity: .5, unit: '個', note: '仕上げ' });
  const item = stock('たまねぎ', 1, '個');
  const result = applyCooking([item], [], data, 2, 'onion', AT);
  assert.equal(result.record!.rows.length, 1); assert.equal(result.record!.rows[0].quantity, .75);
  assert.equal(result.items[0].stock, .25); assert.equal(result.record!.changes.length, 1);
});

test('all locations current stock is consumed before any spare in deterministic item order', () => {
  const first = { ...stock('牛乳', .1, 'L'), spare: .3, location: '冷蔵庫' };
  const second = { ...stock('牛乳', 300, 'ml'), spare: 200, location: '食品ストック棚' };
  const result = applyCooking([first, second], [], recipe('牛乳', 500), 2, 'locations', AT);
  assert.deepEqual(result.items.map(item => [item.stock, item.spare]), [[0, .2], [0, 200]]);
  assert.deepEqual(result.items.map(item => item.location), ['冷蔵庫', '食品ストック棚']);
  assert.equal(result.record!.rows[0].before, 900); assert.equal(result.record!.rows[0].after, 400);
});

test('unknown and incompatible inventory never gets consumed when known inventory suffices', () => {
  const unknown = { ...stock(), stockKnown: false };
  const packet = stock('牛乳', 1, '本');
  const known = stock('牛乳', 500, 'ml');
  const result = applyCooking([unknown, packet, known], [], recipe(), 2, 'known-only', AT);
  assert.equal(result.items[0], unknown); assert.equal(result.items[1], packet);
  assert.equal(result.items[2].stock, 100); assert.equal(result.record!.changes.length, 1);
});

test('shortage is skipped in full and shopping plans do not pretend to be current stock', () => {
  const milk = stock('牛乳', 100, 'ml');
  const planned = newItem('牛乳', { quantity: 1000, unit: 'ml', stockKnown: false });
  const result = applyCooking([milk, planned], [], recipe(), 2, 'shortage', AT);
  assert.ok(result.error); assert.equal(result.items[0].stock, 100); assert.equal(result.history.length, 0);
  const [row] = planCooking(recipe(), [milk, planned]).rows;
  assert.equal(row.status, 'check'); assert.equal(row.before, row.after); assert.deepEqual(row.changes, []);
});

test('unregistered, unconfirmed, empty units, vague and incompatible amounts all require review', () => {
  const cases: [FoodRecipe, ReturnType<typeof stock>[]][] = [
    [recipe(), []], [recipe(), [{ ...stock(), stockKnown: false }]],
    [recipe('牛乳', 1, ''), [stock('牛乳', 10, '')]],
    [recipe('塩', null, 'g'), [stock('塩', 100, 'g')]],
    [recipe('鶏もも肉', 1, '枚'), [stock('鶏もも肉', 300, 'g')]],
    [recipe('牛乳', 400, 'ml', null), [stock()]],
  ];
  for (const [data, items] of cases) {
    const plan = planCooking(data, items);
    assert.ok(plan.rows.every(row => row.status === 'check')); assert.equal(plan.changes.length, 0);
  }
});

test('an explicit zero ingredient is skipped instead of creating a fake stock mutation', () => {
  const plan = planCooking(recipe('玉ねぎ', 0, '個'), []);
  assert.equal(plan.rows[0].status, 'check'); assert.match(plan.rows[0].detail, /0/);
  assert.equal(plan.changes.length, 0);
});

test('known and vague duplicate ingredient skips the entire material, while other materials can commit', () => {
  const data = recipe('バター', 30, 'g');
  data.ingredients.push({ name: 'バター', quantity: null, unit: 'g', note: '炒め用適量' }, { name: '牛乳', quantity: 400, unit: 'ml', note: '' });
  const items = [stock('バター', 100, 'g'), stock()];
  const result = applyCooking(items, [], data, 2, 'partial', AT);
  assert.equal(result.items[0], items[0]); assert.equal(result.items[1].stock, .6);
  assert.equal(result.record!.rows[0].status, 'check'); assert.match(result.record!.rows[0].detail, /適量/);
  assert.equal(result.record!.rows[1].status, 'ready');
});

test('a saved receipt ID is idempotent after reload and even after its undo', () => {
  const first = applyCooking([stock()], [], recipe(), 2, 'same-action', AT);
  const reloaded = validateCookingHistory(JSON.parse(JSON.stringify(first.history)))!;
  const duplicate = applyCooking(first.items, reloaded, recipe(), 2, 'same-action', LATER);
  assert.equal(duplicate.items[0].stock, .6); assert.equal(duplicate.history.length, 1);
  const undone = undoCooking(duplicate.items, duplicate.history, 'same-action', LATER);
  const repeated = applyCooking(undone.items, undone.history, recipe(), 2, 'same-action', LATER);
  assert.equal(repeated.items[0].stock, 1); assert.equal(repeated.history.length, 1); assert.equal(repeated.record!.undoneAt, LATER);
  const fresh = applyCooking(undone.items, undone.history, recipe(), 2, 'new-explicit-action', LATER);
  assert.equal(fresh.items[0].stock, .6); assert.equal(fresh.history.length, 2);
});

test('apply recomputes after a preview so a later manual quantity reduction cannot go negative', () => {
  const item = stock(); assert.equal(planCooking(recipe(), [item]).rows[0].status, 'ready');
  const changed = { ...item, stock: .1 };
  const result = applyCooking([changed], [], recipe(), 2, 'stale-preview', AT);
  assert.ok(result.error); assert.equal(result.items[0].stock, .1); assert.deepEqual(result.history, []);
});

test('undo restores only touched inventory, preserving unrelated new purchases and metadata', () => {
  const original = { ...stock(), attachments: [{ id: 'a', name: 'receipt', url: '/api/files/a', type: 'image/png' }], comment: 'before' };
  const applied = applyCooking([original], [], recipe(), 2, 'undo', AT);
  const extra = stock('玉ねぎ', 2, '個');
  const edited = { ...applied.items[0], comment: 'after', location: '野菜室' };
  const result = undoCooking([edited, extra], applied.history, 'undo', LATER);
  assert.equal(result.error, undefined); assert.equal(result.items[0].stock, 1);
  assert.equal(result.items[0].comment, 'after'); assert.equal(result.items[0].location, '野菜室');
  assert.deepEqual(result.items[0].attachments, original.attachments); assert.equal(result.items[1], extra);
  assert.equal(result.record!.undoneAt, LATER);
  const twice = undoCooking(result.items, result.history, 'undo', LATER);
  assert.equal(twice.items, result.items);
});

test('undo refuses after any touched stock, food identity or purchase fields have changed', () => {
  const applied = applyCooking([stock()], [], recipe(), 2, 'guard', AT);
  for (const fields of [{ stock: .7 }, { spare: 1 }, { unit: 'ml' }, { name: '豆乳' }, { quantity: 2 },
    { purchasedQuantity: 1 }, { status: 'purchased' as const }, { purchasedAt: '2026-10-31' }, { stockKnown: false }, { checkedAt: '2026-11-01' }, { updatedAt: LATER }]) {
    const items = [{ ...applied.items[0], ...fields }];
    const result = undoCooking(items, applied.history, 'guard', LATER);
    assert.ok(result.error, JSON.stringify(fields)); assert.equal(result.items, items); assert.equal(result.history[0].undoneAt, '');
  }
  assert.ok(undoCooking([], applied.history, 'guard', LATER).error);
});

test('a later same-day total count cannot be double-counted by undoing fully consumed old rows', () => {
  const item = stock('玉ねぎ', 1, '個');
  const applied = applyCooking([item], [], recipe('玉ねぎ', 1, '個'), 2, 'used-up', AT);
  assert.equal(applied.items[0].stock, 0);
  const counted = setCurrentFood(applied.items, { name: '玉ねぎ', quantity: 5, unit: '個', note: '' }, '野菜室', '2026-10-31');
  assert.equal(counted[0].stock, 0); assert.equal(counted[1].stock, 5);
  const result = undoCooking(counted, applied.history, 'used-up', LATER);
  assert.ok(result.error); assert.equal(result.items, counted);
  assert.equal(result.items.reduce((sum, row) => sum + row.stock, 0), 5);
});

test('a newly added purchase row remains intact when the previous recipe is undone', () => {
  const applied = applyCooking([stock()], [], recipe(), 2, 'before-new-purchase', AT);
  const purchased = addPurchasedFood(applied.items, { name: '牛乳', quantity: 2, unit: 'L', note: '' }, '冷蔵庫', '2026-10-31');
  const result = undoCooking(purchased, applied.history, 'before-new-purchase', LATER);
  assert.equal(result.error, undefined); assert.equal(result.items[0].stock, 1); assert.equal(result.items[1].stock, 2);
  assert.equal(result.items[1], purchased[1]);
});

test('only the last active recipe is undoable, then the previous receipt can be undone', () => {
  const first = applyCooking([stock('牛乳', 2, 'L')], [], recipe(), 2, 'first', AT);
  const second = applyCooking(first.items, first.history, recipe(), 2, 'second', LATER);
  assert.ok(undoCooking(second.items, second.history, 'first', LATER).error);
  const undoSecond = undoCooking(second.items, second.history, 'second', LATER);
  const undoFirst = undoCooking(undoSecond.items, undoSecond.history, 'first', LATER);
  assert.equal(undoFirst.error, undefined); assert.equal(undoFirst.items[0].stock, 2);
});

test('old purchase check replay cannot replenish ingredients that have already been cooked', () => {
  const bought = { ...stock('牛乳', 1000, 'ml'), quantity: 1000, purchasedQuantity: 1000, status: 'purchased' as const, purchasedAt: '2026-10-31', inventoryOnly: false };
  const applied = applyCooking([bought], [], recipe(), 2, 'purchase', AT);
  assert.equal(applied.items[0].stock, 600); assert.equal(applied.items[0].stockReconciledQuantity, 1000);
  const unchecked = togglePurchased(applied.items[0]);
  assert.equal(unchecked.stock, 600);
  assert.ok(undoCooking([unchecked], applied.history, 'purchase', LATER).error);
  assert.equal(togglePurchased(unchecked).stock, 600);
  assert.equal(recordPurchasedQuantity(unchecked, 1000).stock, 600);
});

test('legacy completed purchases with no purchasedQuantity are also reconciled before cooking', () => {
  for (const status of ['purchased', 'received'] as const) {
    const legacy = { ...stock('玉ねぎ', 2, '個'), quantity: 2, purchasedQuantity: 0, status, inventoryOnly: false };
    const applied = applyCooking([legacy], [], recipe('玉ねぎ', 1, '個'), 2, `legacy-${status}`, AT);
    assert.equal(applied.items[0].stockReconciledQuantity, 2);
    assert.equal(togglePurchased(togglePurchased(applied.items[0])).stock, 1);
  }
});

test('purchase status, history and attachment metadata are preserved on cooking', () => {
  const item = { ...stock(), quantity: 3, purchasedQuantity: 1, purchasedAt: '2026-10-30', status: 'cart' as const,
    prices: [{ id: 'price', store: 'shop', price: 250, date: '2026-10-30', source: '' }],
    attachments: [{ id: 'file', name: 'file', type: 'image/jpeg', url: '/api/files/file' }] };
  const result = applyCooking([item], [], recipe(), 2, 'metadata', AT);
  for (const field of ['status', 'quantity', 'purchasedQuantity', 'purchasedAt', 'prices', 'attachments', 'inventoryOnly', 'inventorySource'] as const) assert.deepEqual(result.items[0][field], item[field]);
});

test('fraction rounding does not expose floating tails or invent a mutation below representable precision', () => {
  const data = recipe('玉ねぎ', .1, '個'); data.ingredients.push({ name: '玉ねぎ', quantity: .2, unit: '個', note: '' });
  const result = applyCooking([stock('玉ねぎ', .3, '個')], [], data, 2, 'fractions', AT);
  assert.equal(result.items[0].stock, 0); assert.equal(result.record!.rows[0].quantity, .3);
  const tiny = planCooking(recipe('小麦粉', 1e-10, 'g'), [stock('小麦粉', 1e9, 'g')]);
  assert.equal(tiny.changes.length, 0); assert.equal(tiny.rows[0].status, 'check');
});

test('invalid amounts, target servings and malformed receipt identifiers cannot change stock', () => {
  for (const quantity of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1e10]) assert.equal(planCooking(recipe('牛乳', quantity), [stock()]).changes.length, 0);
  for (const people of [0, -1, Number.NaN, 1001]) assert.ok(applyCooking([stock()], [], recipe(), people, 'bad', AT).error);
  assert.ok(applyCooking([stock()], [], recipe(), 2, '', AT).error);
  assert.ok(applyCooking([stock()], [], recipe(), 2, 'id', 'bad-time').error);
});

test('history validator rejects corrupt undo snapshots, mismatches, duplicate IDs and oversized journals', () => {
  const valid = applyCooking([stock()], [], recipe(), 2, 'validated', AT).history;
  assert.deepEqual(validateCookingHistory(valid), valid); assert.notEqual(validateCookingHistory(valid), valid);
  const changed = (mutate: (data: typeof valid) => void) => { const data = structuredClone(valid); mutate(data); assert.equal(validateCookingHistory(data), null); };
  changed(data => { data[0].changes[0].before.stock = -1; });
  changed(data => { data[0].changes[0].after.stock = 1e10; });
  changed(data => { data[0].changes[0].after.stock = .5; });
  changed(data => { data[0].rows[0].quantity = 200; });
  changed(data => { data[0].rows[0].changes = []; });
  changed(data => { data[0].changes.push(structuredClone(data[0].changes[0])); });
  changed(data => { data[0].rows[0].changes[0].after.stockReconciledQuantity = 3; });
  changed(data => { data[0].undoneAt = '2026-10-30T00:00:00.000Z'; });
  assert.equal(validateCookingHistory([valid[0], valid[0]]), null);
  assert.equal(validateCookingHistory(Array.from({ length: 51 }, (_, index) => ({ ...valid[0], id: `id-${index}` }))), null);
  assert.equal(validateCookingHistory({}), null); assert.deepEqual(validateCookingHistory([]), []);
});

test('history retention is bounded and recipe fingerprint changes with amounts and source', () => {
  const items = [stock('牛乳', 100, 'L')]; let history: NonNullable<ReturnType<typeof validateCookingHistory>> = [];
  let current = items;
  for (let index = 0; index < 51; index++) {
    const result = applyCooking(current, history, recipe('牛乳', 1, 'ml'), 2, `cook-${index}`, AT);
    assert.equal(result.error, undefined); current = result.items; history = result.history;
  }
  assert.equal(history.length, 50); assert.equal(history[0].id, 'cook-50'); assert.equal(history.at(-1)!.id, 'cook-1');
  assert.equal(cookingRecipeKey(recipe()), cookingRecipeKey(structuredClone(recipe())));
  assert.notEqual(cookingRecipeKey(recipe()), cookingRecipeKey(recipe('牛乳', 200)));
  const source = recipe(); source.url = 'https://example.com/recipe';
  assert.notEqual(cookingRecipeKey(recipe()), cookingRecipeKey(source));
});
