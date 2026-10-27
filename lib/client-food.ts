import type { ShoppingItem } from './client-model';

export type FoodAmount = { name: string; quantity: number | null; unit: string; note: string };
export type FoodRecipe = { title: string; url: string; servings: number | null; ingredients: FoodAmount[] };
export type FoodComparison = {
  name: string; required: number | null; unit: string; have: number; shortage: number | null;
  planned: number; toBuy: number | null; status: 'enough' | 'shortage' | 'check'; detail: string;
};

const MAX_AMOUNT = 1e9;
const NUMBER = '(?:\\d+\\s*/\\s*\\d+|\\d+(?:\\.\\d+)?|\\.\\d+|半分|半)';
const UNIT = '(?:大さじ|小さじ|パック|かけ|kg|ml|個|枚|本|袋|箱|缶|合|g|L|l)';
const quantityLast = new RegExp(`^(.+?)\\s*(${NUMBER})\\s*(${UNIT})?(半)?$`, 'i');
const spoonFirst = new RegExp(`^(.+?)\\s*(大さじ|小さじ)\\s*(${NUMBER})$`);
const amountStart = new RegExp(`(?:(?:約|およそ)\\s*${NUMBER}\\s*${UNIT}|[+-]?\\d+(?:\\.\\d+)?[eE][+-]?\\d+\\s*${UNIT}|[+-]?\\d+(?:\\.\\d+)?(?:\\s*/\\s*\\d+)?\\s*${UNIT}|${UNIT}\\s*${NUMBER}|\\d+(?:\\.\\d+)?(?=\\s*[〜~+/-])|半分|半個|適量|少々|量の記載なし|記載なし|数量不明|不明|あり)`,'i');
const completeStatuses = new Set(['purchased', 'received', 'returned', 'exchanged', 'cancelled']);
const sameNames: Record<string, string> = {
  玉葱: '玉ねぎ', たまねぎ: '玉ねぎ', タマネギ: '玉ねぎ',
  にんにく: 'ニンニク', 大蒜: 'ニンニク',
  しいたけ: '椎茸', シイタケ: '椎茸', しい茸: '椎茸',
  黒胡椒: '黒こしょう', 黒コショウ: '黒こしょう',
  こしょう: '胡椒', コショウ: '胡椒',
};

const cleanNumber = (value: number) => Number(value.toPrecision(12));
const validAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_AMOUNT;
const safeSum = (a: number, b: number) => validAmount(a + b) ? cleanNumber(a + b) : null;
function normalizedUnit(unit: string): string {
  const value = unit.normalize('NFKC').replace(/\s/g, '');
  if (/^kg$/i.test(value)) return 'kg';
  if (/^g$/i.test(value)) return 'g';
  if (/^ml$/i.test(value)) return 'ml';
  if (/^l$/i.test(value)) return 'L';
  return value;
}
function readNumber(text: string): number | null {
  if (text === '半分' || text === '半') return .5;
  const parts = text.replace(/\s/g, '').split('/');
  const value = parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : Number(parts[0]);
  return validAmount(value) ? cleanNumber(value) : null;
}
function cleanName(name: string): string {
  return name.trim().replace(/[\s:：・.。]+$/u, '').trim().slice(0, 500);
}

/** Conservative name matching: different cuts, brands and types are never guessed to be equivalent. */
export function foodKey(name: string): string {
  const value = name.normalize('NFKC').trim().replace(/\s/g, '').toLowerCase();
  return sameNames[value] ?? value;
}

/** Parses material lines without inventing a default quantity or interpreting compound amounts. */
export function parseFoodLines(text: string): FoodAmount[] {
  const normalized = text.slice(0, 30000).normalize('NFKC').replace(/⁄/g, '/').replace(/\r\n?/g, '\n')
    .replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, '');
  const result: FoodAmount[] = [];
  for (let line of normalized.split(/[\n、,;；]+/u).slice(0, 200)) {
    line = line.slice(0, 1500).trim().replace(/^(?:[-*]\s+|[•・●☐☑]\s*)/u, '').replace(/^\[[ xX]\]\s*/u, '').replace(/^\d+[.)]\s+/u, '').trim();
    if (!line || /https?:\/\//i.test(line) || /^#/u.test(line) || /^[-=*\s]+$/u.test(line)) continue;
    if (/^(?:材料|食材|作り方|手順|調理方法|分量|人数|冷蔵庫(?:の中)?|今あるもの|今日買ったもの|購入品)(?:\s|[:(]|$)/u.test(line)
      || /^(?:約?\d+(?:[〜~]\d+)?人(?:分|前)|[【\[].+[】\]]|\([^\d]+\))$/u.test(line)) continue;
    line = line.replace(/^(?:\([A-Z]\)|[A-Z][.:])\s*/u, '');

    // A purpose note is safe to preserve; a second amount in parentheses is not an exact conversion.
    let note = '';
    const annotation = line.match(/\s*\(([^\d半]+)\)\s*$/u);
    if (annotation) { note = annotation[1].trim(); line = line.slice(0, annotation.index).trim(); }
    const spoon = line.match(spoonFirst);
    const amount = spoon ? null : line.match(quantityLast);
    if (spoon || amount) {
      const match = (spoon || amount)!;
      const name = cleanName(match[1]);
      const quantityText = spoon ? match[3] : match[2];
      const unitText = spoon ? match[2] : (match[3] || '');
      let quantity = readNumber(quantityText);
      const extraHalf = !spoon && !!match[4];
      if (extraHalf) quantity = quantity !== null && /^\d+$/.test(quantityText) && unitText !== '' ? safeSum(quantity, .5) : null;
      // Ranges, additions and negative amounts must not turn into a different ingredient name.
      const unsafeName = /[\d/+~〜-]$|\d[eE]$|約$|およそ$/u.test(name) || amountStart.test(name);
      // A bare final number requires a separator; model numbers stay part of an unknown name.
      const separatedNumber = unitText !== '' || /(?:\s|:)\s*(?:[\d.]|半)/u.test(line) || /半分$|半$/u.test(line);
      if (name && !unsafeName && separatedNumber && quantity !== null) {
        result.push({ name, quantity, unit: normalizedUnit(unitText), note });
        continue;
      }
    }

    const colon = line.indexOf(':');
    const uncertain = line.search(amountStart);
    const split = colon > 0 && (uncertain < 0 || colon < uncertain) ? colon : uncertain;
    const name = cleanName(split > 0 ? line.slice(0, split) : line);
    if (!name) continue;
    const uncertainText = split > 0 ? line.slice(split).replace(/^[:\s]+/u, '') : '';
    const amountNote = [uncertainText || '量の記載なし', note].filter(Boolean).join('・');
    const possibleUnit = uncertainText.match(new RegExp(`(${UNIT})(?:半)?$`, 'i'))?.[1] || '';
    result.push({ name, quantity: null, unit: normalizedUnit(possibleUnit), note: amountNote.slice(0, 1000) });
  }
  return result;
}

export function formatFoodQuantity(quantity: number | null, unit: string): string {
  if (!validAmount(quantity)) return '量を確認';
  const clean = cleanNumber(quantity);
  const display = clean !== 0 && clean < .000001 ? String(clean) : new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 6 }).format(clean);
  const normalized = normalizedUnit(unit);
  return normalized === '大さじ' || normalized === '小さじ' ? `${normalized}${display}` : `${display}${normalized}`;
}

function convert(quantity: number, from: string, to: string): number | null {
  if (!validAmount(quantity)) return null;
  const source = normalizedUnit(from), target = normalizedUnit(to);
  if (source === target) return quantity;
  const measures: Record<string, [string, number]> = { g: ['mass', 1], kg: ['mass', 1000], ml: ['volume', 1], L: ['volume', 1000] };
  if (!measures[source] || !measures[target] || measures[source][0] !== measures[target][0]) return null;
  const value = quantity * measures[source][1] / measures[target][1];
  return validAmount(value) ? cleanNumber(value) : null;
}

/** One row per material prevents the same inventory being subtracted twice. */
export function compareFood(recipe: FoodRecipe, items: ShoppingItem[], targetServings = 2): FoodComparison[] {
  const servingsKnown = validAmount(recipe.servings) && recipe.servings > 0 && validAmount(targetServings) && targetServings > 0;
  const inventory = new Map<string, ShoppingItem[]>();
  for (const item of items) {
    const key = foodKey(item.name);
    const group = inventory.get(key) || [];
    group.push(item); inventory.set(key, group);
  }
  const grouped = new Map<string, FoodAmount[]>();
  for (const ingredient of recipe.ingredients) {
    const key = foodKey(ingredient.name);
    if (!key) continue;
    const group = grouped.get(key) || [];
    group.push(ingredient); grouped.set(key, group);
  }
  return [...grouped.entries()].map(([key, ingredients]) => {
    const matches = inventory.get(key) || [];
    const unit = normalizedUnit(ingredients.find(row => !!row.unit)?.unit || matches.find(item => !!item.unit)?.unit || '');
    let required: number | null = 0;
    for (const ingredient of ingredients) {
      if (required === null) break;
      if (!servingsKnown || !validAmount(ingredient.quantity)) { required = null; break; }
      const amount = convert(ingredient.quantity, ingredient.unit, unit);
      const scaled = amount === null ? null : amount * targetServings / recipe.servings!;
      required = scaled !== null && validAmount(scaled) ? safeSum(required, scaled) : null;
    }
    let have = 0, planned = 0, stockUnknown = false, plannedUnknown = false, stockConfirmed = false;
    for (const item of matches) {
      // A newly added shopping plan contains no claim about inventory. It must not invalidate
      // a separately confirmed stock record after adding the missing amount to the checklist.
      const onlyPlan = !item.inventoryOnly && !completeStatuses.has(item.status) && !item.checkedAt && item.stock === 0 && item.spare === 0;
      if (onlyPlan) { /* Count its unpurchased quantity below, without treating it as stock. */ }
      else if (item.stockKnown === false) stockUnknown = true;
      else if (!validAmount(item.stock) || !validAmount(item.spare)) stockUnknown = true;
      else if (item.stock > 0 || item.spare > 0 || !!item.checkedAt) {
        stockConfirmed = true;
        const total = safeSum(item.stock, item.spare);
        // An explicitly confirmed zero remains zero even when an old row used another unit.
        const converted = total === 0 ? 0 : total === null ? null : convert(total, item.unit, unit);
        const sum = converted === null ? null : safeSum(have, converted);
        if (sum === null) stockUnknown = true;
        else have = sum;
      } else stockUnknown = true;

      if (item.inventoryOnly || completeStatuses.has(item.status)) continue;
      if (!validAmount(item.quantity) || !validAmount(item.purchasedQuantity)) { plannedUnknown = true; continue; }
      const remaining = cleanNumber(Math.max(0, item.quantity - item.purchasedQuantity));
      if (remaining === 0) continue;
      const converted = convert(remaining, item.unit, unit);
      const sum = converted === null ? null : safeSum(planned, converted);
      if (sum === null) plannedUnknown = true;
      else planned = sum;
    }
    const base = { name: ingredients[0].name, required, unit, have, planned };
    const notes = [...new Set(ingredients.map(row => row.note).filter(Boolean))].join('・');
    if (required === null) return { ...base, shortage: null, toBuy: null, status: 'check', detail: !servingsKnown ? '元の人数・作る人数を確認してください' : notes || '必要量・材料の単位を確認してください' };
    const shortage = cleanNumber(Math.max(0, required - have));
    if (shortage === 0) return { ...base, shortage: 0, toBuy: 0, status: 'enough', detail: '在庫で足ります' };
    if (!matches.length || !stockConfirmed || stockUnknown) return { ...base, shortage: null, toBuy: null, status: 'check', detail: !matches.length ? '在庫が未登録です。今ある量を確認してください' : '在庫の量・単位を確認してください' };
    if (plannedUnknown) return { ...base, shortage, toBuy: null, status: 'check', detail: '購入予定の量・単位を確認してください' };
    const toBuy = cleanNumber(Math.max(0, shortage - planned));
    return { ...base, shortage, toBuy, status: 'shortage', detail: toBuy === 0 ? '不足分は購入予定に入っています' : planned > 0 ? '購入予定を除いた分だけ買い足せます' : '不足分を買い物リストに追加できます' };
  });
}

/** Public example explicitly supplied by the user; unknown amounts remain unknown. */
export const GRATIN_RECIPE: FoodRecipe = {
  title: 'チキングラタン', url: 'https://www.youtube.com/watch?v=0VJNIVUSInk', servings: 2,
  ingredients: [
    { name: '鶏もも肉', quantity: 1, unit: '枚', note: '' },
    { name: '椎茸', quantity: 2, unit: '個', note: '' },
    { name: 'マッシュルーム', quantity: 5, unit: '個', note: '' },
    { name: '玉ねぎ', quantity: .25, unit: '個', note: '' },
    { name: 'ニンニク', quantity: 1, unit: 'かけ', note: '' },
    { name: 'バター', quantity: null, unit: 'g', note: 'ソース30g＋別途適量' },
    { name: '白ワイン', quantity: null, unit: '', note: '適量' },
    { name: 'マカロニ', quantity: 60, unit: 'g', note: '' },
    { name: 'シュレッドチーズ', quantity: null, unit: '', note: '量の記載なし' },
    { name: '黒こしょう', quantity: null, unit: '', note: '量の記載なし' },
    { name: '小麦粉', quantity: 30, unit: 'g', note: 'ベシャメルソース用' },
    { name: '牛乳', quantity: 400, unit: 'ml', note: 'ベシャメルソース用' },
  ],
};
