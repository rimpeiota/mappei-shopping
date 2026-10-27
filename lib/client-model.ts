import type { FoodRecipe } from './client-food';

export type ItemStatus = 'planned' | 'considering' | 'cart' | 'ordered' | 'purchased' | 'received' | 'snoozed' | 'returned' | 'exchanged' | 'cancelled';
export type Mode = 'list' | 'stock' | 'history' | 'favorites' | 'settings';
export type PriceRecord = { id: string; store: string; price: number; date: string; source: string };
export type Attachment = { id: string; name: string; url: string; type: string };
export type ShoppingItem = {
  id: string; name: string; quantity: number; unit: string; category: string; store: string; status: ItemStatus;
  createdAt: string; updatedAt: string; listDate: string; favorite: boolean;
  brand: string; model: string; color: string; size: string; capacity: string; aliases: string; url: string;
  price: number; ceiling: number; shipping: number; discount: number; runningCost: number; measure: number; measureUnit: string;
  coupon: string; couponEnds: string; saleEnds: string; holdUntil: string; group: string; compatibility: string;
  purchasedQuantity: number; purchasedAt: string; deliveryDate: string; returnUntil: string; warrantyUntil: string;
  subscriptionDate: string; subscriptionQuantity: number; subscriptionEvery: number; manualUrl: string;
  stock: number; spare: number; location: string; remaining: number; checkedAt: string; expiry: string; openedAt: string; usedUpAt: string; consumptionPerDay: number; restockThreshold: number; restockSnooze: string;
  inventoryOnly: boolean; stockKnown: boolean; inventorySource: string; stockReconciledQuantity: number;
  assignee: string; requester: string; requestedDate: string; shared: boolean; comment: string; rating: string; rebuy: string;
  prices: PriceRecord[]; attachments: Attachment[];
};
export type Template = { id: string; name: string; items: Pick<ShoppingItem, 'name' | 'quantity' | 'unit' | 'category' | 'store'>[] };
export type Activity = { id: string; text: string; at: string };
export type ShoppingState = { version: 2; items: ShoppingItem[]; templates: Template[]; activity: Activity[]; mealRecipe: FoodRecipe | null; settings: { budget: number; reducedMotion: boolean; defaultStore: string; name: string } };
export type ShoppingCache = { state: ShoppingState; revision: number; dirty: boolean; legacyDirty: boolean };
export const STATUS_LABELS: Record<ItemStatus, string> = { planned: '買う予定', considering: '検討中', cart: 'かごの中', ordered: '注文済み', purchased: '購入済み', received: '受取済み', snoozed: '次回', returned: '返品', exchanged: '交換', cancelled: '取消' };
export const CATEGORIES = ['食品', '日用品', '衣類', '家電', '家具', 'その他'];
export const COMPLETE: ItemStatus[] = ['purchased', 'received', 'returned', 'exchanged', 'cancelled'];
export const TODAY = () => new Date().toLocaleDateString('sv-SE');
export const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const money = (value: number) => new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 }).format(value || 0);
export const emptyState = (): ShoppingState => ({ version: 2, items: [], templates: [], activity: [], mealRecipe: null, settings: { budget: 0, reducedMotion: false, defaultStore: '', name: '' } });
export function newItem(name: string, fields: Partial<ShoppingItem> = {}): ShoppingItem {
  const now = new Date().toISOString();
  return { id: uid(), name, quantity: 1, unit: '個', category: 'その他', store: '', status: 'planned', createdAt: now, updatedAt: now, listDate: TODAY(), favorite: false,
    brand: '', model: '', color: '', size: '', capacity: '', aliases: '', url: '', price: 0, ceiling: 0, shipping: 0, discount: 0, runningCost: 0, measure: 0, measureUnit: 'g', coupon: '', couponEnds: '', saleEnds: '', holdUntil: '', group: '', compatibility: '', purchasedQuantity: 0, purchasedAt: '', deliveryDate: '', returnUntil: '', warrantyUntil: '', subscriptionDate: '', subscriptionQuantity: 1, subscriptionEvery: 30, manualUrl: '', stock: 0, spare: 0, location: '', remaining: 100, checkedAt: '', expiry: '', openedAt: '', usedUpAt: '', consumptionPerDay: 0, restockThreshold: 1, restockSnooze: '', inventoryOnly: false, stockKnown: true, inventorySource: '', stockReconciledQuantity: 0, assignee: '', requester: '', requestedDate: '', shared: false, comment: '', rating: '', rebuy: '', prices: [], attachments: [], ...fields };
}
export function guessCategory(name: string): string {
  if (/牛乳|卵|パン|肉|魚|野菜|米|水|コーヒー|豆|バナナ|りんご|チーズ|ヨーグルト|冷凍|トマト|塩|醤油|味噌|茶|ビール|パスタ|白菜|キャベツ|キムチ/.test(name)) return '食品';
  if (/洗剤|ティッシュ|トイレ|シャンプー|歯|スポンジ|ソープ|ゴミ|ごみ|電池|柔軟|ラップ|マスク|タオル/.test(name)) return '日用品';
  if (/服|シャツ|靴|ソックス|コート|パンツ|帽子/.test(name)) return '衣類';
  if (/充電|ケーブル|イヤホン|パソコン|スマホ|掃除機|冷蔵庫|テレビ/.test(name)) return '家電';
  return 'その他';
}
export function normalize(text: string) { return text.normalize('NFKC').toLowerCase().replace(/[\sー・･]/g, '').replace(/てぃっしゅ/g, 'ティッシュ').replace(/ぎゅうにゅう/g, '牛乳'); }
export const LINK_NAME_PLACEHOLDER = '商品名を入力';
export function itemLink(item: Pick<ShoppingItem, 'name' | 'url'>): string {
  return safeUrl(item.url) || safeUrl(item.name.trim());
}
export function needsProductName(item: Pick<ShoppingItem, 'name' | 'url'>): boolean {
  const url = itemLink(item); if (!url) return false;
  const name = item.name.trim();
  return !name || name === LINK_NAME_PLACEHOLDER || /^https?:\/\//i.test(name)
    || name.replace(/^www\./, '') === new URL(url).hostname.replace(/^www\./, '');
}
export function parseQuickText(text: string, defaultStore = ''): ShoppingItem[] {
  // Preserve URL punctuation before splitting ordinary shopping notes.
  const links: string[] = [];
  const protectedText = text.replace(/https?:\/\/[^\s<>"'、]+/giu, value => {
    const url = value.replace(/[。）」』]+$/u, '');
    links.push(url); return `\uE000${links.length - 1}\uE001`;
  });
  const parts = protectedText.split(/[、,\n;；]+|\s+と\s+|と(?=[^と]+\d)|と(?=[\p{Script=Han}\p{Script=Katakana}])|(?<=\d(?:個|本|袋|パック|箱|枚|缶|台))と/u);
  return parts.flatMap(raw => {
    raw = raw.trim(); if (!raw) return [];
    const tokens = [...raw.matchAll(/\uE000(\d+)\uE001/gu)];
    const clean = raw.replace(/\uE000\d+\uE001/gu, '').trim();
    const match = clean.match(/^(.*?)\s*(\d+(?:\.\d+)?)\s*(パック|セット|ケース|kg|ml|個|本|袋|箱|枚|缶|台|足|g|L|l)$/i);
    const explicitName = match?.[1]?.trim() || clean;
    const fields = { quantity: match ? Math.max(.01, Number(match[2])) : 1, unit: match?.[3] || '個', store: defaultStore };
    if (tokens.length) return tokens.map(token => {
      const url = safeUrl(links[Number(token[1])] || '');
      return newItem(explicitName || LINK_NAME_PLACEHOLDER, { ...fields, category: guessCategory(explicitName), url });
    });
    return [newItem(explicitName || raw, { ...fields, category: guessCategory(explicitName || raw) })];
  }).slice(0, 50);
}
export function applyProductTitle(item: ShoppingItem, sourceUrl: string, title: string, manuallyEditing = false): ShoppingItem {
  if (manuallyEditing || itemLink(item) !== sourceUrl || !needsProductName(item) || !title.trim()) return item;
  return { ...item, name: title.trim().slice(0, 500), url: sourceUrl, category: guessCategory(title), updatedAt: new Date().toISOString() };
}
export function togglePurchased(item: ShoppingItem): ShoppingItem {
  const now = new Date().toISOString();
  if (item.status === 'purchased' || item.status === 'received') {
    return { ...item, status: 'planned', purchasedAt: '', purchasedQuantity: 0,
      stock: Math.max(0, item.stock - Math.max(0, item.purchasedQuantity - item.stockReconciledQuantity)), updatedAt: now };
  }
  return { ...item, status: 'purchased', purchasedAt: TODAY(), purchasedQuantity: item.quantity,
    stock: item.stock + Math.max(0, item.quantity - Math.max(item.purchasedQuantity, item.stockReconciledQuantity)),
    stockKnown: item.stockKnown || (item.inventorySource === 'recipe' && !item.checkedAt && item.stock === 0 && item.spare === 0), checkedAt: TODAY(), updatedAt: now };
}
// Only newly confirmed purchases increase current stock. A lower historical purchase
// quantity cannot establish how much remains after cooking, returns, or disposal.
export function recordPurchasedQuantity(item: ShoppingItem, requested: number): ShoppingItem {
  if (!Number.isFinite(requested)) return item;
  const purchasedQuantity = Math.max(0, Math.min(item.quantity, requested));
  const increase = Math.max(0, purchasedQuantity - Math.max(item.purchasedQuantity, item.stockReconciledQuantity));
  const complete = purchasedQuantity >= item.quantity;
  return { ...item, purchasedQuantity, stock: item.stock + increase,
    stockKnown: item.stockKnown || (increase > 0 && item.inventorySource === 'recipe' && !item.checkedAt && item.stock === 0 && item.spare === 0),
    purchasedAt: increase > 0 ? TODAY() : purchasedQuantity === 0 ? '' : item.purchasedAt,
    checkedAt: increase > 0 ? TODAY() : item.checkedAt,
    status: complete ? (item.status === 'received' ? 'received' : 'purchased')
      : item.status === 'purchased' || item.status === 'received' ? 'planned' : item.status,
    updatedAt: new Date().toISOString() };
}
export function setItemStatus(item: ShoppingItem, status: ItemStatus): ShoppingItem {
  const next = status === 'purchased' || status === 'received' ? recordPurchasedQuantity(item, item.quantity) : item;
  return { ...next, status, updatedAt: new Date().toISOString() };
}
export function finalizePurchaseDraft(original: ShoppingItem, draft: ShoppingItem, currentStockWasEntered = false): ShoppingItem {
  // Reconcile once on Save, rather than on every digit while editing a quantity.
  // Explicit current-stock input already includes what the person has purchased.
  const increase = Math.max(0, draft.purchasedQuantity - Math.max(original.purchasedQuantity, original.stockReconciledQuantity));
  return { ...draft, stock: currentStockWasEntered ? draft.stock : draft.stock + increase, stockReconciledQuantity: currentStockWasEntered ? Math.max(draft.stockReconciledQuantity, draft.purchasedQuantity) : draft.stockReconciledQuantity, updatedAt: new Date().toISOString() };
}
export function validateFoodRecipe(input: unknown): FoodRecipe | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (typeof value.title !== 'string' || !value.title.trim() || typeof value.url !== 'string'
    || !Array.isArray(value.ingredients) || value.ingredients.length === 0 || value.ingredients.length > 100) return null;
  const url = value.url.trim() ? safeUrl(value.url.trim()) : '';
  if (value.url.trim() && (!url || !url.startsWith('https:') || url.length > 2000)) return null;
  if (value.servings !== null && (typeof value.servings !== 'number' || !Number.isFinite(value.servings) || value.servings <= 0 || value.servings > 1000)) return null;
  const ingredients: FoodRecipe['ingredients'] = [];
  for (const raw of value.ingredients) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const ingredient = raw as Record<string, unknown>;
    if (typeof ingredient.name !== 'string' || !ingredient.name.trim() || typeof ingredient.unit !== 'string' || typeof ingredient.note !== 'string'
      || (ingredient.quantity !== null && (typeof ingredient.quantity !== 'number' || !Number.isFinite(ingredient.quantity) || ingredient.quantity < 0 || ingredient.quantity > 1e6))) return null;
    ingredients.push({ name: ingredient.name.trim().slice(0, 500), quantity: ingredient.quantity as number | null,
      unit: ingredient.unit.trim().slice(0, 50), note: ingredient.note.trim().slice(0, 2000) });
  }
  return { title: value.title.trim().slice(0, 500), url, servings: value.servings as number | null, ingredients };
}
export function hasShoppingData(state: ShoppingState): boolean {
  return state.items.length > 0 || state.templates.length > 0 || state.mealRecipe !== null;
}
// Called only after the person chooses to add their anonymous notes to this account.
// Keep the account's current recipe when both have one; retain a local-only recipe.
export function mergeAnonymousState(account: ShoppingState, local: ShoppingState): ShoppingState {
  const ids = new Set(account.items.map(item => item.id));
  const templateIds = new Set(account.templates.map(template => template.id));
  return { ...account, items: [...account.items, ...local.items.filter(item => !ids.has(item.id))],
    templates: [...account.templates, ...local.templates.filter(template => !templateIds.has(template.id))],
    activity: [...local.activity, ...account.activity].slice(0, 200), mealRecipe: account.mealRecipe ?? local.mealRecipe };
}
export function validateShoppingCache(input: unknown): ShoppingCache | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const state = validateState(value.state);
  if (!state) return null;
  const sourceVersion = value.state && typeof value.state === 'object' ? (value.state as { version?: unknown }).version : undefined;
  return { state, revision: typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    dirty: value.dirty === true, legacyDirty: value.legacyDirty === true || (value.dirty === true && sourceVersion === 1) };
}
export function cacheNeedsReview(cache: ShoppingCache, remote: unknown, remoteRevision: number): boolean {
  const remoteVersion = remote && typeof remote === 'object' ? (remote as { version?: unknown }).version : undefined;
  // v1 clients may cache an empty interpretation of v2 at the latest revision.
  // Revision equality alone therefore cannot make their pending writes safe.
  return cache.dirty && (cache.revision !== remoteRevision || (cache.legacyDirty && remoteVersion === 2));
}
export function validateState(input: unknown): ShoppingState | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Partial<Omit<ShoppingState, 'version'>> & { version?: unknown };
  if ((value.version !== 1 && value.version !== 2) || !Array.isArray(value.items) || value.items.length > 10000) return null;
  if (!value.items.every(item => item && typeof item.name === 'string' && typeof item.id === 'string' && item.name.length <= 500 && item.id.length <= 200)) return null;
  if (new Set(value.items.map(item => item.id)).size !== value.items.length) return null;
  const blank = emptyState();
  const boundedString = (v: unknown, max = 1000) => typeof v === 'string' ? v.slice(0, max) : '';
  const boundedNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? Math.min(1e9, Math.max(0, v)) : 0;
  const items = value.items.map(item => {
    const safe = newItem(item.name);
    for (const key of Object.keys(safe) as (keyof ShoppingItem)[]) {
      if (typeof safe[key] === 'string' && typeof item[key] === 'string') (safe as unknown as Record<string, unknown>)[key] = boundedString(item[key], key === 'comment' ? 20000 : 2000);
      if (typeof safe[key] === 'number' && typeof item[key] === 'number') (safe as unknown as Record<string, unknown>)[key] = boundedNumber(item[key]);
      if (typeof safe[key] === 'boolean' && typeof item[key] === 'boolean') (safe as unknown as Record<string, unknown>)[key] = item[key];
    }
    safe.status = Object.hasOwn(STATUS_LABELS, item.status) ? item.status : 'planned';
    safe.quantity = safe.quantity > 0 ? safe.quantity : 1;
    safe.remaining = Math.min(100, safe.remaining);
    safe.prices = Array.isArray(item.prices) ? item.prices.filter(p => p && typeof p.id === 'string' && typeof p.price === 'number').slice(0, 1000).map(p => ({ id: boundedString(p.id, 200), store: boundedString(p.store), price: boundedNumber(p.price), date: boundedString(p.date, 50), source: boundedString(p.source, 2000) })) : [];
    safe.attachments = Array.isArray(item.attachments) ? item.attachments.filter(a => a && typeof a.id === 'string' && typeof a.url === 'string').slice(0, 100).map(a => ({ id: boundedString(a.id, 200), name: boundedString(a.name, 500), url: boundedString(a.url, 2000), type: boundedString(a.type, 200) })) : [];
    return safe;
  });
  const templates = Array.isArray(value.templates) ? value.templates.filter(t => t && typeof t.id === 'string' && typeof t.name === 'string' && Array.isArray(t.items)).slice(0, 500).map(t => ({ id: boundedString(t.id, 200), name: boundedString(t.name, 200), items: t.items.filter(i => i && typeof i.name === 'string').slice(0, 1000).map(i => ({ name: boundedString(i.name, 500), quantity: boundedNumber(i.quantity) || 1, unit: boundedString(i.unit, 50) || '個', category: boundedString(i.category, 100) || 'その他', store: boundedString(i.store, 200) })) })) : [];
  const activity = Array.isArray(value.activity) ? value.activity.filter(a => a && typeof a.text === 'string' && typeof a.at === 'string').slice(0, 200).map(a => ({ id: boundedString(a.id, 200) || uid(), text: boundedString(a.text, 2000), at: boundedString(a.at, 100) })) : [];
  const settings = value.settings || blank.settings;
  return { version: 2, items, templates, activity, mealRecipe: validateFoodRecipe(value.mealRecipe), settings: { budget: boundedNumber(settings.budget), reducedMotion: settings.reducedMotion === true, name: boundedString(settings.name, 80), defaultStore: boundedString(settings.defaultStore, 200) } };
}
export function safeUrl(value: string) { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.toString() : ''; } catch { return ''; } }
export function itemTotal(item: ShoppingItem) { return Math.max(0, item.price * item.quantity + item.shipping - item.discount); }
export function isRestock(item: ShoppingItem) { return item.stock + item.spare <= item.restockThreshold && (item.stock > 0 || item.spare > 0 || !!item.checkedAt) && (!item.restockSnooze || item.restockSnooze <= TODAY()); }
export function estimateDays(item: ShoppingItem) { return item.consumptionPerDay > 0 ? Math.ceil(item.remaining / item.consumptionPerDay) : null; }
