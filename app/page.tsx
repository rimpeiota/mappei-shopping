'use client';
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ShoppingBag, Package, History, Star, SlidersHorizontal, Search, Plus, MoreHorizontal, ChevronDown, ChevronRight, ArrowUpRight, Check, CheckCheck, Cloud, LoaderCircle, X, ArrowDownToLine, FileUp, Printer, Layers, Copy, ArrowLeftRight, RefreshCw, Box, AlertCircle, Sparkles, LayoutTemplate, Merge, Trash2, Circle, Utensils, Shirt, Zap, Armchair } from 'lucide-react';
import { useShoppingStore } from '@/lib/client-store';
import { type ShoppingItem, type ShoppingState, type ItemStatus, type Mode, type Template, STATUS_LABELS, CATEGORIES, COMPLETE, TODAY, newItem, uid, money, normalize, parseQuickText, validateState, itemTotal, isRestock, itemLink, needsProductName, togglePurchased, recordPurchasedQuantity, guessCategory, applyProductTitle } from '@/lib/client-model';
import { ItemSheet } from './components/item-sheet';
import { Modal } from './components/modal';
import { QuickComposer } from './components/quick-composer';
import { FoodPanel } from './components/food-panel';
import { applyCooking, undoCooking } from '@/lib/client-cooking';
import type { FoodRecipe } from '@/lib/client-food';
import './food.css';
const MODES: { id: Mode; label: string; icon: typeof ShoppingBag }[] = [ { id: 'list', label: 'リスト', icon: ShoppingBag }, { id: 'stock', label: '在庫', icon: Package }, { id: 'history', label: '履歴', icon: History }, { id: 'favorites', label: 'お気に入り', icon: Star }, { id: 'settings', label: '設定', icon: SlidersHorizontal } ];
const CATEGORY_ICON: Record<string, typeof Package> = { '食品': Utensils, '日用品': Box, '衣類': Shirt, '家電': Zap, '家具': Armchair, 'その他': Package };
const syncLabels: Record<string, string> = { loading: '接続中', local: '端末に保存', saving: '同期中', synced: '同期済み', offline: 'オフライン', error: '同期を再試行', conflict: '競合を確認', upgrade: '画面の更新が必要' };
const FILTERS: { id: string; label: string }[] = [{ id: 'all', label: 'すべて' }, { id: 'planned', label: '買う予定' }, { id: 'considering', label: '検討中' }, { id: 'cart', label: 'かごの中' }, { id: 'ordered', label: '注文済み' }, { id: 'snoozed', label: '次回' }];
function CategorySymbol({ category, small = false }: { category: string; small?: boolean }) { const Icon = CATEGORY_ICON[category] || Package; return <span className={`category-symbol ${category === '食品' ? 'green' : category === '日用品' ? 'lavender' : ''} ${small ? 'small' : ''}`}><Icon size={small ? 16 : 21} strokeWidth={1.7} /></span>; }
function Skeleton() { return <div className="loading-screen" role="status" aria-label="読み込み中"><div className="skeleton-sidebar"><i className="skeleton logo-skeleton" />{[1,2,3,4,5].map(n => <i key={n} className="skeleton nav-skeleton" />)}</div><div className="skeleton-content"><i className="skeleton title-skeleton" /><i className="skeleton subtitle-skeleton" /><div className="skeleton-stats">{[1,2,3].map(n => <i key={n} className="skeleton" />)}</div>{[1,2,3,4].map(n => <i key={n} className="skeleton row-skeleton" />)}<i className="skeleton composer-skeleton" /></div></div>; }
function ItemCard({ item, onEdit, onStatus, onName, onNameEditing, onAddAgain, onRestock, pending = false, inventory = false, history = false, checkable = false }: {
  item: ShoppingItem; onEdit: () => void; onStatus: () => void; onName: (name: string) => void;
  onNameEditing?: () => void; onAddAgain?: () => void; onRestock?: () => void; pending?: boolean; inventory?: boolean; history?: boolean; checkable?: boolean;
}) {
  const [name, setName] = useState('');
  const completed = item.status === 'purchased' || item.status === 'received';
  const url = itemLink(item);
  const missingName = needsProductName(item);
  const title = missingName ? '商品名を入力' : item.name;
  return <article className={`shopping-item ${completed ? 'is-complete' : ''}`}>
    {onAddAgain ? <button className="button secondary" aria-label={`${title}をリストに追加`} onClick={onAddAgain}><Plus size={18} />追加</button> : (!inventory && (!history || checkable)) ? <button type="button" role="checkbox" aria-checked={completed}
      className={`item-check ${completed ? 'checked' : ''}`} aria-label={`${title}を${completed ? '未購入に戻す' : '購入済みにする'}`} onClick={onStatus}>
      {completed && <Check size={22} />}<span className="sr-only">{completed ? '購入済み' : '未購入'}</span>
    </button> : <CategorySymbol category={item.category} />}
    <div className="item-info">
      <button type="button" className="item-main" onClick={onEdit} aria-label={`${title}の詳細`}>
        <span className="item-title">{title}</span>
        <span className="item-meta">{inventory ? <>{item.location || '場所未設定'}{item.expiry && ` · 期限 ${item.expiry}`}</> : <>
          {item.store}{item.store && item.status !== 'planned' && ' · '}
          {item.status !== 'planned' && STATUS_LABELS[item.status]}
          {item.price > 0 && ` · ${money(itemTotal(item))}`}
        </>}</span>
      </button>
      {url && <div className="item-link-meta"><a className="item-link" href={url} target="_blank" rel="noopener noreferrer">{item.inventorySource === 'recipe' ? 'レシピ' : '商品ページ'} <ArrowUpRight size={14} /></a><span>{new URL(url).hostname.replace(/^www\./, '')}</span></div>}
      {onRestock && <button className="text-button" onClick={onRestock}>買い物リストに追加</button>}
      {missingName && <>
        <p className="item-name-warning" role={pending ? 'status' : undefined}>{pending ? '商品名を取得中…' : '商品名を入力してください'}</p>
        <form className="link-name-form" onSubmit={e => { e.preventDefault(); if (name.trim()) onName(name.trim()); }}>
          <input aria-label="リンク商品の商品名" value={name} maxLength={500} placeholder="何を買う？" onChange={e => { onNameEditing?.(); setName(e.target.value); }} />
          <button className="button secondary" type="submit" disabled={!name.trim()}>保存</button>
        </form>
      </>}
    </div>
    <button type="button" className="item-end" onClick={onEdit} aria-label={`${title}の数量・詳細を編集`}>
      <span className="item-quantity">{item.stockKnown === false && (inventory || completed) ? '量未確認' : <>{inventory ? item.stock + item.spare : item.quantity}<small>{item.unit}</small></>}</span>
    </button>
  </article>;
}
function Empty({ mode, filtered, onAdd, onImport }: { mode: Mode; filtered: boolean; onAdd: () => void; onImport: () => void }) {
  return <div className="empty-state"><h3>{filtered ? '該当する商品はありません' : mode === 'stock' ? '在庫はありません' : mode === 'history' ? '購入履歴はありません' : mode === 'favorites' ? 'お気に入りはありません' : '買うものを追加してください'}</h3>
    {mode === 'stock' && <button className="button secondary" onClick={onAdd}><Plus size={18} />在庫を登録</button>}
    {mode === 'list' && !filtered && <button className="text-button" onClick={onImport}>既存リストを読み込む</button>}
  </div>;
}
export default function Home() {
  const { state, commit, ready, status, authenticated, storageError, storageScope, previousAccountLocal, conflict, resolveConflict, capability, retry } = useShoppingStore();
  const [mode, setMode] = useState<Mode>('list');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [category, setCategory] = useState('all');
  const [storeFilter, setStoreFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState('all');
  const [sort, setSort] = useState('manual');
  const [showFilters, setShowFilters] = useState(false);
  const [quick, setQuick] = useState('');
  const [aiPending, setAiPending] = useState(0);
  const [linkPending, setLinkPending] = useState<string[]>([]);
  const linkAttempts = useRef(new Set<string>());
  const linkManualEdits = useRef(new Set<string>());
  const linkInFlight = useRef(0);
  const [aiCheck, setAiCheck] = useState('');
  const [aiChecking, setAiChecking] = useState(false);
  const [editing, setEditing] = useState<ShoppingItem | null>(null);
  const [modal, setModal] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: ShoppingState; key: number } | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [importText, setImportText] = useState('');
  const [pendingImport, setPendingImport] = useState<ShoppingState | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [duplicateId, setDuplicateId] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const draftLoaded = useRef('');
  const closing = useCallback(() => { setModal(null); setPendingImport(null); }, []);
  const closeDetail = useCallback(() => setEditing(null), []);
  const notify = useCallback((text: string, undo?: ShoppingState) => { setToast({ text, undo, key: Date.now() }); }, []);
  useEffect(() => { if (!toast) return; const timeout = setTimeout(() => setToast(null), toast.undo ? 9000 : 4800); return () => clearTimeout(timeout); }, [toast]);
  useEffect(() => { document.documentElement.dataset.motion = state.settings.reducedMotion ? 'reduced' : 'full'; }, [state.settings.reducedMotion]);
  useEffect(() => {
    let active = true;
    const draftKey = storageScope + ':composer';
    const preservePrevious = !draftLoaded.current || draftLoaded.current === draftKey || draftLoaded.current.endsWith(':anonymous:composer');
    const params = new URLSearchParams(window.location.search);
    const text = [params.get('title'), params.get('text'), params.get('url')].filter(Boolean).join(' ');
    queueMicrotask(() => { if (!active) return; try { const saved = localStorage.getItem(draftKey) || ''; setQuick(previous => text || (preservePrevious ? previous : '') || saved); } catch { /* The list storage indicator reports unavailable browser storage. */ } draftLoaded.current = draftKey; });
    if (text) window.history.replaceState({}, '', window.location.pathname);
    return () => { active = false; };
  }, [storageScope]);
  useEffect(() => { const draftKey = storageScope + ':composer'; if (draftLoaded.current !== draftKey) return; try { if (quick) localStorage.setItem(draftKey, quick); else localStorage.removeItem(draftKey); } catch { /* Keep the visible draft available for copying. */ } }, [quick, storageScope]);
  useEffect(() => {
    const input = inputRef.current; if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.max(44, Math.min(input.scrollHeight, 144))}px`;
  }, [quick, ready, mode]);
  const active = useMemo(() => state.items.filter(item => !item.inventoryOnly && !COMPLETE.includes(item.status)), [state.items]);
  const cart = active.filter(item => item.status === 'cart');
  const stock = useMemo(() => state.items.filter(item => item.stock > 0 || item.spare > 0 || item.checkedAt), [state.items]);
  const favorites = useMemo(() => state.items.filter(item => item.favorite), [state.items]);
  const completed = useMemo(() => state.items.filter(item => COMPLETE.includes(item.status)), [state.items]);
  const total = active.filter(item => item.status !== 'snoozed').reduce((sum, item) => sum + itemTotal(item), 0);
  const restocks = stock.filter(isRestock);
  const [sevenDays] = useState(() => new Date(Date.now() + 7 * 86400000).toLocaleDateString('sv-SE'));
  const ending = stock.filter(item => item.expiry && item.expiry <= sevenDays);
  const stores = [...new Set(state.items.map(item => item.store).filter(Boolean))];
  const dates = [...new Set(state.items.map(item => item.listDate).filter(Boolean))].sort().reverse();
  const duplicateNames = useMemo(() => { const counts = new Map<string, number>(); for (const item of active) { const key = normalize(item.name) + item.unit; counts.set(key, (counts.get(key) || 0) + 1); } return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name)); }, [active]);
  const visible = useMemo(() => {
    const source = mode === 'stock' ? stock : mode === 'history' ? completed : mode === 'favorites' ? favorites : active;
    let result = source.filter(item => (mode !== 'list' || filter === 'all' || item.status === filter) && (category === 'all' || item.category === category) && (storeFilter === 'all' || item.store === storeFilter) && (dateFilter === 'all' || item.listDate === dateFilter) && (!search || normalize([item.name, item.aliases, item.brand, item.model, item.category, item.store, item.location].join(' ')).includes(normalize(search))));
    if (sort === 'category') result = [...result].sort((a,b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
    if (sort === 'store') result = [...result].sort((a,b) => a.store.localeCompare(b.store, 'ja'));
    if (sort === 'expiry') result = [...result].sort((a,b) => (a.expiry || '9999').localeCompare(b.expiry || '9999'));
    if (sort === 'route') result = [...result].sort((a,b) => Number(/冷凍|アイス|冷蔵/.test(a.name)) - Number(/冷凍|アイス|冷蔵/.test(b.name)) || Number(/米|水|ケース/.test(a.name)) - Number(/米|水|ケース/.test(b.name)));
    if (mode === 'history' && sort === 'manual') result = [...result].reverse();
    return result;
  }, [active, stock, completed, favorites, mode, filter, category, storeFilter, dateFilter, search, sort]);
  const change = (items: ShoppingItem[], text: string, undo = true) => { const before = state; commit(old => ({ ...old, items, activity: [{ id: uid(), text, at: new Date().toISOString() }, ...old.activity].slice(0, 200) })); notify(text, undo ? before : undefined); };
  const cookRecipe = (recipe: FoodRecipe, targetServings: number, id: string) => {
    let message = 'この料理は反映済みです';
    commit(old => {
      const result = applyCooking(old.items, old.cookingHistory, recipe, targetServings, id);
      if (result.error) { message = result.error; return old; }
      if (result.items === old.items) return old;
      const count = result.record?.rows.filter(row => row.status === 'ready').length ?? 0;
      message = `${recipe.title}の材料${count}件を在庫から減らしました`;
      return { ...old, items: result.items, cookingHistory: result.history, activity: [{ id: uid(), text: message, at: new Date().toISOString() }, ...old.activity].slice(0, 200) };
    });
    notify(message);
  };
  const undoCook = (id: string) => {
    let message = '料理の反映を取り消しました';
    commit(old => {
      const result = undoCooking(old.items, old.cookingHistory, id);
      if (result.error) { message = result.error; return old; }
      if (result.items === old.items) return old;
      return { ...old, items: result.items, cookingHistory: result.history, activity: [{ id: uid(), text: message, at: new Date().toISOString() }, ...old.activity].slice(0, 200) };
    });
    notify(message);
  };
  const updateItem = (id: string, patch: Partial<ShoppingItem>, text: string) => change(state.items.map(item => item.id === id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item), text);

  const copyItem = (item: ShoppingItem) => { const copy = newItem(item.name, { ...item, id: uid(), status: 'planned', listDate: TODAY(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), purchasedAt: '', purchasedQuantity: 0, stock: 0, spare: 0, checkedAt: '', inventoryOnly: false, stockKnown: true, inventorySource: '', stockReconciledQuantity: 0, attachments: [], prices: [] }); change([...state.items, copy], `${item.name}をリストに追加`); setEditing(null); setMode('list'); };
  const addQuick = async () => {
    const text = quick.trim(); if (!text) return;
    const added = parseQuickText(text, state.settings.defaultStore); if (!added.length) return;
    setQuick(''); change([...state.items, ...added], `${added.length}件追加しました`); setMode('list'); setFilter('all'); setSearch('');
    const duplicate = added.find(item => state.items.some(old => normalize(old.name) === normalize(item.name) && (old.stock > 0 || old.status === 'ordered')));
    if (duplicate) notify(`${duplicate.name}は在庫・注文中の商品にもあります`, state);
    if (!authenticated || !navigator.onLine || added.some(item => itemLink(item))) return;
    setAiPending(n => n + 1);
    try {
      const response = await fetch('/api/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (!response.ok) return;
      const result = await response.json() as { items?: { name: string; quantity: number; unit: string; category: string; store?: string }[]; engine?: string };
      if (result.engine === 'workers-ai' && result.items?.length === added.length) {
        const parsed = result.items;
        commit(old => ({ ...old, items: old.items.map(item => { const at = added.findIndex(a => a.id === item.id && a.updatedAt === item.updatedAt); if (at < 0) return item; const field = parsed[at]; if (!field || typeof field.name !== 'string') return item; return { ...item, name: field.name.slice(0, 500), quantity: Number(field.quantity) > 0 ? Number(field.quantity) : item.quantity, unit: field.unit || item.unit, category: CATEGORIES.includes(field.category) ? field.category : item.category, store: field.store || item.store }; }) }));
      }
    } catch { /* The captured local memo remains intact. */ }
    finally { setAiPending(n => Math.max(0, n - 1)); }
  };
  const checkAi = async () => {
    setAiChecking(true); setAiCheck('');
    try {
      const response = await fetch('/api/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '牛乳2本、卵1パック' }) });
      const result = await response.json() as { engine?: string; message?: string; error?: string };
      setAiCheck(response.ok && result.engine === 'workers-ai' ? 'Workers AIの応答を確認しました' : result.message || result.error || '接続を確認できませんでした');
    } catch { setAiCheck('接続を確認できませんでした。通信状態を確認してください。'); }
    finally { setAiChecking(false); }
  };
  useEffect(() => {
    if (!ready || !authenticated || !navigator.onLine) return;
    for (const item of state.items.filter(needsProductName)) {
      const url = itemLink(item), key = item.id + ':' + url;
      if (linkAttempts.current.has(key) || linkInFlight.current >= 3) continue;
      linkAttempts.current.add(key); linkInFlight.current += 1;
      setLinkPending(ids => [...ids, item.id]);
      void (async () => {
        try {
          const response = await fetch('/api/link-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
          if (!response.ok) return;
          const result = await response.json() as { resolved?: boolean; title?: string };
          if (!result.resolved || !result.title?.trim()) return;
          commit(old => ({ ...old, items: old.items.map(current => current.id === item.id
            ? applyProductTitle(current, url, result.title!, linkManualEdits.current.has(key)) : current) }));
        } catch { /* The URL and local memo stay available for manual naming. */ }
        finally { linkInFlight.current -= 1; setLinkPending(ids => ids.filter(id => id !== item.id)); }
      })();
    }
  }, [ready, authenticated, state.items, commit, linkPending.length]);
  const toggleItem = (item: ShoppingItem) => {
    const next = togglePurchased(item);
    change(state.items.map(old => old.id === item.id ? next : old), `${item.name}を${next.status === 'planned' ? '未購入' : '購入済み'}にしました`);
  };
  const exportFile = (name: string, content: string, type: string) => { const url = URL.createObjectURL(new Blob([content], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notify('ファイルを書き出しました'); };
  const markdown = () => ['# 買い物リスト', '', ...state.items.filter(item => !item.inventoryOnly).map(item => `- [${COMPLETE.includes(item.status) ? 'x' : ' '}] ${item.name} ${item.quantity}${item.unit}${item.store ? ` @${item.store}` : ''}${item.url ? ` ${item.url}` : ''}`)].join('\n');
  const readFile = async (file?: File) => { if (!file) return; if (file.size > 12 * 1024 * 1024) { notify('12MB以下のファイルを選んでください'); return; } try { const text = await file.text(); if (file.name.endsWith('.json')) { const restored = validateState(JSON.parse(text)); if (!restored) { notify('対応するバックアップではありません'); return; } setPendingImport(restored); setModal('import'); } else { setImportText(text); setModal('import'); } } catch { notify('読み込めませんでした。ファイル形式を確認してください'); } if (fileRef.current) fileRef.current.value = ''; };
  const importMarkdown = () => { const lines = importText.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')); const imported = lines.flatMap(line => { const done = /^[-*]\s*\[[xX]\]/.test(line); return parseQuickText(line.replace(/^[-*]\s*(\[[ xX]\]\s*)?/, ''), state.settings.defaultStore).map(item => ({ ...item, status: done ? 'purchased' as ItemStatus : 'planned' as ItemStatus })); }); if (!imported.length) { notify('読み込む商品を入力してください'); return; } change([...state.items, ...imported], `${imported.length}件を読み込みました`); setImportText(''); setModal(null); };
  const moveItem = (id: string, direction: number) => {
    const items = [...state.items], from = items.findIndex(item => item.id === id), to = from + direction;
    if (from < 0 || to < 0 || to >= items.length) return;
    const [item] = items.splice(from, 1); items.splice(to, 0, item); change(items, '順番を変更しました');
  };
  const addTemplate = (template: Template) => { const items = template.items.map(item => newItem(item.name, item)); change([...state.items, ...items], `${template.name}から${items.length}件追加`); setModal(null); setMode('list'); };
  const mergeDuplicate = (name: string) => { const matches = active.filter(item => normalize(item.name) + item.unit === name); if (matches.length < 2) return; const first = matches[0]; const ids = new Set(matches.slice(1).map(item => item.id)); change(state.items.filter(item => !ids.has(item.id)).map(item => item.id === first.id ? { ...item, quantity: matches.reduce((sum, match) => sum + match.quantity, 0) } : item), `${first.name}を1件にまとめました`); setDuplicateId(''); };
  const [showCompleted, setShowCompleted] = useState(true);
  const checkedItems = state.items.filter(item => (item.status === 'purchased' || item.status === 'received') && filter === 'all'
    && (category === 'all' || item.category === category) && (storeFilter === 'all' || item.store === storeFilter)
    && (dateFilter === 'all' || item.listDate === dateFilter) && (!search || normalize(item.name).includes(normalize(search))));
  const switchMode = (next: Mode) => { setMode(next); setSearch(''); setCategory('all'); setStoreFilter('all'); setDateFilter('all'); setFilter('all'); setShowFilters(false); setShowSearch(false); };
  const filtered = !!search || category !== 'all' || storeFilter !== 'all' || dateFilter !== 'all' || (mode === 'list' && filter !== 'all');
  const modalOpen = !!editing || !!modal || !!conflict;
  const createStock = () => setEditing(newItem('', { checkedAt: TODAY(), stock: 1, inventoryOnly: true, inventorySource: 'current' }));
  if (!ready) return <Skeleton />;
  return <>
    <div className="app-shell" inert={modalOpen}>
      <aside className="sidebar">
        <button className="brand" onClick={() => setMode('list')} aria-label="買い物管理 ホーム"><ShoppingBag size={24} /><span>買い物</span></button>
        <nav aria-label="メインナビゲーション">{MODES.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${mode === id ? 'active' : ''}`} onClick={() => switchMode(id)} aria-current={mode === id ? 'page' : undefined}><Icon size={20} /><span>{label}</span></button>)}</nav>
      </aside>
      <main className="workspace">
        <header className="topbar"><span className="breadcrumb">{state.settings.name || 'マイリスト'}</span><button className={`sync-status ${status === 'synced' ? 'is-synced' : ''}`} onClick={() => { if (status === 'error' || status === 'offline') void retry(); else setMode('settings'); }} aria-label={`保存状態: ${syncLabels[status]}`}><Cloud size={17} />{syncLabels[status]}</button></header>
        <div className="content-grid"><section className="main-column">
          <div className="page-heading"><h1>{mode === 'list' ? '買い物リスト' : MODES.find(row => row.id === mode)?.label}</h1><div className="heading-actions">{mode !== 'settings' && mode !== 'stock' && <button className="text-button" aria-label="商品を検索" aria-expanded={showSearch} onClick={() => setShowSearch(value => !value)}><Search size={19} /><span>検索</span></button>}<button className="text-button" aria-label="その他の操作" onClick={() => setModal('tools')}><MoreHorizontal size={20} /><span>その他</span></button></div></div>
          {previousAccountLocal && <p className="inline-info">この端末の記録を表示しています。ログインを確認してから同期します。</p>}
      {mode === 'list' && <QuickComposer key={storageScope} value={quick} onChange={setQuick} onSubmit={() => void addQuick()} inputRef={inputRef} aiPending={aiPending} scope={storageScope} />}
          {mode === 'stock' && <FoodPanel key={storageScope} items={state.items} recipe={state.mealRecipe} cookingHistory={state.cookingHistory} onCook={cookRecipe} onUndoCooking={undoCook} onItems={change} onRecipe={recipe => { const before = state; commit(old => ({ ...old, mealRecipe: recipe })); notify(recipe ? '材料を保存しました' : '材料を解除しました', before); }} onShowList={() => switchMode('list')} onEditItem={setEditing} />}
          {mode === 'stock' && <details className="detail-advanced food-stock-details"><summary>在庫の詳細・日用品</summary><p className="field-note">買い足し候補 {restocks.length}件 · 7日以内の期限 {ending.length}件</p><button className="button secondary" onClick={createStock}><Plus size={18} />その他の在庫を登録</button><div className="items-list" aria-label="在庫の詳細">{stock.map(item => <ItemCard key={item.id} item={item} inventory onEdit={() => setEditing(item)} onStatus={() => toggleItem(item)} onRestock={isRestock(item) ? () => copyItem(item) : undefined} onName={name => updateItem(item.id, { name }, '商品名を保存しました')} />)}</div></details>}
          {status === 'upgrade' && <p className="inline-info" role="alert">新しい機能の保存形式に更新されました。端末のメモは残っています。<button className="text-button" onClick={() => window.location.reload()}>画面を再読み込み</button></p>}
          {mode !== 'settings' && mode !== 'stock' && <>
            {showSearch && <div className="search-bar"><Search size={19} /><input autoFocus aria-label="商品を検索" placeholder="商品名で検索" value={search} onChange={event => setSearch(event.target.value)} /><button className="icon-button" aria-label="検索を閉じる" onClick={() => { setSearch(''); setShowSearch(false); }}><X size={20} /></button></div>}
            <div className="list-toolbar"><span className="list-count">{mode === 'list' ? `未購入 ${visible.length}件` : `${visible.length}件`}</span><button className="text-button" aria-expanded={showFilters} onClick={() => setShowFilters(value => !value)}><SlidersHorizontal size={18} />絞り込み{filtered ? '中' : ''}</button></div>
            {showFilters && <div className="filter-panel">
              {mode === 'list' && <label className="field"><span>状態</span><select aria-label="状態で絞り込み" value={filter} onChange={event => setFilter(event.target.value)}>{FILTERS.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label>}
              <label className="field"><span>カテゴリ</span><select aria-label="カテゴリで絞り込み" value={category} onChange={event => setCategory(event.target.value)}><option value="all">すべて</option>{CATEGORIES.map(value => <option key={value}>{value}</option>)}</select></label>
              <label className="field"><span>購入先</span><select aria-label="購入先で絞り込み" value={storeFilter} onChange={event => setStoreFilter(event.target.value)}><option value="all">すべて</option>{stores.map(value => <option key={value}>{value}</option>)}</select></label>
              <label className="field"><span>日付</span><select aria-label="日付で絞り込み" value={dateFilter} onChange={event => setDateFilter(event.target.value)}><option value="all">すべて</option>{dates.map(value => <option key={value}>{value}</option>)}</select></label>
              <label className="field"><span>並び順</span><select aria-label="並び順" value={sort} onChange={event => setSort(event.target.value)}><option value="manual">追加した順</option><option value="category">カテゴリ順</option><option value="store">購入先順</option><option value="route">冷凍品を最後に</option><option value="expiry">期限が近い順</option></select></label>
              <button className="text-button" onClick={() => { setFilter('all'); setCategory('all'); setStoreFilter('all'); setDateFilter('all'); setSearch(''); }}>絞り込みを解除</button>
            </div>}
            <div className="items-list" aria-label={mode === 'list' ? '買い物リスト' : MODES.find(row => row.id === mode)?.label}>
              {visible.map(item => <ItemCard key={item.id} item={item} history={mode === 'history'} pending={linkPending.includes(item.id)} onNameEditing={() => linkManualEdits.current.add(item.id + ':' + itemLink(item))} onAddAgain={mode === 'favorites' ? () => copyItem(item) : undefined} onEdit={() => setEditing(item)} onStatus={() => toggleItem(item)} onName={name => updateItem(item.id, { name, url: itemLink(item), category: guessCategory(name) }, '商品名を保存しました')} />)}
              {!visible.length && <Empty mode={mode} filtered={filtered} onAdd={() => inputRef.current?.focus()} onImport={() => setModal('import')} />}
            </div>
            {mode === 'list' && checkedItems.length > 0 && <section className="checklist-completed"><button className="text-button" aria-expanded={showCompleted} onClick={() => setShowCompleted(value => !value)}><ChevronDown size={18} />購入済み {checkedItems.length}件</button>{showCompleted && <div className="items-list" aria-label="購入済みの商品">{checkedItems.map(item => <ItemCard key={item.id} item={item} checkable history onEdit={() => setEditing(item)} onStatus={() => toggleItem(item)} onName={name => updateItem(item.id, { name }, '商品名を保存しました')} />)}</div>}</section>}
          </>}
      {mode === 'settings' && <div className="settings-panel"><div className="settings-section glass"><div className="section-heading"><h3><Cloud size={17} />保存と同期</h3><span className={`connection-badge ${authenticated ? 'connected' : ''}`}>{authenticated ? '接続済み' : '未ログイン'}</span></div><div className="setting-line"><div><b>この端末</b><small>{storageError ? '保存エラー' : '変更を自動保存'}</small></div><Check size={17} className={storageError ? 'text-coral' : 'text-green'} /></div><div className="setting-line"><div><b>Cloudflare D1</b><small>{syncLabels[status]}</small></div>{authenticated ? <button className="button secondary small" onClick={() => void retry()}><RefreshCw size={14} />同期</button> : <a className="button secondary small" href="/signin-with-chatgpt?return_to=/">ログイン<ArrowUpRight size={14} /></a>}</div>{!authenticated && <p className="field-note">未ログインのメモはこの端末に保存されます。クラウド同期・AI補完・添付の保存にはログインが必要です。</p>}</div>
      <div className="settings-section glass">
        <div className="section-heading"><h3><Sparkles size={17} />AI補完</h3><span className="connection-badge">{capability.ai === 'configured' ? '設定済み' : '未設定'}</span></div>
        <div className="setting-line"><span>Workers AI</span><button className="button secondary small" disabled={!authenticated || aiChecking} onClick={() => void checkAi()}>{aiChecking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}AI接続を確認</button></div>
        {aiCheck && <p className="field-note" role="status">{aiCheck}</p>}
      </div>
      <div className="settings-section glass"><div className="section-heading"><h3><SlidersHorizontal size={17} />表示と入力</h3></div><label className="setting-line"><span>表示名</span><input aria-label="表示名" value={state.settings.name} placeholder="マイリスト" onChange={e => commit(old => ({ ...old, settings: { ...old.settings, name: e.target.value } }))} /></label><label className="setting-line"><span>よく使う購入先</span><input aria-label="よく使う購入先" value={state.settings.defaultStore} placeholder="未設定" onChange={e => commit(old => ({ ...old, settings: { ...old.settings, defaultStore: e.target.value } }))} /></label><label className="setting-line"><span>買い物予算</span><div className="setting-number"><input type="number" min="0" aria-label="買い物予算" value={state.settings.budget || ''} placeholder="未設定" onChange={e => commit(old => ({ ...old, settings: { ...old.settings, budget: Math.max(0, Number(e.target.value)) } }))} /><small>円</small></div></label><label className="setting-line"><div><b>アニメーションを減らす</b><small>端末の設定も優先します</small></div><input className="switch" type="checkbox" checked={state.settings.reducedMotion} onChange={e => commit(old => ({ ...old, settings: { ...old.settings, reducedMotion: e.target.checked } }))} /></label></div>
      <div className="settings-section glass"><div className="section-heading"><h3><ArrowDownToLine size={17} />バックアップと連携</h3></div><button className="setting-action" onClick={() => exportFile(`shopping-${TODAY()}.json`, JSON.stringify(state, null, 2), 'application/json')}><span><b>バックアップを書き出す</b><small>全記録・設定をJSONで保存</small></span><ArrowDownToLine size={18} /></button><button className="setting-action" onClick={() => fileRef.current?.click()}><span><b>バックアップを読み込む</b><small>内容を確認してから復元</small></span><FileUp size={18} /></button><button className="setting-action" onClick={() => exportFile(`買い物リスト-${TODAY()}.md`, markdown(), 'text/markdown')}><span><b>Obsidian用Markdownを書き出す</b><small>自動同期は未接続</small></span><ArrowUpRight size={18} /></button><button className="setting-action" onClick={() => setModal('import')}><span><b>既存の買い物ノートを読み込む</b><small>チェックリスト形式・テキスト・JSON</small></span><ChevronRight size={18} /></button></div>
      <div className="settings-section glass"><a className="setting-action" href="/recover"><span><b>端末に残るデータを探す</b><small>別の保存枠・旧版・入力下書きを読み取り専用で確認</small></span><ChevronRight size={18} /></a></div>
      <div className="settings-section glass"><div className="section-heading"><h3><Layers size={17} />接続状況</h3></div>{['家族との共有・権限・通知', '価格取得・価格アラート', '位置情報による店舗通知', '画像・レシートの文字抽出', 'Obsidianとの自動同期'].map(name => <div className="setting-line" key={name}><span>{name}</span><span className="connection-badge">未接続</span></div>)}<button className="setting-action" onClick={() => setModal('diagnostics')}><span>技術・APIの接続診断</span><ChevronRight size={17} /></button></div>
      <div className="settings-version">買い物管理 <span>v0.1.0</span></div></div>}
        </section></div>
      </main>
      <nav className="mobile-nav" aria-label="モバイルナビゲーション">{MODES.map(({ id, label, icon: Icon }) => <button key={id} aria-label={label} className={mode === id ? 'active' : ''} aria-current={mode === id ? 'page' : undefined} onClick={() => switchMode(id)}><Icon size={21} /><span>{label}</span></button>)}</nav>
    </div>
    <input className="hidden-file" ref={fileRef} type="file" accept=".json,.md,.txt,text/plain,application/json,text/markdown" onChange={e => void readFile(e.target.files?.[0])} />
    {toast && <div className="toast glass" role="status" key={toast.key}><span className="toast-check"><Check size={15} /></span><span>{toast.text}</span>{toast.undo && <button onClick={() => { commit(toast.undo!); notify('元に戻しました'); }}>元に戻す</button>}<button className="icon-button small" aria-label="メッセージを閉じる" onClick={() => setToast(null)}><X size={14} /></button></div>}
    {editing && <ItemSheet onMove={direction => moveItem(editing.id, direction)} item={editing} authenticated={authenticated} onClose={closeDetail} toast={notify} onSave={item => { const exists = state.items.some(old => old.id === item.id); change(exists ? state.items.map(old => old.id === item.id ? item : old) : [...state.items, item], `${item.name}を保存しました`); setEditing(null); }} onDelete={id => { change(state.items.filter(item => item.id !== id), '商品を削除しました'); setEditing(null); }} onCopy={copyItem} />}
    {conflict && <Modal title={conflict.kind === 'migration' ? '端末のメモを同期' : conflict.legacy ? '旧版の端末データを確認' : '同期の競合'} onClose={() => { if (conflict.kind === 'migration') resolveConflict('stay'); else notify('保存するデータを選んでください'); }}><div className="conflict-content"><AlertCircle size={30} /><p>{conflict.kind === 'migration' ? 'ログイン前のメモがこの端末にあります。現在のアカウントへ追加してよいか選択してください。選択するまで端末のメモは送信しません。料理の材料が両方にある場合は、先に端末のバックアップを保存してください。同期ではクラウド側の材料を残します。' : conflict.legacy ? '旧版の画面で編集した端末データです。クラウドには新しい在庫・材料の項目があるため、自動では上書きしません。端末のバックアップを保存してから、残す内容を選んでください。' : 'クラウドとこの端末の両方に変更があります。上書きする前にバックアップを保存できます。'}</p><div className="conflict-count"><span>この端末 <b>{state.items.length}点</b></span><span>クラウド <b>{conflict.state.items.length}点</b></span></div><button className="button secondary" onClick={() => exportFile(`shopping-local-${TODAY()}.json`, JSON.stringify(state, null, 2), 'application/json')}><ArrowDownToLine size={16} />端末のバックアップ</button><button className="button primary" onClick={() => resolveConflict('local')}>{conflict.kind === 'migration' ? 'このアカウントにメモを追加して同期' : 'この端末の内容でクラウドを更新'}</button><button className="button secondary" onClick={() => resolveConflict(conflict.kind === 'migration' ? 'stay' : 'remote')}>{conflict.kind === 'migration' ? 'この端末だけで続ける' : 'クラウドの内容をこの端末に反映'}</button></div></Modal>}
    {modal === 'tools' && <Modal title="操作" onClose={closing}>
      <div className="checkout-summary"><span>未購入の予定金額</span><strong>{money(total)}</strong></div>
      {state.settings.budget > 0 && <p className="field-note">予算 {money(state.settings.budget)} · 残額 {money(state.settings.budget - total)}</p>}
      {cart.length > 0 && <button className="button secondary full-width" onClick={() => setModal('checkout')}>会計前の確認（かごの中 {cart.length}件）</button>}
      <div className="tools-grid">{[{ name:'定番セット', icon:LayoutTemplate, action:() => setModal('templates') }, { name:'商品比較', icon:ArrowLeftRight, action:() => setModal('compare') }, { name:'重複を整理', icon:Merge, action:() => setModal('duplicates') }, { name:'リストを読み込む', icon:FileUp, action:() => setModal('import') }, { name:'バックアップ', icon:ArrowDownToLine, action:() => exportFile(`shopping-${TODAY()}.json`, JSON.stringify(state,null,2),'application/json') }, { name:'印刷', icon:Printer, action:() => { closing(); setTimeout(() => window.print(),100); } }, { name:'Markdown', icon:Copy, action:() => exportFile(`買い物-${TODAY()}.md`,markdown(),'text/markdown') }, { name:'在庫を登録', icon:Package, action:() => { closing(); createStock(); } }].map(({ name, icon:Icon, action }) => <button className="glass" onClick={action} key={name}><Icon size={23} /><span>{name}</span></button>)}</div><details className="detail-advanced"><summary>最近の操作</summary>{state.activity.slice(0,10).map(event => <p className="field-note" key={event.id}>{event.text} · {new Date(event.at).toLocaleString('ja-JP')}</p>)}</details></Modal>}
    {modal === 'import' && <Modal title={pendingImport ? 'バックアップの復元' : 'リストを読み込む'} onClose={closing} footer={pendingImport ? <><button className="button secondary" onClick={() => { const ids = new Set(state.items.map(item => item.id)); change([...state.items, ...pendingImport.items.filter(item => !ids.has(item.id))], 'バックアップの商品を追加しました'); closing(); }}>商品を追加</button><button className="button primary" onClick={() => { const before=state; commit(pendingImport); notify('バックアップを復元しました', before); closing(); }}>全体を復元</button></> : <button className="button primary" onClick={importMarkdown}><Plus size={16} />リストに追加</button>}>
      {pendingImport ? <div className="import-preview"><FileUp size={32} /><h3>{pendingImport.items.length}点の商品</h3><p>全体を復元すると、現在のリストと設定が置き換わります。「商品を追加」は同じIDを除いて商品だけ追加します。</p></div> : <><button className="file-drop glass" onClick={() => fileRef.current?.click()}><FileUp size={25} /><b>ファイルを選択</b><span>JSON · Markdown · テキスト</span></button><div className="or-divider"><span>またはテキストを貼り付け</span></div><textarea className="import-textarea" aria-label="読み込む買い物リスト" placeholder={'- [ ] 牛乳 2本\n- [ ] 卵 1パック'} value={importText} onChange={e => setImportText(e.target.value)} rows={8} /><p className="field-note">この端末で読み取ります。既存ノートの原本は変更しません。</p></>}
    </Modal>}
    {modal === 'templates' && <Modal title="定番セット" onClose={closing}><div className="template-list">{state.templates.map(template => <div className="template-card glass" key={template.id}><div><Layers size={21} /><span><b>{template.name}</b><small>{template.items.map(item => item.name).join('、')}</small></span></div><button className="icon-button small" aria-label={`${template.name}を削除`} onClick={() => { commit(old => ({ ...old,templates:old.templates.filter(t => t.id !== template.id) })); notify('定番セットを削除しました'); }}><Trash2 size={15} /></button><button className="button secondary small" onClick={() => addTemplate(template)}><Plus size={14} />追加</button></div>)}{!state.templates.length && <div className="small-empty"><Layers size={30} /><p>登録されたセットはありません</p></div>}</div><div className="subheading">現在のリストから作成</div><label className="field"><span>セット名</span><input value={templateName} placeholder="いつもの日用品" onChange={e => setTemplateName(e.target.value)} /></label><p className="field-note">買い物リストの未購入商品{active.length}点を、品名・数量・購入先のセットとして保存します。</p><button className="button primary full-width" disabled={!templateName.trim() || !active.length} onClick={() => { commit(old => ({ ...old,templates:[...old.templates,{ id:uid(),name:templateName.trim(),items:active.map(({ name,quantity,unit,category,store }) => ({ name,quantity,unit,category,store })) }] })); setTemplateName(''); notify('定番セットを保存しました'); }}><Plus size={16} />セットを保存</button></Modal>}
    {modal === 'duplicates' && <Modal title="重複を整理" onClose={closing}><p className="field-note">名前と単位が同じ商品を確認して、数量を合算します。価格・詳細は最初の商品を残します。</p>{!duplicateNames.size && <div className="small-empty"><CheckCheck size={30} /><p>重複する商品はありません</p></div>}{[...duplicateNames].map(name => { const matches = active.filter(item => normalize(item.name)+item.unit===name); return <div className="duplicate-card glass" key={name}><div><b>{matches[0].name}</b><span>{matches.map(item => `${item.quantity}${item.unit}${item.store ? ` (${item.store})` : ''}`).join(' + ')}</span></div><button className="button secondary small" onClick={() => setDuplicateId(duplicateId === name ? '' : name)}>確認</button>{duplicateId === name && <div className="duplicate-confirm"><p>{matches.length}件を{matches.reduce((sum,item) => sum+item.quantity,0)}{matches[0].unit}の1件にまとめますか？</p><button className="button primary small" onClick={() => mergeDuplicate(name)}>まとめる</button></div>}</div>; })}</Modal>}
    {modal === 'compare' && <Modal title="商品比較" onClose={closing} wide><p className="field-note">比較する商品を2点選択してください。</p><div className="compare-selectors">{[0,1].map(index => <select aria-label={`比較する商品${index+1}`} key={index} value={compareIds[index] || ''} onChange={e => setCompareIds(old => { const next=[...old]; next[index]=e.target.value; return next; })}><option value="">商品を選択</option>{state.items.filter(item => item.id !== compareIds[1-index]).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>)}</div>{compareIds.length>=2 && compareIds.every(Boolean) && <div className="comparison-table"><table><thead><tr><th>項目</th>{compareIds.map(id => <th key={id}>{state.items.find(item => item.id===id)?.name}</th>)}</tr></thead><tbody>{[['価格','price'],['送料','shipping'],['割引','discount'],['維持費・消耗品費','runningCost'],['支払額','total'],['数量','quantity'],['単価（100単位）','unitPrice'],['ブランド','brand'],['型番','model'],['サイズ','size'],['容量','capacity'],['購入先','store'],['規格・対応品','compatibility']].map(([label,key]) => <tr key={key}><th>{label}</th>{compareIds.map(id => { const item=state.items.find(row=>row.id===id); if(!item)return <td key={id}>—</td>; const value=key==='total'?money(itemTotal(item)):key==='unitPrice'?item.measure?`${money(item.price/item.measure*100)}/100${item.measureUnit}`:'—':['price','shipping','discount','runningCost'].includes(key)?money(Number(item[key as keyof ShoppingItem])):String(item[key as keyof ShoppingItem]||'—'); return <td key={id}>{value}</td>; })}</tr>)}</tbody></table></div>}{state.items.length<2 && <div className="small-empty"><ArrowLeftRight size={30} /><p>商品が2点以上必要です</p></div>}</Modal>}
    {modal === 'checkout' && <Modal title="会計前の確認" onClose={closing} footer={<button className="button primary" onClick={() => { const ids=new Set(cart.map(item=>item.id)); change(state.items.map(item=>ids.has(item.id)?recordPurchasedQuantity(item,item.quantity):item), `${cart.length}点の購入を記録しました`); closing(); }}><CheckCheck size={17} />{cart.length}点を購入済みにする</button>}><div className="checkout-summary"><span>かごの中</span><b>{cart.length}点</b><strong>{money(cart.reduce((sum,item)=>sum+itemTotal(item),0))}</strong></div>{cart.map(item=><div className="checkout-row" key={item.id}><Check size={16} /><b>{item.name}</b><span>{item.quantity}{item.unit}</span></div>)}{active.filter(item=>item.status==='planned').length>0 && <><div className="subheading">まだかごに入っていない商品</div>{active.filter(item=>item.status==='planned').map(item=><div className="checkout-row muted" key={item.id}><Circle size={15} /><b>{item.name}</b><span>{item.quantity}{item.unit}</span></div>)}</>}</Modal>}
    {modal === 'diagnostics' && <Modal title="技術と接続診断" onClose={closing}><div className="technology-list">{[['フロントエンド','React 19 · TypeScript · Vinext'],['デザイン','CSS · チェックリスト · Lucide'],['バックエンド','Cloudflare Workers'],['クラウド保存','Cloudflare D1'],['AI解析','Cloudflare Workers AI / ローカル解析'],['添付','Cloudflare R2'],['端末の保存','localStorage'],['音声入力','Web Speech API / 録音・Workers AI / 端末のキーボード']].map(([name,value])=><div className="setting-line" key={name}><span>{name}</span><b>{value}</b></div>)}</div><div className="subheading">API応答</div><pre className="diagnostic-code">{JSON.stringify(capability,null,2)}</pre></Modal>}
  </>;
}
