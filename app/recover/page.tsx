'use client';

import { useState } from 'react';
import { scanRecoveryStorage, buildRecoveryBackup, type RecoveryScan } from '@/lib/client-recovery';
import { STATUS_LABELS, TODAY } from '@/lib/client-model';
import './recovery.css';

function download(filename: string, contents: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Deliberately independent of useShoppingStore: inspecting a cache must not
// connect, select an account, persist, migrate, or replace its original bytes.
export default function Recover() {
  const [scan, setScan] = useState<RecoveryScan | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const inspect = () => {
    try { setScan(scanRecoveryStorage(window.localStorage)); setError(''); }
    catch { setError('ブラウザ内の保存領域を読み取れませんでした。保存データの削除はせず、元の画面を残してください。'); }
  };
  const save = (filename: string, contents: string) => {
    try { download(filename, contents); setError(''); }
    catch { setError('ファイルを保存できませんでした。ブラウザのダウンロード設定を確認してください。'); }
  };
  const snapshots = scan?.entries.filter(entry => entry.kind === 'snapshot') ?? [];
  const drafts = scan?.entries.filter(entry => entry.kind === 'draft') ?? [];
  const needle = query.normalize('NFKC').toLocaleLowerCase().trim();
  return <main className="recovery-page">
    <header><a className="recovery-back" href="/">買い物に戻る</a><h1>端末のデータを探す</h1></header>
    <p>商品を入力した端末・ブラウザで開いてください。この画面は、ブラウザ内に残る買い物データを読み取ります。クラウドへの同期や保存内容の変更は行いません。</p>
    <p className="recovery-note">SafariとChrome、MacとiPhoneでは保存内容が異なります。見つかったデータは、まずファイルに保存してください。</p>
    <button className="button primary" onClick={inspect}>{scan ? 'もう一度調べる' : 'このブラウザのデータを調べる'}</button>
    {error && <p className="recovery-error" role="alert">{error}</p>}
    {scan && <>
      <section className="recovery-summary" aria-label="調査結果">
        <h2>調査結果</h2>
        <p role="status">{scan.complete ? `保存枠 ${snapshots.length}件・入力下書き ${drafts.length}件` : '一部の保存領域を読み取れませんでした。表示されている内容がすべてとは限りません。'}</p>
        <button className="button secondary" disabled={!scan.entries.length} onClick={() => save(`shopping-device-originals-${TODAY()}.json`, buildRecoveryBackup(scan))}>全保存枠の原本を保存</button>
        <p className="recovery-note">原本は調査用ファイルです。アカウントの識別情報と商品の記録を含むため、公開しないでください。現在のリストへ自動で取り込みません。</p>
      </section>
      {snapshots.length > 0 && <label className="recovery-search">商品名・URLを検索<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="例：棚" /></label>}
      {!snapshots.length && scan.complete && <p>このブラウザには、買い物リストの保存枠が見つかりませんでした。入力した別の端末・ブラウザでも確認してください。</p>}
      {snapshots.map((entry, index) => {
        const items = entry.state?.items.filter(item => !needle || `${item.name}\n${item.url}\n${item.comment}`.normalize('NFKC').toLocaleLowerCase().includes(needle)) ?? [];
        return <section className="recovery-entry" key={entry.id}>
          <h2>{entry.label}</h2>
          {entry.state ? <>
            <p>商品 {entry.state.items.length}件{entry.dirty === true ? '・未同期の編集あり' : ''}{entry.revision !== null ? `・保存版 ${entry.revision}` : ''}</p>
            <button className="button secondary" onClick={() => save(`shopping-recovered-${index + 1}-${TODAY()}.json`, JSON.stringify(entry.state, null, 2))}>取り込み用JSONを保存</button>
            <p className="recovery-note">取り込み用JSONは現行形式へ変換したコピーです。先に「全保存枠の原本を保存」で元の内容を残してください。</p>
            <details open={!!needle}><summary>商品を見る（{items.length}件）</summary>
              {!items.length && <p>一致する商品はありません。</p>}
              <ul>{items.map(item => <li key={item.id}><strong>{item.name}</strong><span>{item.quantity}{item.unit}・{STATUS_LABELS[item.status]}{item.inventoryOnly ? '・在庫のみ' : ''}</span>{item.url && <span className="recovery-url">{item.url}</span>}</li>)}</ul>
            </details>
          </> : <p className="recovery-note">この保存枠は商品として読み取れませんでした。「全保存枠の原本を保存」で元の内容を退避できます。</p>}
        </section>;
      })}
      {drafts.map(entry => <section className="recovery-entry" key={entry.id}><h2>{entry.label}</h2><details><summary>入力下書きを見る</summary><pre>{entry.raw || '（空の下書き）'}</pre></details></section>)}
    </>}
  </main>;
}
