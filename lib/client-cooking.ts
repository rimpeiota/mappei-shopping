import { compareFood, convertFoodQuantity, foodKey, type FoodRecipe } from './client-food.ts';
import type { ShoppingItem } from './client-model';

export type CookingSnapshot = Pick<ShoppingItem, 'stock' | 'spare' | 'unit' | 'stockKnown' | 'checkedAt' | 'stockReconciledQuantity'
  | 'name' | 'quantity' | 'purchasedQuantity' | 'status' | 'purchasedAt' | 'updatedAt'>;
export type CookingChange = { itemId: string; before: CookingSnapshot; after: CookingSnapshot };
export type CookingRow = {
  name: string; quantity: number | null; unit: string; before: number; after: number;
  status: 'ready' | 'check'; detail: string; changes: CookingChange[];
};
export type CookingPlan = { recipeKey: string; title: string; targetServings: number; rows: CookingRow[]; changes: CookingChange[] };
export type CookingRecord = CookingPlan & { id: string; at: string; undoneAt: string };
export type CookingResult = { items: ShoppingItem[]; history: CookingRecord[]; record?: CookingRecord; error?: string };

const MAX_AMOUNT = 1e9;
const clean = (value: number) => Number(value.toPrecision(12));
const amount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_AMOUNT;
const close = (a: number, b: number) => a === b || Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-10;
const snapshot = (item: ShoppingItem): CookingSnapshot => ({ stock: item.stock, spare: item.spare, unit: item.unit,
  stockKnown: item.stockKnown, checkedAt: item.checkedAt, stockReconciledQuantity: item.stockReconciledQuantity,
  name: item.name, quantity: item.quantity, purchasedQuantity: item.purchasedQuantity, status: item.status, purchasedAt: item.purchasedAt, updatedAt: item.updatedAt });
const sameSnapshot = (a: CookingSnapshot, b: CookingSnapshot) => a.stock === b.stock && a.spare === b.spare && a.unit === b.unit
  && a.stockKnown === b.stockKnown && a.checkedAt === b.checkedAt && a.stockReconciledQuantity === b.stockReconciledQuantity
  && a.name === b.name && a.quantity === b.quantity && a.purchasedQuantity === b.purchasedQuantity && a.status === b.status && a.purchasedAt === b.purchasedAt && a.updatedAt === b.updatedAt;
const inventoryFields = ({ stock, spare, unit, stockKnown, checkedAt, stockReconciledQuantity, updatedAt }: CookingSnapshot) => ({ stock, spare, unit, stockKnown, checkedAt, stockReconciledQuantity, updatedAt });
const sameChange = (a: CookingChange, b: CookingChange) => a.itemId === b.itemId && sameSnapshot(a.before, b.before) && sameSnapshot(a.after, b.after);

/** A compact, deterministic identity for display matching; receipt IDs guard mutations. */
export function cookingRecipeKey(recipe: FoodRecipe): string {
  const text = JSON.stringify([recipe.title, recipe.url, recipe.servings,
    recipe.ingredients.map(row => [row.name, row.quantity, row.unit, row.note])]);
  let first = 2166136261, second = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `recipe-v1:${text.length}:${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

/** Preview only: neither recipe comparison nor this function changes inventory. */
export function planCooking(recipe: FoodRecipe, items: ShoppingItem[], targetServings = 2): CookingPlan {
  const rows: CookingRow[] = compareFood(recipe, items, targetServings).map(row => {
    const base = { name: row.name, quantity: row.required, unit: row.unit, before: row.have, after: row.have };
    const skip = (detail: string): CookingRow => ({ ...base, status: 'check', detail, changes: [] });
    if (row.required === null) return skip(row.detail);
    if (row.required === 0) return skip('使用量が0のため変更しません');
    if (!row.unit.trim()) return skip('材料と在庫の単位を確認してください。今回は減らしません');
    const matches = items.filter(item => foodKey(item.name) === foodKey(row.name));
    if (!matches.length) return skip('在庫が未登録のため減らしません');
    const candidates = matches.filter(item => item.stockKnown && amount(item.stock) && amount(item.spare)
      && (item.stock > 0 || item.spare > 0 || !!item.checkedAt)
      && convertFoodQuantity(item.stock + item.spare, item.unit, row.unit) !== null);
    if (row.have < row.required) {
      const unresolved = matches.some(item => item.stockKnown === false || !amount(item.stock) || !amount(item.spare)
        || ((item.stock > 0 || item.spare > 0) && convertFoodQuantity(item.stock + item.spare, item.unit, row.unit) === null)
        || (!item.checkedAt && item.stock === 0 && item.spare === 0));
      return skip(unresolved ? '在庫の量・単位を確認してください。今回は減らしません' : '在庫が不足しています。今回は減らしません');
    }
    let remaining = row.required;
    const drafted = new Map<string, CookingChange>();
    // Use opened/current stock at every location before touching any spare stock.
    for (const field of ['stock', 'spare'] as const) {
      for (const item of candidates) {
        if (remaining === 0) break;
        const change = drafted.get(item.id) || { itemId: item.id, before: snapshot(item), after: snapshot(item) };
        const available = change.after[field];
        const availableInRecipeUnit = convertFoodQuantity(available, item.unit, row.unit);
        if (!available || availableInRecipeUnit === null || availableInRecipeUnit === 0) continue;
        const used = Math.min(remaining, availableInRecipeUnit);
        const usedInItemUnit = convertFoodQuantity(used, row.unit, item.unit);
        if (usedInItemUnit === null) continue;
        change.after[field] = clean(Math.max(0, available - Math.min(available, usedInItemUnit)));
        change.after.stockReconciledQuantity = Math.max(item.stockReconciledQuantity, item.purchasedQuantity,
          item.status === 'purchased' || item.status === 'received' ? item.quantity : 0);
        drafted.set(item.id, change);
        remaining = used === remaining ? 0 : clean(remaining - used);
      }
    }
    const changes = [...drafted.values()].filter(change => change.before.stock !== change.after.stock || change.before.spare !== change.after.spare);
    let consumed = 0;
    for (const change of changes) {
      const delta = clean(change.before.stock - change.after.stock + change.before.spare - change.after.spare);
      const converted = convertFoodQuantity(delta, change.before.unit, row.unit);
      if (converted === null) return skip('数量を安全に計算できないため減らしません');
      consumed = clean(consumed + converted);
    }
    if (remaining !== 0 || !changes.length || !close(consumed, row.required)) return skip('数量を安全に計算できないため減らしません');
    return { ...base, after: clean(Math.max(0, row.have - row.required)), status: 'ready', detail: 'この量を在庫から減らします', changes };
  });
  return { recipeKey: cookingRecipeKey(recipe), title: recipe.title, targetServings, rows, changes: rows.flatMap(row => row.changes) };
}

/** Recompute against current inventory on the single commit path; never trust an old preview. */
export function applyCooking(items: ShoppingItem[], history: CookingRecord[], recipe: FoodRecipe, targetServings: number, id: string, at = new Date().toISOString()): CookingResult {
  if (!validateCookingHistory(history)) return { items, history, error: '料理の記録を読み込めません。再読み込みしてください' };
  const existing = history.find(record => record.id === id);
  if (existing) return { items, history, record: existing };
  if (!text(id, 200, true) || !timestamp(at) || !amount(targetServings) || targetServings <= 0 || targetServings > 1000) return { items, history, error: '料理の人数・記録を確認してください' };
  const plan = planCooking(recipe, items, targetServings);
  if (!plan.changes.length) return { items, history, error: '減らせる材料がありません。使用量と在庫を確認してください' };
  const checkedAt = new Date(at).toLocaleDateString('sv-SE');
  const changes = plan.changes.map(change => ({ ...change, after: { ...change.after, checkedAt, updatedAt: at } }));
  const byId = new Map(changes.map(change => [change.itemId, change]));
  const record: CookingRecord = { ...plan, id, at, undoneAt: '', changes,
    rows: plan.rows.map(row => ({ ...row, changes: row.changes.map(change => byId.get(change.itemId)!) })) };
  if (!validateCookingHistory([record])) return { items, history, error: '数量を安全に記録できないため変更しませんでした' };
  return { items: items.map(item => byId.has(item.id) ? { ...item, ...inventoryFields(byId.get(item.id)!.after), updatedAt: at } : item),
    history: [record, ...history].slice(0, 50), record };
}

/** Undo only the last active receipt and only while its exact stock fields remain unchanged. */
export function undoCooking(items: ShoppingItem[], history: CookingRecord[], id: string, at = new Date().toISOString()): CookingResult {
  if (!validateCookingHistory(history) || !timestamp(at)) return { items, history, error: '料理の記録を読み込めません。再読み込みしてください' };
  const record = history.find(entry => entry.id === id);
  if (!record) return { items, history, error: '取り消す料理の記録が見つかりません' };
  if (record.undoneAt) return { items, history, record };
  if (history.find(entry => !entry.undoneAt)?.id !== id) return { items, history, error: '直前の料理から順番に取り消してください' };
  const byId = new Map(items.map(item => [item.id, item]));
  if (record.changes.some(change => !byId.has(change.itemId) || !sameSnapshot(snapshot(byId.get(change.itemId)!), change.after))) {
    return { items, history, error: 'この料理のあとに対象データが変更されています。現在量を確認して修正してください' };
  }
  const changes = new Map(record.changes.map(change => [change.itemId, change]));
  const undone = { ...record, undoneAt: at };
  if (Date.parse(at) < Date.parse(record.at)) return { items, history, error: '取り消し時刻を確認してください' };
  // Restore the prior stamp too, so the preceding cooking receipt remains undoable.
  return { items: items.map(item => changes.has(item.id) ? { ...item, ...inventoryFields(changes.get(item.id)!.before) } : item),
    history: history.map(entry => entry.id === id ? undone : entry), record: undone };
}

function object(input: unknown): input is Record<string, unknown> { return !!input && typeof input === 'object' && !Array.isArray(input); }
function keys(input: Record<string, unknown>, expected: string[]) { return Object.keys(input).length === expected.length && expected.every(key => Object.hasOwn(input, key)); }
function text(input: unknown, limit: number, required = false): input is string { return typeof input === 'string' && input.length <= limit && (!required || input.trim().length > 0); }
function timestamp(input: unknown): input is string { return text(input, 100, true) && Number.isFinite(Date.parse(input)); }
function validSnapshot(input: unknown): input is CookingSnapshot {
  return object(input) && keys(input, ['stock', 'spare', 'unit', 'stockKnown', 'checkedAt', 'stockReconciledQuantity', 'name', 'quantity', 'purchasedQuantity', 'status', 'purchasedAt', 'updatedAt'])
    && amount(input.stock) && amount(input.spare) && amount(input.stockReconciledQuantity)
    && text(input.unit, 2000) && typeof input.stockKnown === 'boolean' && text(input.checkedAt, 2000)
    && text(input.name, 500, true) && amount(input.quantity) && input.quantity > 0 && amount(input.purchasedQuantity)
    && typeof input.status === 'string' && ['planned', 'considering', 'cart', 'ordered', 'purchased', 'received', 'snoozed', 'returned', 'exchanged', 'cancelled'].includes(input.status)
    && text(input.purchasedAt, 2000) && text(input.updatedAt, 2000);
}
function validChange(input: unknown): input is CookingChange {
  if (!object(input) || !keys(input, ['itemId', 'before', 'after']) || !text(input.itemId, 200, true)
    || !validSnapshot(input.before) || !validSnapshot(input.after)) return false;
  const { before, after } = input;
  return before.unit === after.unit && before.name === after.name && before.quantity === after.quantity
    && before.purchasedQuantity === after.purchasedQuantity && before.status === after.status && before.purchasedAt === after.purchasedAt
    && before.stockKnown && after.stockKnown
    && after.stock <= before.stock && after.spare <= before.spare
    && (after.stock < before.stock || after.spare < before.spare)
    && after.stockReconciledQuantity === Math.max(before.stockReconciledQuantity, before.purchasedQuantity,
      before.status === 'purchased' || before.status === 'received' ? before.quantity : 0);
}

/** Fail closed instead of dropping stock snapshots that may still be needed for undo. */
export function validateCookingHistory(input: unknown): CookingRecord[] | null {
  if (!Array.isArray(input) || input.length > 50) return null;
  const ids = new Set<string>();
  for (const record of input) {
    if (!object(record) || !keys(record, ['recipeKey', 'title', 'targetServings', 'rows', 'changes', 'id', 'at', 'undoneAt'])
      || !text(record.id, 200, true) || ids.has(record.id) || !text(record.title, 500, true)
      || !text(record.recipeKey, 100, true) || !/^recipe-v1:\d+:[0-9a-f]{16}$/.test(record.recipeKey)
      || !amount(record.targetServings) || record.targetServings <= 0 || record.targetServings > 1000
      || !timestamp(record.at) || !(record.undoneAt === '' || (timestamp(record.undoneAt) && Date.parse(record.undoneAt) >= Date.parse(record.at)))
      || !Array.isArray(record.rows) || record.rows.length === 0 || record.rows.length > 100
      || !Array.isArray(record.changes) || record.changes.length === 0 || record.changes.length > 10000
      || !record.changes.every(validChange)) return null;
    ids.add(record.id);
    const globalChanges = record.changes as CookingChange[];
    if (new Set(globalChanges.map(change => change.itemId)).size !== globalChanges.length
      || globalChanges.some(change => change.after.updatedAt !== record.at)) return null;
    const rowChanges: CookingChange[] = [];
    const names = new Set<string>();
    for (const row of record.rows) {
      if (!object(row) || !keys(row, ['name', 'quantity', 'unit', 'before', 'after', 'status', 'detail', 'changes'])
        || !text(row.name, 500, true) || names.has(foodKey(row.name)) || !text(row.unit, 2000)
        || !(row.quantity === null || amount(row.quantity)) || !amount(row.before) || !amount(row.after)
        || !text(row.detail, 3000) || !Array.isArray(row.changes) || !row.changes.every(validChange)) return null;
      names.add(foodKey(row.name));
      if (row.status === 'check') {
        if (row.before !== row.after || row.changes.length !== 0) return null;
      } else if (row.status === 'ready') {
        if (!amount(row.quantity) || row.quantity <= 0 || row.before < row.quantity
          || !close(clean(row.before - row.quantity), row.after) || row.changes.length === 0) return null;
        let consumed = 0;
        for (const change of row.changes as CookingChange[]) {
          if (foodKey(change.before.name) !== foodKey(row.name)) return null;
          const delta = clean(change.before.stock - change.after.stock + change.before.spare - change.after.spare);
          const converted = convertFoodQuantity(delta, change.before.unit, row.unit);
          if (converted === null) return null;
          consumed = clean(consumed + converted);
          rowChanges.push(change);
        }
        if (!close(consumed, row.quantity)) return null;
      } else return null;
    }
    if (rowChanges.length !== globalChanges.length || rowChanges.some((change, index) => !sameChange(change, globalChanges[index]))) return null;
  }
  return structuredClone(input) as CookingRecord[];
}
