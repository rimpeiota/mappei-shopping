import { newItem, safeUrl, TODAY, type ShoppingItem } from './client-model.ts';
import { compareFood, foodKey, formatFoodQuantity, parseFoodLines, type FoodAmount, type FoodRecipe } from './client-food.ts';

const validQuantity = (quantity: number | null) => quantity === null || (Number.isFinite(quantity) && quantity >= 0 && quantity <= 1e6);

/** A count is the current total, never an additional purchase. History fields remain unchanged. */
export function setCurrentFood(items: ShoppingItem[], food: FoodAmount, location: string, date = TODAY()): ShoppingItem[] {
  const name = food.name.trim();
  if (!name || !validQuantity(food.quantity)) return items;
  const key = foodKey(name);
  const now = new Date().toISOString();
  const next = items.map(item => foodKey(item.name) === key ? { ...item, stock: 0, spare: 0, stockKnown: true, checkedAt: date, stockReconciledQuantity: Math.max(item.stockReconciledQuantity, item.purchasedQuantity, item.status === 'purchased' || item.status === 'received' ? item.quantity : 0), updatedAt: now } : item);
  next.push(newItem(name, { category: '食品', unit: food.unit, quantity: food.quantity !== null && food.quantity > 0 ? food.quantity : 1,
    inventoryOnly: true, stockKnown: food.quantity !== null, stock: food.quantity ?? 0, spare: 0,
    inventorySource: 'current', status: 'planned', location, checkedAt: date, comment: food.note }));
  return next;
}

/** A purchase is deliberately recorded once in both history and stock. */
export function addPurchasedFood(items: ShoppingItem[], food: FoodAmount, location: string, date = TODAY()): ShoppingItem[] {
  const name = food.name.trim();
  if (!name || !validQuantity(food.quantity) || food.quantity === 0) return items;
  return [...items, newItem(name, { category: '食品', quantity: food.quantity ?? 1, unit: food.unit,
    inventoryOnly: false, inventorySource: 'purchase', status: 'purchased', purchasedAt: date,
    purchasedQuantity: food.quantity ?? 0, stockKnown: food.quantity !== null, stock: food.quantity ?? 0,
    location, checkedAt: date, comment: food.note })];
}

/** Recomputing against current items avoids adding the same deficit again. */
export function addFoodShortages(items: ShoppingItem[], recipe: FoodRecipe, targetServings = 2): ShoppingItem[] {
  const rows = compareFood(recipe, items, targetServings).filter(row => row.status === 'shortage' && row.toBuy !== null && row.toBuy > 0);
  if (!rows.length) return items;
  return [...items, ...rows.map(row => newItem(row.name, { category: '食品', quantity: row.toBuy!, unit: row.unit,
    url: safeUrl(recipe.url), comment: `${recipe.title}（${targetServings}人分）の不足分`, inventoryOnly: false, stockKnown: false, inventorySource: 'recipe' }))];
}

export function foodIngredientLine(ingredient: FoodAmount): string {
  const amount = ingredient.quantity === null ? '' : formatFoodQuantity(ingredient.quantity, ingredient.unit);
  const note = ingredient.note ? amount ? ` (${ingredient.note})` : ingredient.note : '';
  return `${ingredient.name}：${amount}${note}`.trim();
}

/** Keep exact original quantities and notes on material lines the person did not edit. */
export function editedFoodIngredients(recipe: FoodRecipe | null, text: string): FoodAmount[] {
  const originals = new Map<string, FoodAmount[]>();
  for (const ingredient of recipe?.ingredients ?? []) {
    const key = foodIngredientLine(ingredient);
    originals.set(key, [...originals.get(key) ?? [], ingredient]);
  }
  return text.split(/\r?\n/).flatMap(line => {
    const original = originals.get(line.trim())?.shift();
    return original ? [{ ...original }] : parseFoodLines(line);
  });
}
