import assert from 'node:assert/strict';
import test from 'node:test';
import type { FoodRecipe } from '../lib/client-food';
const { parseFoodLines, foodKey, formatFoodQuantity, compareFood, GRATIN_RECIPE } = await import(new URL('../lib/client-food.ts', import.meta.url).href) as typeof import('../lib/client-food');
const { newItem } = await import(new URL('../lib/client-model.ts', import.meta.url).href) as typeof import('../lib/client-model');

const recipe = (name: string, quantity: number | null, unit = 'g', servings: number | null = 2): FoodRecipe => ({
  title: 'テスト用', url: '', servings, ingredients: [{ name, quantity, unit, note: '' }],
});
const stock = (name: string, quantity: number, unit = 'g') => newItem(name, {
  stock: quantity, spare: 0, stockKnown: true, inventoryOnly: true, checkedAt: '2026-10-28', unit,
});

test('food lines retain fractional, full width and zero quantities without a default of one', () => {
  const rows = parseFoodLines('- [ ] 玉ねぎ：１／４個\n椎茸 ０個\n牛乳 ０．５Ｌ\n鶏もも肉１枚\nニンニク 1かけ\n卵1パック');
  assert.deepEqual(rows.map(({ name, quantity, unit }) => ({ name, quantity, unit })), [
    { name: '玉ねぎ', quantity: .25, unit: '個' }, { name: '椎茸', quantity: 0, unit: '個' },
    { name: '牛乳', quantity: .5, unit: 'L' }, { name: '鶏もも肉', quantity: 1, unit: '枚' },
    { name: 'ニンニク', quantity: 1, unit: 'かけ' }, { name: '卵', quantity: 1, unit: 'パック' },
  ]);
});

test('half, a count plus half, spoon prefix and suffix and unicode fractions are parsed', () => {
  const rows = parseFoodLines('玉ねぎ 半分\n大根 半個\n白菜 1個半\n砂糖 大さじ1/2\n醤油 2小さじ\nにんじん ½本');
  assert.deepEqual(rows.map(({ quantity, unit }) => [quantity, unit]), [[.5, ''], [.5, '個'], [1.5, '個'], [.5, '大さじ'], [2, '小さじ'], [.5, '本']]);
});

test('vague amounts and bare material names remain unknown and preserve the source', () => {
  const rows = parseFoodLines('塩 少々\n白ワイン 適量\nチーズ：量の記載なし\n牛乳 あり\n黒胡椒');
  assert.deepEqual(rows.map(row => row.quantity), [null, null, null, null, null]);
  assert.deepEqual(rows.map(row => row.name), ['塩', '白ワイン', 'チーズ', '牛乳', '黒胡椒']);
  assert.equal(rows[0].note, '少々'); assert.equal(rows[3].note, 'あり'); assert.equal(rows[4].note, '量の記載なし');
});

test('compound amounts, ranges and invalid fractions are not silently reduced to one amount', () => {
  const rows = parseFoodLines('バター30g＋別途適量\n鶏肉100〜200g\n牛乳1L+500ml\n玉ねぎ1/0個\n小麦粉-30g\n牛乳 約400ml\n小麦粉1e3g');
  assert.deepEqual(rows.map(row => row.name), ['バター', '鶏肉', '牛乳', '玉ねぎ', '小麦粉', '牛乳', '小麦粉']);
  assert.ok(rows.every(row => row.quantity === null));
  assert.match(rows[0].note, /30g\+別途適量/); assert.match(rows[1].note, /100〜200g/);
});

test('headings, servings, links and an empty input do not become ingredients', () => {
  assert.deepEqual(parseFoodLines('材料（約2人前）\n# ベシャメルソース\n【仕上げ】\n2人分\nhttps://youtu.be/0VJNIVUSInk\n'), []);
  assert.deepEqual(parseFoodLines(''), []);
  const [row] = parseFoodLines('小麦粉30g（ベシャメルソース用）');
  assert.equal(row.quantity, 30); assert.equal(row.note, 'ベシャメルソース用');
});

test('known amounts support thousands separators and material separators', () => {
  const rows = parseFoodLines('牛乳1,000ml、玉ねぎ1個;小麦粉 0.5kg');
  assert.deepEqual(rows.map(row => row.quantity), [1000, 1, .5]);
  assert.equal(parseFoodLines('・牛乳200ml')[0].name, '牛乳');
});

test('material keys normalize spelling conservatively and preserve different food types', () => {
  assert.equal(foodKey('　たまねぎ '), foodKey('玉葱'));
  assert.equal(foodKey('タマネギ'), foodKey('玉ねぎ'));
  assert.equal(foodKey('にんにく'), foodKey('ニンニク'));
  assert.equal(foodKey('しいたけ'), foodKey('椎茸'));
  assert.equal(foodKey('黒胡椒'), foodKey('黒こしょう'));
  assert.notEqual(foodKey('鶏肉'), foodKey('鶏もも肉'));
  assert.notEqual(foodKey('胡椒'), foodKey('黒こしょう'));
  assert.notEqual(foodKey('小麦粉'), foodKey('薄力粉'));
});

test('quantity formatting preserves zero, units and unknown quantities', () => {
  assert.equal(formatFoodQuantity(.25, '個'), '0.25個');
  assert.equal(formatFoodQuantity(0, 'g'), '0g');
  assert.equal(formatFoodQuantity(.5, '大さじ'), '大さじ0.5');
  assert.equal(formatFoodQuantity(null, 'g'), '量を確認');
  assert.equal(formatFoodQuantity(Number.NaN, 'g'), '量を確認');
});

test('the user supplied gratin recipe has 12 materials and unresolved butter and seasoning amounts', () => {
  assert.equal(GRATIN_RECIPE.servings, 2); assert.equal(GRATIN_RECIPE.ingredients.length, 12);
  assert.equal(GRATIN_RECIPE.ingredients.find(row => row.name === '玉ねぎ')?.quantity, .25);
  assert.equal(GRATIN_RECIPE.ingredients.find(row => row.name === '牛乳')?.quantity, 400);
  assert.equal(GRATIN_RECIPE.ingredients.find(row => row.name === 'バター')?.quantity, null);
  assert.match(GRATIN_RECIPE.ingredients.find(row => row.name === 'バター')!.note, /30g.*適量/);
  assert.equal(GRATIN_RECIPE.ingredients.find(row => row.name === 'シュレッドチーズ')?.quantity, null);
});

test('required amount is scaled to two people and safe mass and volume conversions work', () => {
  const [milk] = compareFood(recipe('牛乳', 800, 'ml', 4), [stock('牛乳', .3, 'L')]);
  assert.equal(milk.required, 400); assert.equal(milk.have, 300); assert.equal(milk.shortage, 100);
  assert.equal(milk.toBuy, 100); assert.equal(milk.status, 'shortage');
  const [flour] = compareFood(recipe('小麦粉', .03, 'kg'), [stock('小麦粉', 50, 'g')]);
  assert.equal(flour.have, .05); assert.equal(flour.status, 'enough');
});

test('unregistered and untouched default zero stocks require confirmation', () => {
  const [unregistered] = compareFood(recipe('牛乳', 400, 'ml'), []);
  assert.equal(unregistered.status, 'check'); assert.equal(unregistered.toBuy, null); assert.equal(unregistered.shortage, null);
  const [untouched] = compareFood(recipe('牛乳', 400, 'ml'), [newItem('牛乳', { unit: 'ml' })]);
  assert.equal(untouched.status, 'check'); assert.equal(untouched.shortage, null);
});

test('explicit zero is a confirmed absence and old zero rows with other units do not block it', () => {
  const [row] = compareFood(recipe('牛乳', 400, 'ml'), [stock('牛乳', 0, '本'), stock('牛乳', 0, 'パック'), stock('牛乳', 100, 'ml')]);
  assert.equal(row.status, 'shortage'); assert.equal(row.have, 100); assert.equal(row.toBuy, 300);
  const [absent] = compareFood(recipe('牛乳', 400, 'ml'), [stock('牛乳', 0, '本')]);
  assert.equal(absent.status, 'shortage'); assert.equal(absent.toBuy, 400);
});

test('an item marked amount unknown cannot assert a shortage even if its stored numbers are positive', () => {
  const unknown = { ...stock('牛乳', 1, 'L'), stockKnown: false };
  const [row] = compareFood(recipe('牛乳', 400, 'ml'), [unknown]);
  assert.equal(row.status, 'check'); assert.equal(row.have, 0); assert.equal(row.toBuy, null);
  const [enough] = compareFood(recipe('牛乳', 400, 'ml'), [unknown, stock('牛乳', 500, 'ml')]);
  assert.equal(enough.status, 'enough'); assert.equal(enough.have, 500);
});

test('counts, packets, spoons and mass are not converted by guessing ingredient size or density', () => {
  const [packet] = compareFood(recipe('小麦粉', 30), [stock('小麦粉', 1, '袋')]);
  assert.equal(packet.status, 'check'); assert.equal(packet.toBuy, null);
  const [meat] = compareFood(recipe('鶏もも肉', 1, '枚'), [stock('鶏もも肉', 300, 'g')]);
  assert.equal(meat.status, 'check');
  const [spoon] = compareFood(recipe('小麦粉', 30), [stock('小麦粉', 3, '大さじ')]);
  assert.equal(spoon.status, 'check');
});

test('current stock plus spare is counted once without re-adding purchases from today or history', () => {
  const bought = newItem('牛乳', { status: 'purchased', quantity: 1000, purchasedQuantity: 1000, purchasedAt: '2026-10-28', stock: 200, spare: 100, unit: 'ml', stockKnown: true });
  const [row] = compareFood(recipe('牛乳', 400, 'ml'), [bought]);
  assert.equal(row.have, 300); assert.equal(row.planned, 0); assert.equal(row.toBuy, 100);
});

test('same material requirements are summed before stock is used and same spelling aliases match', () => {
  const data: FoodRecipe = { ...recipe('玉ねぎ', .5, '個'), ingredients: [
    { name: '玉ねぎ', quantity: .5, unit: '個', note: '' },
    { name: '玉葱', quantity: .75, unit: '個', note: '別用途' },
  ] };
  const rows = compareFood(data, [stock('たまねぎ', 1, '個')]);
  assert.equal(rows.length, 1); assert.equal(rows[0].required, 1.25); assert.equal(rows[0].have, 1); assert.equal(rows[0].toBuy, .25);
});

test('duplicate materials can sum convertible units but unknown or incompatible requirements need review', () => {
  const base = recipe('バター', 30, 'g');
  base.ingredients.push({ name: 'バター', quantity: .02, unit: 'kg', note: '' });
  assert.equal(compareFood(base, [stock('バター', 40)])[0].toBuy, 10);
  base.ingredients.push({ name: 'バター', quantity: null, unit: '', note: '炒め用適量' });
  const [vague] = compareFood(base, [stock('バター', 40)]);
  assert.equal(vague.status, 'check'); assert.equal(vague.required, null); assert.match(vague.detail, /適量/);
  const mismatched = recipe('バター', 30, 'g');
  mismatched.ingredients.push({ name: 'バター', quantity: 1, unit: '個', note: '' });
  assert.equal(compareFood(mismatched, [stock('バター', 40)])[0].status, 'check');
});

test('unbought planned quantities are separate from stock and deducted once to prevent duplicate shopping', () => {
  const partBought = newItem('玉ねぎ', { quantity: 3, purchasedQuantity: 1, stock: 1, stockKnown: true, checkedAt: '2026-10-28', unit: '個', status: 'cart' });
  const [row] = compareFood(recipe('玉ねぎ', 4, '個'), [partBought]);
  assert.equal(row.have, 1); assert.equal(row.shortage, 3); assert.equal(row.planned, 2); assert.equal(row.toBuy, 1);
  const planned = newItem('玉ねぎ', { quantity: 1, unit: '個', status: 'ordered', checkedAt: '2026-10-28' });
  const [covered] = compareFood(recipe('玉ねぎ', 4, '個'), [partBought, planned]);
  assert.equal(covered.have, 1); assert.equal(covered.planned, 3); assert.equal(covered.toBuy, 0);
});

test('adding the missing amount as a pure plan prevents another addition without making stock unknown', () => {
  const pantry = stock('牛乳', 100, 'ml');
  const [before] = compareFood(recipe('牛乳', 400, 'ml'), [pantry]);
  assert.equal(before.toBuy, 300);
  const newPlan = newItem('牛乳', { quantity: before.toBuy!, unit: 'ml', stock: 0, spare: 0, stockKnown: false, checkedAt: '', inventoryOnly: false, status: 'planned' });
  const [after] = compareFood(recipe('牛乳', 400, 'ml'), [pantry, newPlan]);
  assert.equal(after.status, 'shortage'); assert.equal(after.have, 100); assert.equal(after.planned, 300); assert.equal(after.toBuy, 0);
  const [onlyPlanned] = compareFood(recipe('牛乳', 400, 'ml'), [newPlan]);
  assert.equal(onlyPlanned.status, 'check'); assert.equal(onlyPlanned.shortage, null);
});

test('inventory only and complete rows are never counted as future purchases', () => {
  const rows = ['purchased', 'received', 'returned', 'exchanged', 'cancelled'].map(status => newItem('玉ねぎ', { quantity: 10, unit: '個', status: status as 'purchased', stockKnown: true, checkedAt: '2026-10-28' }));
  rows.push(stock('玉ねぎ', 0, '個'));
  const [row] = compareFood(recipe('玉ねぎ', 2, '個'), rows);
  assert.equal(row.planned, 0); assert.equal(row.toBuy, 2);
});

test('incompatible planned units require confirmation before more items are added', () => {
  const planned = newItem('牛乳', { quantity: 1, unit: '本', status: 'ordered', stockKnown: true, checkedAt: '2026-10-28' });
  const [row] = compareFood(recipe('牛乳', 400, 'ml'), [stock('牛乳', 100, 'ml'), planned]);
  assert.equal(row.status, 'check'); assert.equal(row.shortage, 300); assert.equal(row.toBuy, null);
});

test('unknown servings do not silently pretend to be two people and unknown recipe amounts stay unresolved', () => {
  const [people] = compareFood(recipe('牛乳', 400, 'ml', null), [stock('牛乳', 500, 'ml')]);
  assert.equal(people.required, null); assert.equal(people.status, 'check');
  const [vague] = compareFood(recipe('塩', null), [stock('塩', 500)]);
  assert.equal(vague.required, null); assert.equal(vague.status, 'check');
});

test('food categories and unrelated names do not create a false match', () => {
  const flour = { ...stock('小麦粉', 30), category: 'その他' };
  assert.equal(compareFood(recipe('小麦粉', 30), [flour])[0].status, 'enough');
  assert.equal(compareFood(recipe('鶏もも肉', 1, '枚'), [stock('鶏肉', 2, '枚')])[0].status, 'check');
});

test('fraction sums do not expose floating point tails and explicit zero needs no purchase', () => {
  const data = recipe('玉ねぎ', .1, '個'); data.ingredients.push({ name: '玉ねぎ', quantity: .2, unit: '個', note: '' });
  const [row] = compareFood(data, [stock('玉ねぎ', .3, '個')]);
  assert.equal(row.required, .3); assert.equal(row.shortage, 0); assert.equal(row.status, 'enough');
  const [zero] = compareFood(recipe('玉ねぎ', 0, '個'), []);
  assert.equal(zero.status, 'enough'); assert.equal(zero.toBuy, 0);
});

test('invalid or unreasonably large amounts never produce non-finite or negative shopping quantities', () => {
  const [row] = compareFood(recipe('牛乳', Number.POSITIVE_INFINITY, 'ml'), [stock('牛乳', 100, 'ml')]);
  assert.equal(row.status, 'check'); assert.equal(row.toBuy, null);
  const [scaled] = compareFood(recipe('小麦粉', 1e9, 'g', 1), [stock('小麦粉', 0)], 20);
  assert.equal(scaled.required, null); assert.equal(scaled.status, 'check');
  assert.equal(parseFoodLines('小麦粉999999999999999999999g')[0].quantity, null);
});
