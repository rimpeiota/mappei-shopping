import assert from 'node:assert/strict';
import test from 'node:test';
import type { FoodRecipe } from '../lib/client-food';

const { newItem, togglePurchased, recordPurchasedQuantity, finalizePurchaseDraft, validateState, emptyState } = await import(new URL('../lib/client-model.ts', import.meta.url).href) as typeof import('../lib/client-model');
const { compareFood, GRATIN_RECIPE } = await import(new URL('../lib/client-food.ts', import.meta.url).href) as typeof import('../lib/client-food');
const { setCurrentFood, addPurchasedFood, addFoodShortages, editedFoodIngredients, foodIngredientLine } = await import(new URL('../lib/client-food-actions.ts', import.meta.url).href) as typeof import('../lib/client-food-actions');
const date = '2026-10-28';
const milk = (quantity = 400): FoodRecipe => ({ title: 'テスト料理', url: 'https://example.com/recipe', servings: 2, ingredients: [{ name: '牛乳', quantity, unit: 'ml', note: '' }] });

test('current amount replaces all matching stock and spares while preserving purchase history and attachments', () => {
  const bought = newItem('玉ねぎ', { category: '食品', status: 'purchased', stock: 2, spare: 1, quantity: 2, purchasedQuantity: 2, purchasedAt: date,
    attachments: [{ id: 'receipt', name: 'receipt.jpg', url: '/api/attachments/receipt', type: 'image/jpeg' }], comment: '購入記録' });
  const older = newItem('玉葱', { category: '食品', inventoryOnly: true, stock: 3, checkedAt: '2026-10-27' });
  const unrelated = newItem('卵', { stock: 6, category: '食品' });
  const before = structuredClone([bought, older, unrelated]);
  const next = setCurrentFood([bought, older, unrelated], { name: '玉ねぎ', quantity: 1.5, unit: '個', note: '' }, '冷蔵庫', date);
  assert.deepEqual([bought, older, unrelated], before, 'the existing snapshot must not be mutated');
  assert.equal(next[0].stock, 0); assert.equal(next[0].spare, 0); assert.equal(next[1].stock, 0);
  assert.equal(next[0].purchasedAt, date); assert.equal(next[0].purchasedQuantity, 2); assert.equal(next[0].quantity, 2); assert.equal(next[0].status, 'purchased');
  assert.deepEqual(next[0].attachments, bought.attachments); assert.equal(next[0].comment, '購入記録'); assert.equal(next[2], unrelated);
  assert.equal(next[3].stock, 1.5); assert.equal(next[3].stockKnown, true); assert.equal(next[3].inventoryOnly, true); assert.equal(next[3].checkedAt, date);
});

test('today purchases are already included in a current total and are not added again', () => {
  const initial = addPurchasedFood([], { name: '牛乳', quantity: 500, unit: 'ml', note: '' }, '冷蔵庫', date);
  const next = setCurrentFood(initial, { name: '牛乳', quantity: 200, unit: 'ml', note: '' }, '冷蔵庫', date);
  assert.equal(next.reduce((sum, item) => sum + item.stock + item.spare, 0), 200);
  assert.equal(next[0].purchasedQuantity, 500); assert.equal(next[0].purchasedAt, date);
  assert.equal(compareFood(milk(), next)[0].shortage, 200);
});

test('unknown current quantity remains unknown instead of declaring stock to be zero', () => {
  const old = newItem('牛乳', { stock: 500, unit: 'ml', checkedAt: date });
  const next = setCurrentFood([old], { name: '牛乳', quantity: null, unit: 'ml', note: '' }, '冷蔵庫', date);
  assert.equal(next[0].stock, 0); assert.equal(next[1].stockKnown, false); assert.equal(next[1].stock, 0);
  const result = compareFood(milk(), next)[0];
  assert.equal(result.status, 'check'); assert.equal(result.toBuy, null);
});

test('a confirmed zero can be registered and exposes the full missing quantity', () => {
  const items = setCurrentFood([], { name: '牛乳', quantity: 0, unit: 'ml', note: '' }, '冷蔵庫', date);
  assert.equal(items[0].stockKnown, true); assert.equal(items[0].stock, 0); assert.equal(items[0].inventoryOnly, true);
  assert.equal(compareFood(milk(), items)[0].toBuy, 400);
});

test('a known purchase is added once to history and stock without changing other items', () => {
  const other = newItem('石けん', { stock: 1 });
  const next = addPurchasedFood([other], { name: '牛乳', quantity: 1000, unit: 'ml', note: '購入メモ' }, '冷蔵庫', date);
  assert.equal(next.length, 2); assert.equal(next[0], other);
  assert.equal(next[1].status, 'purchased'); assert.equal(next[1].quantity, 1000); assert.equal(next[1].stock, 1000); assert.equal(next[1].purchasedQuantity, 1000);
  assert.equal(next[1].purchasedAt, date); assert.equal(next[1].inventoryOnly, false); assert.equal(next[1].inventorySource, 'purchase'); assert.equal(next[1].stockKnown, true);
  assert.equal(next[1].location, '冷蔵庫'); assert.equal(next[1].comment, '購入メモ');
});

test('an unknown purchase does not invent a purchased quantity or usable stock', () => {
  const next = addPurchasedFood([], { name: '牛乳', quantity: null, unit: 'ml', note: '' }, '冷蔵庫', date);
  assert.equal(next[0].purchasedQuantity, 0); assert.equal(next[0].stock, 0); assert.equal(next[0].stockKnown, false);
  assert.equal(next[0].status, 'purchased'); assert.equal(compareFood(milk(), next)[0].status, 'check');
});

test('shortages are added as pending purchases and repeated addition adds nothing', () => {
  const stock = setCurrentFood([], { name: '牛乳', quantity: 200, unit: 'ml', note: '' }, '冷蔵庫', date);
  const next = addFoodShortages(stock, milk());
  assert.equal(next.length, 2); assert.equal(next[0], stock[0]);
  assert.equal(next[1].quantity, 200); assert.equal(next[1].unit, 'ml'); assert.equal(next[1].status, 'planned'); assert.equal(next[1].stock, 0);
  assert.equal(next[1].url, 'https://example.com/recipe'); assert.equal(next[0].stock, 200, 'comparing must not consume inventory');
  const repeated = addFoodShortages(next, milk());
  assert.equal(repeated, next); assert.equal(repeated.length, 2);
  assert.equal(compareFood(milk(), repeated)[0].planned, 200);
});

test('unconfirmed quantities and invalid input cannot become automatic purchases or inventory', () => {
  const items = [newItem('卵')];
  assert.equal(setCurrentFood(items, { name: '', quantity: 2, unit: '個', note: '' }, '', date), items);
  assert.equal(setCurrentFood(items, { name: '卵', quantity: Number.NaN, unit: '個', note: '' }, '', date), items);
  assert.equal(addPurchasedFood(items, { name: '卵', quantity: -1, unit: '個', note: '' }, '', date), items);
  assert.equal(addPurchasedFood(items, { name: '卵', quantity: 0, unit: '個', note: '' }, '', date), items);
  assert.equal(addFoodShortages(items, milk()), items);
  const unknownRecipe = { ...milk(), ingredients: [{ name: '牛乳', quantity: null, unit: 'ml', note: '適量' }] };
  assert.equal(addFoodShortages(items, unknownRecipe), items);
});


test('checking a newly planned shortage turns the bought amount into confirmed inventory', () => {
  const initial = setCurrentFood([], { name: '牛乳', quantity: 200, unit: 'ml', note: '' }, '冷蔵庫', date);
  const planned = addFoodShortages(initial, milk());
  assert.equal(planned[1].stockKnown, false);
  const checked = planned.map((item, index) => index === 1 ? togglePurchased(item) : item);
  assert.equal(checked[1].stockKnown, true);
  assert.equal(compareFood(milk(), checked)[0].have, 400);
  assert.equal(compareFood(milk(), checked)[0].status, 'enough');
  const partial = recordPurchasedQuantity(planned[1], 100);
  assert.equal(partial.stockKnown, true); assert.equal(partial.stock, 100);
});

test('current counts include imported purchases with no prior stock-confirmation date', () => {
  const imported = newItem('牛乳', { category: '食品', unit: 'ml', quantity: 1000, purchasedQuantity: 0, status: 'purchased' });
  const counted = setCurrentFood([imported], { name: '牛乳', quantity: 200, unit: 'ml', note: '' }, '冷蔵庫', date);
  assert.equal(counted[0].checkedAt, date);
  assert.equal(compareFood(milk(), counted)[0].status, 'shortage');
  assert.equal(compareFood(milk(), counted)[0].shortage, 200);
});

test('correcting an old purchase after a current count cannot replay its entire quantity', () => {
  const initial = addPurchasedFood([], { name: '牛乳', quantity: 1000, unit: 'ml', note: '' }, '冷蔵庫', date);
  const counted = setCurrentFood(initial, { name: '牛乳', quantity: 200, unit: 'ml', note: '' }, '冷蔵庫', date);
  assert.equal(counted[0].stockReconciledQuantity, 1000);
  counted[0] = togglePurchased(togglePurchased(counted[0]));
  assert.equal(compareFood(milk(), counted)[0].have, 200);
  const roundTrip = validateState({ ...emptyState(), items: counted })!;
  assert.equal(roundTrip.items[0].stockReconciledQuantity, 1000);
  assert.equal(compareFood(milk(), roundTrip.items)[0].shortage, 200);
  const partial = newItem('牛乳', { quantity: 1000, purchasedQuantity: 500, unit: 'ml', stock: 500, status: 'cart' });
  const current = setCurrentFood([partial], { name: '牛乳', quantity: 200, unit: 'ml', note: '' }, '冷蔵庫', date);
  current[0] = recordPurchasedQuantity(current[0], 1000);
  assert.equal(compareFood(milk(800), current)[0].have, 700, 'only the newly bought 500ml is added');
  const manualDraft = { ...current[0], purchasedQuantity: 1000, stock: 250 };
  const saved = finalizePurchaseDraft(current[0], manualDraft, true);
  assert.equal(saved.stock, 250); assert.equal(saved.stockReconciledQuantity, 1000);
});

test('editing one recipe line keeps unedited compound and purpose notes intact', () => {
  const lines = GRATIN_RECIPE.ingredients.map(foodIngredientLine).join('\n').replace('マカロニ：60g', 'マカロニ：80g');
  const edited = editedFoodIngredients(GRATIN_RECIPE, lines);
  assert.equal(edited.length, 12);
  assert.deepEqual(edited.find(item => item.name === 'バター'), GRATIN_RECIPE.ingredients.find(item => item.name === 'バター'));
  assert.equal(edited.find(item => item.name === 'マカロニ')?.quantity, 80);
  assert.deepEqual(edited.find(item => item.name === '小麦粉'), GRATIN_RECIPE.ingredients.find(item => item.name === '小麦粉'));
});
