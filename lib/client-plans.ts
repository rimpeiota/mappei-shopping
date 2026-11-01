import { COMPLETE, guessCategory, newItem, safeUrl, type ShoppingItem } from './client-model.ts';

export type PlannedProductInput = {
  name: string;
  url: string;
  quantity?: number;
  unit?: string;
  category?: string;
};
export type PlannedImportResult = {
  items: ShoppingItem[];
  added: ShoppingItem[];
  skipped: number;
  invalid: number;
  error: string | null;
};

const AMAZON_DOMAINS = new Set(['amazon.co.jp', 'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es',
  'amazon.ca', 'amazon.com.au', 'amazon.in', 'amazon.com.br', 'amazon.com.mx', 'amazon.nl', 'amazon.se', 'amazon.pl',
  'amazon.sg', 'amazon.com.be', 'amazon.com.tr', 'amazon.ae', 'amazon.sa', 'amazon.eg', 'amazon.ie', 'amazon.co.za']);

/** Product identity excludes Amazon advertising parameters and keeps different variants distinct. */
export function plannedProductKey(value: string): string {
  const safe = safeUrl(value);
  if (!safe) return '';
  const url = new URL(safe);
  const domain = url.hostname.toLowerCase().replace(/^(?:www|smile|m)\./u, '');
  if (AMAZON_DOMAINS.has(domain)) {
    const asin = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([a-z0-9]{10})(?:\/|$)/iu)?.[1];
    if (asin) return `amazon:${domain}:${asin.toUpperCase()}`;
  }
  url.hash = '';
  return url.toString();
}

/** These selectors keep future plans out of the daily checklist and its totals. */
export function getShoppingItems(items: ShoppingItem[]): ShoppingItem[] {
  return items.filter(item => !item.purchaseLater && !item.inventoryOnly && !COMPLETE.includes(item.status));
}
export function getPlannedItems(items: ShoppingItem[]): ShoppingItem[] {
  // The collection remains visible even if an older import already has a completed status.
  return items.filter(item => item.purchaseLater && !item.inventoryOnly);
}

/** Promotion moves the existing record, preserving its URL, ID, and all purchase/inventory data. */
export function moveToShoppingList(item: ShoppingItem): ShoppingItem {
  return item.purchaseLater ? { ...item, purchaseLater: false, updatedAt: new Date().toISOString() } : item;
}

/** Import is append-only. Re-importing a list never modifies or relocates an existing product. */
export function importPlannedProducts(items: ShoppingItem[], input: unknown): PlannedImportResult {
  const result: PlannedImportResult = { items, added: [], skipped: 0, invalid: 0, error: null };
  if (!Array.isArray(input) || input.length === 0 || input.length > 1000) {
    return { ...result, error: '商品名とURLのある一覧を、1〜1000件のJSON配列で入力してください。' };
  }
  const known = new Set(items.map(item => plannedProductKey(item.url || item.name)).filter(Boolean));
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { result.invalid += 1; continue; }
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const url = typeof entry.url === 'string' ? safeUrl(entry.url.trim()) : '';
    const quantity = entry.quantity === undefined ? 1 : entry.quantity;
    const unit = entry.unit === undefined ? '個' : entry.unit;
    if (!name || name.length > 20000 || !url || url.length > 2000 || /^https?:\/\//iu.test(name)
      || typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1e9
      || typeof unit !== 'string' || !unit.trim() || unit.length > 50
      || (entry.category !== undefined && typeof entry.category !== 'string')) {
      result.invalid += 1; continue;
    }
    const key = plannedProductKey(url);
    if (known.has(key)) { result.skipped += 1; continue; }
    if (items.length + result.added.length >= 10000) {
      return { ...result, items, added: [], error: '合計10000件を超えるため追加しませんでした。' };
    }
    const domain = new URL(url).hostname.toLowerCase().replace(/^(?:www|smile|m)\./u, '');
    result.added.push(newItem(name, { url, quantity, unit: unit.trim(), category: typeof entry.category === 'string' && entry.category.trim()
      ? entry.category.trim().slice(0, 100) : guessCategory(name), store: AMAZON_DOMAINS.has(domain) ? 'Amazon' : '',
      purchaseLater: true, stockKnown: false }));
    known.add(key);
  }
  if (result.added.length) result.items = [...items, ...result.added];
  return result;
}
