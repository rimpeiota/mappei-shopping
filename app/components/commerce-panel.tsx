'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, Truck } from 'lucide-react';
import { CommerceRequestError, requestCommerceStatus, type CommerceStatus } from '@/lib/client-commerce';

const displayTime = (value: string) => new Date(value).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function CommercePanel({ authenticated, blocked, getRevision }: {
  authenticated: boolean;
  blocked: boolean;
  getRevision: () => number | null;
}) {
  const [status, setStatus] = useState<CommerceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef<AbortController | null>(null);
  const generation = useRef(0);

  const load = useCallback(async (revision?: number) => {
    if (pending.current || !authenticated) return;
    const controller = new AbortController();
    pending.current = controller;
    const started = ++generation.current;
    setBusy(true); setError(''); setNotice('');
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
    const current = () => started === generation.current;
    try {
      const next = await requestCommerceStatus(controller.signal, revision);
      if (!current() || controller.signal.aborted) return;
      setStatus(next);
      if (revision !== undefined && next.connected) setNotice(next.hasMore ? '通知を確認しました。続きの通知があります。' : '通知を確認しました。');
    } catch (failure) {
      if (!current() || (controller.signal.aborted && !timedOut)) return;
      if (failure instanceof CommerceRequestError && failure.kind === 'signed-out') {
        setStatus(null); setError('ログイン状態を確認して、もう一度開いてください。');
      } else if (failure instanceof CommerceRequestError && failure.kind === 'conflict') {
        setError('別の端末の変更があります。「保存と同期」で同期してから、もう一度確認してください。');
      } else setError(timedOut ? '確認に時間がかかっています。もう一度お試しください。' : '通知を確認できませんでした。通信状態を確認して、もう一度お試しください。');
    } finally {
      clearTimeout(timer);
      if (current()) { pending.current = null; setBusy(false); }
    }
  }, [authenticated]);

  useEffect(() => {
    if (authenticated) void load();
    return () => { generation.current += 1; pending.current?.abort(); pending.current = null; };
  }, [authenticated, load]);

  const sync = () => {
    const revision = getRevision();
    if (revision === null) { setError('入力中の内容を保存し、同期してから確認してください。'); return; }
    void load(revision);
  };
  const canSync = authenticated && !blocked && !busy && !!status?.connected;

  return <section className="settings-section glass" aria-labelledby="commerce-heading" aria-busy={busy}>
    <div className="section-heading"><h3 id="commerce-heading"><Truck size={17} />配送通知</h3><span className="connection-badge">{!authenticated ? '未ログイン' : busy && !status ? '確認中' : status?.connected ? '通知の確認のみ' : '未接続'}</span></div>
    <p className="field-note">自動で受取済みにする処理は準備中です。商品・配達の対応が確認できない通知は変更しません。</p>
    {status?.connected ? <>
      <div className="setting-line"><span>取り込んだ通知</span><b>{status.importedCount}件</b></div>
      <div className="setting-line"><span>確認待ち</span><b>{status.reviewCount}件</b></div>
      <div className="setting-line"><span>自動で受取済みにした商品</span><b>{status.completedCount}件</b></div>
      <div className="setting-line"><div><b>ドコモメールの配送通知</b><small>{status.lastSyncedAt ? `前回の確認 ${displayTime(status.lastSyncedAt)}` : 'まだアプリへ取り込んでいません'}</small></div><button type="button" className="button secondary small" disabled={!canSync} onClick={sync}>{busy ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}通知を確認</button></div>
      {status.hasMore && <p className="field-note">未確認の続きがあります。「通知を確認」をもう一度押すと、続きから取り込みます。</p>}
      {status.sourceLimited && <p className="field-note">メールの取得には未確認の範囲があります。すべての配送通知を取り込めた状態ではありません。</p>}
      {status.sourceCollectorLastSuccessAt && <p className="field-note">メールの最終取得 {displayTime(status.sourceCollectorLastSuccessAt)}</p>}
      {status.authBlocked && <p className="field-note" role="alert">メールの認証を確認するため、新しいメールの取得を停止しています。保存済みの通知は確認できます。接続設定の確認が必要です。</p>}
      {blocked && <p className="field-note">入力中の内容を保存し、同期が完了すると通知を確認できます。</p>}
    </> : <p className="field-note">{!authenticated ? '配送通知を確認するにはログインが必要です。' : busy && !status ? '配送通知の接続を確認しています。' : error ? '配送通知の接続状況を取得できていません。' : 'このアカウントで確認できる配送通知の接続は、まだ設定されていません。'}</p>}
    {notice && <p className="field-note" role="status">{notice}</p>}
    {error && <><p className="field-note text-coral" role="alert">{error}</p><button type="button" className="button secondary small" disabled={!authenticated || busy} onClick={() => void load()}><RefreshCw size={14} />接続を再確認</button></>}
  </section>;
}
