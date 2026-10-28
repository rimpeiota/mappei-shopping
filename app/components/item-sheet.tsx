'use client';
import { useState, type ReactNode } from 'react';
import { Star, Trash2, Plus, ExternalLink, Paperclip, Package, Check, ArrowUpRight, X } from 'lucide-react';
import { CATEGORIES, STATUS_LABELS, TODAY, money, finalizePurchaseDraft, recordPurchasedQuantity, setItemStatus, safeUrl, uid, type ShoppingItem, type ItemStatus, type Attachment } from '@/lib/client-model';
import { Modal } from './modal';
import { StoragePicker } from './storage-picker';
function Field({ label, children, span = false }: { label: string; children: ReactNode; span?: boolean }) { return <label className={`field ${span ? 'field-span' : ''}`}><span>{label}</span>{children}</label>; }
export function ItemSheet({ item, authenticated, onClose, onSave, onDelete, onCopy, onMove, toast }: { item: ShoppingItem; authenticated: boolean; onClose: () => void; onSave: (item: ShoppingItem) => void; onDelete: (id: string) => void; onCopy: (item: ShoppingItem) => void; onMove?: (direction: number) => void; toast: (text: string) => void }) {
  const [draft, setDraft] = useState(item);
  const [currentStockWasEntered, setCurrentStockWasEntered] = useState(false);
  const [tab, setTab] = useState('商品');
  const [uploading, setUploading] = useState(false);
  const [priceStore, setPriceStore] = useState('');
  const [priceAmount, setPriceAmount] = useState('');
  const [priceSource, setPriceSource] = useState('');
  const close = onClose;
  const update = <K extends keyof ShoppingItem>(key: K, value: ShoppingItem[K]) => {
    if (key === 'stock') setCurrentStockWasEntered(true);
    setDraft(old => {
      if (key === 'purchasedQuantity') return { ...recordPurchasedQuantity(old, value as number), stock: old.stock };
      if (key === 'status') return { ...setItemStatus(old, value as ItemStatus), stock: old.stock };
      if (key === 'stock' || key === 'spare') return { ...old, [key]: value, stockKnown: true, checkedAt: TODAY() };
      return { ...old, [key]: value };
    });
  };
  const text = (label: string, key: keyof ShoppingItem, placeholder = '', type = 'text', span = false) => <Field key={key} label={label} span={span}><input type={type} value={String(draft[key] ?? '')} placeholder={placeholder} onChange={e => update(key, e.target.value as never)} /></Field>;
  const numeric = (label: string, key: keyof ShoppingItem, suffix = '', step = '1') => <Field key={key} label={label}><div className="input-with-suffix"><input type="number" min="0" step={step} value={key === 'stock' || key === 'spare' ? Number(draft[key]) : Number(draft[key]) || ''} placeholder="0" onChange={e => update(key, Math.max(0, Number(e.target.value)) as never)} />{suffix && <span>{suffix}</span>}</div></Field>;
  const save = () => { if (!draft.name.trim()) { toast('商品名を入力してください'); return; } if (!(draft.quantity > 0)) { toast('数量は0より大きくしてください'); return; } onSave(finalizePurchaseDraft(item, { ...draft, name: draft.name.trim() }, currentStockWasEntered)); };
  const upload = async (file?: File) => {
    if (!file) return;
    if (!authenticated) { toast('添付のクラウド保存にはログインが必要です'); return; }
    if (file.size > 10 * 1024 * 1024) { toast('10MB以下のファイルを選んでください'); return; }
    setUploading(true);
    try { const form = new FormData(); form.set('file', file); const response = await fetch('/api/attachments', { method: 'POST', body: form }); if (!response.ok) throw new Error(); const attachment = await response.json() as Attachment; setDraft(old => ({ ...old, attachments: [...old.attachments, attachment] })); toast('添付しました。保存で確定します'); }
    catch { toast('添付できませんでした。ファイルを確認してください'); }
    finally { setUploading(false); }
  };
  const purchaseSome = () => setDraft(old => ({ ...recordPurchasedQuantity(old, old.purchasedQuantity + 1), stock: old.stock }));
  return <Modal title="商品詳細" onClose={close} footer={<><button className="icon-button danger" aria-label="商品を削除" onClick={() => onDelete(item.id)}><Trash2 size={20} /></button><button className="button secondary" onClick={() => onCopy(draft)}>もう一度追加</button><button className="button primary" onClick={save}><Check size={17} />保存</button></>}>
    <div className="detail-title"><div className={`category-symbol ${draft.category === '食品' ? 'green' : ''}`}><Package size={25} /></div><div className="detail-name"><label className="sr-only" htmlFor="detail-name">商品名</label><input id="detail-name" data-autofocus value={draft.name} onChange={e => update('name', e.target.value)} placeholder="商品名" maxLength={500} /><span>{new Date(item.createdAt).toLocaleDateString('ja-JP')} 追加</span></div><button className={`icon-button ${draft.favorite ? 'favorite-active' : ''}`} aria-label={draft.favorite ? 'お気に入り解除' : 'お気に入り登録'} onClick={() => update('favorite', !draft.favorite)}><Star size={21} fill={draft.favorite ? 'currentColor' : 'none'} /></button></div>
    <nav className="detail-tabs" aria-label="詳細の種類">{['商品', '購入', '在庫', '共有'].map(name => <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>)}</nav>
    {tab === '商品' && <div className="field-grid">
      <Field label="ステータス" span><select value={draft.status} onChange={e => update('status', e.target.value as ItemStatus)}>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      {numeric('数量', 'quantity', '', '.01')}<StoragePicker label="単位" kind="unit" value={draft.unit} onChange={value => update('unit', value)} />
      <Field label="カテゴリ"><select value={draft.category} onChange={e => update('category', e.target.value)}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></Field>{text('購入先', 'store', '店舗・通販')}
      {text('商品URL', 'url', 'https://', 'url', true)}
      {safeUrl(draft.url) && <a className="inline-link field-span" href={safeUrl(draft.url)} target="_blank" rel="noopener noreferrer">商品ページ <ExternalLink size={14} /></a>}
      <details className="detail-advanced field-span"><summary>その他の商品情報</summary><div className="field-grid">
      {text('ブランド', 'brand')}{text('型番', 'model')}{text('色', 'color')}{text('サイズ', 'size')}{text('容量', 'capacity')}{text('別名・検索キーワード', 'aliases')}
      {text('関連グループ', 'group', '本体と付属品など')}{text('対応する本体・規格', 'compatibility')}
      {text('リストの日付', 'listDate', '', 'date')}{text('検討を再開する日', 'holdUntil', '', 'date')}
      {onMove && <div className="field-span"><span className="field-note">リスト内の順番</span><div className="compare-selectors"><button className="button secondary" onClick={() => onMove(-1)}>上へ移動</button><button className="button secondary" onClick={() => onMove(1)}>下へ移動</button></div></div>}
      </div></details>
      <Field label="コメント" span><textarea rows={3} value={draft.comment} onChange={e => update('comment', e.target.value)} placeholder="商品についてのメモ" /></Field>
      <div className="field-span subheading">添付 <span>{draft.attachments.length}</span></div>
      {draft.attachments.map(file => <div className="attachment-row field-span" key={file.id}><Paperclip size={16} /><a href={safeUrl(file.url) || (file.url.startsWith('/api/') ? file.url : undefined)} target="_blank" rel="noopener noreferrer">{file.name}</a><button className="icon-button small" aria-label={`${file.name}を外す`} onClick={() => update('attachments', draft.attachments.filter(a => a.id !== file.id))}><X size={15} /></button></div>)}
      <label className="button secondary attachment-button field-span"><Paperclip size={16} />{uploading ? 'アップロード中…' : '写真・レシート・保証書を添付'}<input type="file" accept="image/*,application/pdf" disabled={uploading} onChange={e => void upload(e.target.files?.[0])} /></label>
      <p className="field-note field-span">画像は原本として保存します。文字の自動抽出は未接続です。</p>
    </div>}
    {tab === '購入' && <div className="field-grid">
      {numeric('商品価格', 'price', '円', '.01')}{numeric('上限価格', 'ceiling', '円')}{numeric('送料', 'shipping', '円')}{numeric('割引', 'discount', '円')}{numeric('維持費・消耗品費', 'runningCost', '円')}{text('クーポン', 'coupon')}
      {numeric('1商品の内容量', 'measure', '', '.01')}<StoragePicker label="内容量の単位" kind="unit" value={draft.measureUnit} onChange={value => update('measureUnit', value)} />
      {!!draft.measure && <div className="inline-info field-span">100{draft.measureUnit}あたり {money(draft.price / draft.measure * 100)}</div>}
      {text('クーポン期限', 'couponEnds', '', 'date')}{text('セール終了日', 'saleEnds', '', 'date')}
      <div className="field-span subheading">購入・配送</div>
      {numeric('購入した数量', 'purchasedQuantity', draft.unit, '.01')}{text('購入日', 'purchasedAt', '', 'date')}
      <button className="button secondary field-span" onClick={purchaseSome} disabled={draft.purchasedQuantity >= draft.quantity}><Plus size={15} />1{draft.unit}購入を記録（{draft.purchasedQuantity}/{draft.quantity}）</button>
      <p className="field-note field-span">保存時に新しく購入した分だけ在庫に加えます。「使用中・手持ち」に現在量を入力した場合はその量を優先します。購入数量の減少・返品などでは在庫を自動で減らさないため、現在量を確認してください。</p>
      {text('配送予定日', 'deliveryDate', '', 'date')}{text('返品期限', 'returnUntil', '', 'date')}{text('保証期限', 'warrantyUntil', '', 'date')}{text('説明書・手入れ方法URL', 'manualUrl', 'https://', 'url')}
      {safeUrl(draft.manualUrl) && <a className="inline-link field-span" href={safeUrl(draft.manualUrl)} target="_blank" rel="noopener noreferrer">説明書を開く <ArrowUpRight size={15} /></a>}
      <div className="field-span subheading">定期購入</div>
      {text('次回配送日', 'subscriptionDate', '', 'date')}{numeric('配送間隔', 'subscriptionEvery', '日')}{numeric('定期購入の数量', 'subscriptionQuantity', draft.unit)}
      <button className="button secondary" onClick={() => { if (!draft.subscriptionDate) return; const next = new Date(draft.subscriptionDate + 'T12:00:00'); next.setDate(next.getDate() + (draft.subscriptionEvery || 30)); update('subscriptionDate', next.toLocaleDateString('sv-SE')); }}>次回分をスキップ</button>
      <p className="field-note field-span">ここでの変更は記録のみです。通販の注文・定期購入は変更されません。</p>
      <div className="field-span subheading">価格の記録</div>
      {draft.prices.length === 0 && <p className="field-note field-span">記録なし</p>}
      {draft.prices.map(p => <div className="price-record field-span" key={p.id}><div><b>{p.store || '店舗未設定'}</b><small>{p.date}{p.source ? ` · ${p.source}` : ''}</small></div><strong>{money(p.price)}</strong><button className="icon-button small" aria-label="価格記録を削除" onClick={() => update('prices', draft.prices.filter(x => x.id !== p.id))}><X size={15} /></button></div>)}
      <Field label="記録する店舗"><input value={priceStore} onChange={e => setPriceStore(e.target.value)} /></Field><Field label="記録する価格"><input type="number" min="0" value={priceAmount} onChange={e => setPriceAmount(e.target.value)} /></Field>
      <Field label="出典・確認元" span><input value={priceSource} onChange={e => setPriceSource(e.target.value)} placeholder="商品ページ・店頭など" /></Field>
      <button className="button secondary field-span" onClick={() => { if (!priceAmount || Number(priceAmount) < 0) return; update('prices', [...draft.prices, { id: uid(), store: priceStore, price: Number(priceAmount), source: priceSource, date: TODAY() }]); setPriceAmount(''); }}><Plus size={15} />価格を記録</button>
      <div className="field-span subheading">使用後</div>{text('使ってみた感想', 'rating', '', 'text', true)}
      <Field label="次も買うか"><select value={draft.rebuy} onChange={e => update('rebuy', e.target.value)}><option value="">未定</option><option>また買う</option><option>別の商品を探す</option></select></Field>
    </div>}
    {tab === '在庫' && <div className="field-grid">
      <label className="field field-span"><span><input type="checkbox" checked={draft.stockKnown} onChange={e => setDraft(old => ({ ...old, stockKnown: e.target.checked, checkedAt: e.target.checked ? TODAY() : old.checkedAt }))} /> 現在の数量を確認済み</span></label>
      {!draft.stockKnown && <p className="field-note field-span">数量は未確認です。0個の確認済み在庫とは分けて表示します。現在量を入力すると確認済みになります。</p>}
      {numeric('使用中・手持ち', 'stock', draft.unit, '.01')}{numeric('未開封の予備', 'spare', draft.unit, '.01')}<StoragePicker className="field field-span" label="保管場所" kind="location" value={draft.location} onChange={value => update('location', value)} />
      {numeric('確認した残量', 'remaining', '%')}{text('在庫確認日', 'checkedAt', '', 'date')}
      <button className="button secondary field-span" onClick={() => setDraft(old => ({ ...old, stockKnown: true, checkedAt: TODAY() }))}><Check size={15} />今日の在庫を確認</button>
      {text('使用・賞味期限', 'expiry', '', 'date')}{text('開封日', 'openedAt', '', 'date')}{text('使い切った日', 'usedUpAt', '', 'date')}
      {numeric('1日あたりの消費目安', 'consumptionPerDay', '%', '.1')}
      {!!draft.consumptionPerDay && <p className="inline-info field-span">入力した消費目安からの推定：残り約{Math.ceil(draft.remaining / draft.consumptionPerDay)}日</p>}
      {numeric('買い足す在庫数', 'restockThreshold', draft.unit, '.01')}{text('買い足し提案を先送り', 'restockSnooze', '', 'date')}
      <div className="field-span subheading">在庫の操作</div>
      <button className="button secondary" disabled={draft.stock <= 0} onClick={() => setDraft(old => ({ ...old, stock: Math.max(0, old.stock - 1), checkedAt: TODAY(), usedUpAt: old.stock <= 1 ? TODAY() : old.usedUpAt }))}>1{draft.unit}使い切る</button>
      <button className="button secondary" disabled={draft.spare <= 0} onClick={() => setDraft(old => ({ ...old, spare: old.spare - 1, stock: old.stock + 1, openedAt: TODAY(), checkedAt: TODAY() }))}>予備を開封</button>
      <button className="button secondary" disabled={draft.stock <= 0} onClick={() => setDraft(old => ({ ...old, stock: Math.max(0, old.stock - 1), checkedAt: TODAY() }))}>1{draft.unit}譲渡・廃棄</button>
      <button className="button secondary field-span" onClick={() => { const next = new Date(); next.setDate(next.getDate() + 7); update('restockSnooze', next.toLocaleDateString('sv-SE')); }}>7日間買い足しを見送る</button>
      <p className="field-note field-span">実測の残量と推定は分けて表示します。価格・期限の通知や位置通知は未接続です。</p>
    </div>}
    {tab === '共有' && <div className="field-grid">
      <Field label="リストの区分" span><select value={draft.shared ? 'shared' : 'private'} onChange={e => update('shared', e.target.value === 'shared')}><option value="private">自分用</option><option value="shared">共有する予定</option></select></Field>
      {text('買う担当', 'assignee')}{text('依頼した人', 'requester')}{text('頼まれた日時', 'requestedDate', '', 'datetime-local', true)}
      <Field label="コメント" span><textarea value={draft.comment} onChange={e => update('comment', e.target.value)} rows={4} /></Field>
      <div className="connection-note field-span"><div className="connection-dot" /><div><b>家族共有は未接続</b><p>担当・依頼情報は自分用の記録として保存されます。相手への送信や通知は行われません。</p></div></div>
    </div>}
  </Modal>;
}
