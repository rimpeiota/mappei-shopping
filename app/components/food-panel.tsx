'use client';

import { useRef, useState, type FormEvent } from 'react';
import { Check, ChevronDown, ClipboardList, ExternalLink, Plus, Refrigerator, X } from 'lucide-react';
import { safeUrl, TODAY, validateFoodRecipe, type ShoppingItem } from '@/lib/client-model';
import { compareFood, foodKey, formatFoodQuantity, GRATIN_RECIPE, type FoodRecipe } from '@/lib/client-food';
import { addFoodShortages, addPurchasedFood, editedFoodIngredients, foodIngredientLine, setCurrentFood } from '@/lib/client-food-actions';

type FoodPanelProps = {
  items: ShoppingItem[];
  recipe: FoodRecipe | null;
  onItems: (next: ShoppingItem[], message: string) => void;
  onRecipe: (next: FoodRecipe | null) => void;
  onShowList: () => void;
  onEditItem: (item: ShoppingItem) => void;
};
type InventoryGroup = { key: string; name: string; rows: ShoppingItem[] };
type EntryMode = 'current' | 'purchase';

function quantityInput(value: string): number | null | undefined {
  const normalized = value.normalize('NFKC').trim();
  if (!normalized) return null;
  const match = normalized.match(/^(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?$/);
  if (!match) return undefined;
  const amount = Number(match[1]) / (match[2] ? Number(match[2]) : 1);
  return Number.isFinite(amount) && amount >= 0 && amount <= 1e6 ? amount : undefined;
}

function inventorySummary(rows: ShoppingItem[]): string {
  const amounts = new Map<string, number>();
  let unknown = false;
  for (const row of rows) {
    if (!row.stockKnown) { unknown = true; continue; }
    amounts.set(row.unit, (amounts.get(row.unit) ?? 0) + row.stock + row.spare);
  }
  const positive = [...amounts].filter(([, quantity]) => quantity > 0);
  const known = positive.map(([unit, quantity]) => formatFoodQuantity(quantity, unit));
  if (!known.length && !unknown && amounts.size) {
    const [unit, quantity] = [...amounts].at(-1)!;
    known.push(formatFoodQuantity(quantity, unit));
  }
  if (unknown) known.push('量が未確認');
  return known.join(' + ') || '量が未確認';
}

function purchaseSummary(rows: ShoppingItem[]): string {
  const amounts = new Map<string, number>();
  let unknown = false;
  for (const row of rows) {
    if (!(row.purchasedQuantity > 0)) { unknown = true; continue; }
    amounts.set(row.unit, (amounts.get(row.unit) ?? 0) + row.purchasedQuantity);
  }
  const known = [...amounts].map(([unit, quantity]) => formatFoodQuantity(quantity, unit));
  if (unknown) known.push('量の記録なし');
  return known.join(' + ') || '量の記録なし';
}

function RecipeEditor({ recipe, onSave, onClose }: { recipe: FoodRecipe | null; onSave: (recipe: FoodRecipe) => void; onClose: () => void }) {
  const initialLines = recipe?.ingredients.map(foodIngredientLine).join('\n') ?? '';
  const [title, setTitle] = useState(recipe?.title ?? '');
  const [url, setUrl] = useState(recipe?.url ?? '');
  const [servings, setServings] = useState(recipe?.servings === null ? '' : String(recipe?.servings ?? 2));
  const [lines, setLines] = useState(initialLines);
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const sourceServings = quantityInput(servings);
    if (sourceServings === undefined || sourceServings === 0 || (sourceServings !== null && sourceServings > 1000)) { setError('元の人数は0より大きく1000以下の数で入力してください。不明なら空欄にしてください'); return; }
    if (url.trim() && !safeUrl(url.trim()).startsWith('https:')) { setError('レシピのURLはhttps://から入力してください'); return; }
    const ingredients = editedFoodIngredients(recipe, lines);
    if (!ingredients.length) { setError('材料を1行に1つずつ入力してください'); return; }
    if (ingredients.length > 100) { setError('材料は100件以下にしてください'); return; }
    const next = validateFoodRecipe({ title: title.trim() || '今回の料理', url: safeUrl(url.trim()), servings: sourceServings, ingredients });
    if (!next) { setError('材料の量と単位を確認してください。量は100万以下で入力してください'); return; }
    onSave(next);
    onClose();
  };
  return <form className="food-form food-recipe-form" onSubmit={submit}>
    <div className="food-section-heading"><h3>料理と材料</h3><button type="button" className="icon-button" aria-label="材料の編集を閉じる" onClick={onClose}><X size={20} /></button></div>
    <label className="food-field"><span>料理名</span><input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} placeholder="料理名" /></label>
    <label className="food-field"><span>出典のURL</span><input type="url" value={url} onChange={event => setUrl(event.target.value)} maxLength={2000} placeholder="https://" /></label>
    <label className="food-field"><span>材料欄に書かれた元の人数</span><div className="food-number-field"><input inputMode="decimal" value={servings} onChange={event => setServings(event.target.value)} placeholder="不明なら空欄" maxLength={30} /><span>人分</span></div></label>
    <label className="food-field"><span>材料（1行に1つ）</span><textarea value={lines} onChange={event => setLines(event.target.value)} rows={8} maxLength={20000} placeholder={'鶏もも肉 1枚\n玉ねぎ 1/4個\n牛乳 400ml\n塩 少々'} /></label>
    <p className="food-note">URLの自動読み取りは準備中です。材料を入力すると2人分で比較できます。量の記載がない材料は「要確認」になります。</p>
    {error && <p className="food-error" role="alert">{error}</p>}
    <div className="food-form-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button type="submit" className="button primary"><Check size={17} />材料を保存</button></div>
  </form>;
}

export function FoodPanel({ items, recipe, onItems, onRecipe, onShowList }: FoodPanelProps) {
  const [tab, setTab] = useState<'inventory' | 'compare'>('inventory');
  const [filter, setFilter] = useState<'all' | 'today'>('all');
  const [entryMode, setEntryMode] = useState<EntryMode>('current');
  const [entryOpen, setEntryOpen] = useState(false);
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('個');
  const [location, setLocation] = useState('冷蔵庫');
  const [entryError, setEntryError] = useState('');
  const [recipeEditing, setRecipeEditing] = useState(false);
  const entryRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const today = TODAY();
  const recipeFoodKeys = new Set(recipe?.ingredients.map(ingredient => foodKey(ingredient.name)) ?? []);
  const inventory = items.filter(item => (item.category === '食品' || item.inventoryOnly || recipeFoodKeys.has(foodKey(item.name)))
    && (item.inventoryOnly || item.stock > 0 || item.spare > 0 || !!item.checkedAt || item.status === 'purchased' || item.status === 'received'));
  const filtered = filter === 'today' ? inventory.filter(item => !item.inventoryOnly && item.purchasedAt === today) : inventory;
  const grouped = new Map<string, InventoryGroup>();
  for (const item of filtered) {
    const key = foodKey(item.name);
    const group = grouped.get(key);
    if (group) group.rows.push(item); else grouped.set(key, { key, name: item.name, rows: [item] });
  }
  const currentMatches = name.trim() ? inventory.filter(item => foodKey(item.name) === foodKey(name)) : [];
  const comparison = recipe ? compareFood(recipe, items, 2) : [];
  const additions = comparison.filter(row => row.status === 'shortage' && row.toBuy !== null && row.toBuy > 0);
  const todayCount = inventory.filter(item => !item.inventoryOnly && item.purchasedAt === today).length;

  const openEntry = (mode: EntryMode, foodName = '', foodUnit = '個') => {
    setEntryMode(mode); setName(foodName); setQuantity(''); setUnit(foodUnit); setLocation('冷蔵庫'); setEntryError(''); setEntryOpen(true); setTab('inventory');
    requestAnimationFrame(() => { entryRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' }); nameRef.current?.focus({ preventScroll: true }); });
  };

  const writeCurrent = (foodName: string, amount: number | null, foodUnit: string, foodLocation: string) => {
    const next = setCurrentFood(items, { name: foodName, quantity: amount, unit: foodUnit, note: '' }, foodLocation, today);
    onItems(next, `${foodName}の現在量を${amount === null ? '未確認' : formatFoodQuantity(amount, foodUnit)}で更新しました`);
  };

  const submitEntry = (event: FormEvent) => {
    event.preventDefault();
    const foodName = name.trim();
    if (!foodName) { setEntryError('食材名を入力してください'); return; }
    const amount = quantityInput(quantity);
    if (amount === undefined) { setEntryError('量は0以上の数か分数（1/2など）で入力してください。不明なら空欄にしてください'); return; }
    if (entryMode === 'purchase' && amount === 0) { setEntryError('買った量は0より大きい数にしてください。在庫がない場合は「今ある量」で0を登録できます'); return; }
    if (entryMode === 'current') writeCurrent(foodName, amount, unit.trim(), location.trim());
    else onItems(addPurchasedFood(items, { name: foodName, quantity: amount, unit: unit.trim(), note: '' }, location.trim(), today), `${foodName}を購入済み・在庫に追加しました`);
    setName(''); setQuantity(''); setEntryError(''); setEntryOpen(false);
  };

  const editGroup = (group: InventoryGroup) => {
    const active = group.rows.filter(row => !row.stockKnown || row.stock > 0 || row.spare > 0);
    const rows = active.length ? active : group.rows.slice(-1);
    openEntry('current', group.name, rows[0]?.unit ?? '個');
    const known = rows.every(row => row.stockKnown);
    const sameUnit = new Set(rows.map(row => row.unit)).size === 1;
    setQuantity(known && sameUnit ? String(rows.reduce((sum, row) => sum + row.stock + row.spare, 0)) : '');
    setLocation(rows.find(row => row.location)?.location || '冷蔵庫');
  };

  const addShortages = () => {
    if (!recipe || !additions.length) return;
    const next = addFoodShortages(items, recipe, 2);
    if (next.length === items.length) return;
    onItems(next, `不足分${next.length - items.length}件を買い物リストに追加しました`);
  };

  return <section className="food-panel" aria-label="食材と料理の不足分">
    <div className="food-tabs" role="tablist" aria-label="食材の表示">
      <button type="button" id="food-inventory-tab" role="tab" aria-controls="food-inventory-panel" aria-selected={tab === 'inventory'} className={tab === 'inventory' ? 'active' : ''} onClick={() => setTab('inventory')}><Refrigerator size={18} />いまある食材</button>
      <button type="button" id="food-compare-tab" role="tab" aria-controls="food-compare-panel" aria-selected={tab === 'compare'} className={tab === 'compare' ? 'active' : ''} onClick={() => setTab('compare')}><ClipboardList size={18} />料理の不足分</button>
    </div>

    {tab === 'inventory' && <div id="food-inventory-panel" role="tabpanel" aria-labelledby="food-inventory-tab">
      <div className="food-entry-actions"><button type="button" className="button primary" onClick={() => openEntry('current')}><Plus size={18} />今ある量を登録</button><button type="button" className="button secondary" onClick={() => openEntry('purchase')}><Plus size={18} />買ったものを追加</button></div>
      <p className="food-note">「今ある量」は、今日買った分も含む現在の合計です。買い物リストで購入済みにした分は、自動で在庫に含まれます。</p>

      {entryOpen && <div ref={entryRef} className="food-entry-anchor"><form className="food-form" onSubmit={submitEntry}>
        <div className="food-section-heading"><h3>{entryMode === 'current' ? '現在の合計を登録・更新' : '今日買ったものを追加'}</h3><button type="button" className="icon-button" aria-label="食材の入力を閉じる" onClick={() => setEntryOpen(false)}><X size={20} /></button></div>
        <label className="food-field"><span>食材名</span><input ref={nameRef} value={name} onChange={event => { setName(event.target.value); setEntryError(''); }} maxLength={500} placeholder="玉ねぎ" required /></label>
        <div className="food-two-fields"><label className="food-field"><span>{entryMode === 'current' ? '現在の合計量' : '買った量'}</span><input inputMode="decimal" value={quantity} onChange={event => setQuantity(event.target.value)} maxLength={30} placeholder="不明なら空欄" /></label><label className="food-field"><span>単位</span><input value={unit} onChange={event => setUnit(event.target.value)} maxLength={50} placeholder="個・g・ml" list="food-unit-options" /></label></div>
        <datalist id="food-unit-options">{['個', '枚', '本', 'パック', '袋', 'g', 'kg', 'ml', 'L', '合', 'かけ', '大さじ', '小さじ'].map(value => <option key={value} value={value} />)}</datalist>
        <label className="food-field"><span>保存場所</span><input value={location} onChange={event => setLocation(event.target.value)} maxLength={200} list="food-location-options" /></label>
        <datalist id="food-location-options"><option value="冷蔵庫" /><option value="冷凍庫" /><option value="常温" /></datalist>
        {entryMode === 'current' && <p className="food-note">{currentMatches.length ? `${name.trim()}の記録${currentMatches.length}件（${inventorySummary(currentMatches)}）を、新しい合計量で更新します。` : '同じ食材の記録がある場合は、その在庫を新しい合計量に更新します。'} 購入履歴は残ります。</p>}
        {entryMode === 'purchase' && <p className="food-note">購入済み・在庫に1回追加します。すでに購入済みにした品は、重ねて登録しないでください。</p>}
        <p className="food-note">1/2などの分数も入力できます。量が分からない場合は空欄のまま登録できます。</p>
        {entryError && <p className="food-error" role="alert">{entryError}</p>}
        <div className="food-form-actions"><button type="button" className="button secondary" onClick={() => setEntryOpen(false)}>取消</button><button type="submit" className="button primary"><Check size={17} />{entryMode === 'current' ? '現在量を更新' : '購入と在庫に追加'}</button></div>
      </form></div>}

      <div className="food-list-heading"><h3>食材一覧</h3><div className="food-filter" aria-label="食材の絞り込み"><button type="button" aria-pressed={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>すべて</button><button type="button" aria-pressed={filter === 'today'} className={filter === 'today' ? 'active' : ''} onClick={() => setFilter('today')}>今日買ったもの {todayCount}</button></div></div>
      {grouped.size ? <ul className="food-stock-list">{[...grouped.values()].map(group => <li className="food-stock-row" key={group.key}><div><strong>{group.name}</strong><span className="food-amount">{filter === 'today' ? `購入量：${purchaseSummary(group.rows)}` : inventorySummary(group.rows)}</span>{filter === 'today' && <small>現在量：{inventorySummary(inventory.filter(item => foodKey(item.name) === group.key))}</small>}<small>{[...new Set(group.rows.map(row => row.location).filter(Boolean))].join('・') || '保存場所なし'}</small></div><button type="button" className="button secondary" onClick={() => editGroup({ ...group, rows: inventory.filter(item => foodKey(item.name) === group.key) })} aria-label={`${group.name}の現在量を更新`}>量を更新</button></li>)}</ul>
        : <p className="food-empty">{filter === 'today' ? '今日の購入記録はありません。' : '食材はまだ登録されていません。「今ある量を登録」から追加できます。'}</p>}
      <button type="button" className="food-text-button" onClick={() => setTab('compare')}>料理に足りるか確認する <ChevronDown size={17} /></button>
    </div>}

    {tab === 'compare' && <div id="food-compare-panel" role="tabpanel" aria-labelledby="food-compare-tab">
      <div className="food-recipe-actions"><button type="button" className="button secondary" onClick={() => setRecipeEditing(true)}>{recipe ? '料理・材料を編集' : '料理・材料を入力'}</button>{!recipe && <button type="button" className="button secondary" onClick={() => onRecipe(GRATIN_RECIPE)}>今回のグラタンを使う</button>}</div>
      {recipeEditing && <RecipeEditor recipe={recipe} onSave={onRecipe} onClose={() => setRecipeEditing(false)} />}
      {!recipe && <div className="food-empty"><p>料理の材料を登録すると、2人分の必要量から在庫を差し引きます。</p><p>「今回のグラタン」は、送っていただいた動画の材料です。在庫は自動で登録しません。</p></div>}
      {recipe && <>
        <div className="food-recipe-heading"><h3>{recipe.title}</h3><span>2人分</span></div>
        {safeUrl(recipe.url) && <a className="food-source-link" href={safeUrl(recipe.url)} target="_blank" rel="noopener noreferrer">出典を見る <ExternalLink size={15} /></a>}
        <p className="food-note">比較だけでは在庫は減りません。gとkg、mlとLは換算します。パックとgなど、換算できない量は確認が必要です。</p>
        <ul className="food-comparison-list">{comparison.map((row, index) => <li className={`food-comparison-row food-status-${row.status}`} key={`${foodKey(row.name)}-${index}`}>
          <div className="food-comparison-heading"><strong>{row.name}</strong><span className="food-result">{row.status === 'enough' ? '足りる' : row.status === 'shortage' ? `不足 ${formatFoodQuantity(row.shortage ?? 0, row.unit)}` : '量を確認'}</span></div>
          <p className="food-comparison-amounts">必要：{row.required === null ? '要確認' : formatFoodQuantity(row.required, row.unit)}<span>{row.status === 'check' ? `在庫：要確認${row.have > 0 ? `（確認できた量 ${formatFoodQuantity(row.have, row.unit)}）` : ''}` : `在庫：${formatFoodQuantity(row.have, row.unit)}`}</span></p>
          {row.detail && <p className="food-note">{row.detail}</p>}
          {row.planned > 0 && <p className="food-planned">買い物リストに {formatFoodQuantity(row.planned, row.unit)} 追加済み</p>}
          <div className="food-row-actions"><button type="button" onClick={() => openEntry('current', row.name, row.unit)}>{row.status === 'check' ? '在庫を確認・入力' : '在庫を変更'}</button>{row.status === 'check' && <button type="button" onClick={() => writeCurrent(row.name, 0, row.unit, '冷蔵庫')}>家にない（0）</button>}</div>
        </li>)}</ul>
        <div className="food-shortage-actions"><button type="button" className="button primary" disabled={!additions.length} onClick={addShortages}><Plus size={18} />{additions.length ? `不足分を買い物リストへ（${additions.length}件）` : comparison.some(row => row.planned > 0) ? '不足分は買い物リストに追加済み' : '追加できる不足分はありません'}</button><button type="button" className="button secondary" onClick={onShowList}>買い物リストを見る</button></div>
        {comparison.some(row => row.status === 'check') && <p className="food-note">「量を確認」の材料は自動で買い物リストに追加しません。在庫と材料の量を確認してください。</p>}
        <details className="food-recipe-more"><summary>料理の切り替え・解除</summary><div className="food-recipe-actions"><button type="button" className="button secondary" onClick={() => onRecipe(GRATIN_RECIPE)}>今回のグラタンを使う</button><button type="button" className="button secondary" onClick={() => onRecipe(null)}>料理の比較を解除</button></div></details>
      </>}
    </div>}
  </section>;
}
