'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cacheNeedsReview, emptyState, hasShoppingData, mergeAnonymousState, readRemoteSnapshot, validateShoppingCache, type ShoppingCache, type ShoppingState } from './client-model';
const PREFIX = 'mappei-shopping-v1';
const ANONYMOUS_KEY = `${PREFIX}:anonymous`;
const LAST_OWNER_KEY = `${PREFIX}:last-owner`;
const ownerKey = (owner: string) => `${PREFIX}:owner:${owner}`;
type SyncStatus = 'loading' | 'local' | 'saving' | 'synced' | 'offline' | 'error' | 'conflict' | 'upgrade';
type Cache = ShoppingCache;
type Conflict = { kind: 'conflict' | 'migration'; state: ShoppingState; revision: number; owner: string; legacy?: boolean };
type StateResponse = { state?: unknown; revision?: number; owner?: string };
function readCache(key: string): Cache | null {
  const raw = localStorage.getItem(key); if (raw === null) return null;
  const cache = validateShoppingCache(JSON.parse(raw));
  if (!cache) throw new Error('Unrecognized shopping cache');
  return cache;
}
function hasData(cache: Cache) { return hasShoppingData(cache.state) || cache.dirty; }
export function useShoppingStore() {
  const [state, setState] = useState<ShoppingState>(emptyState);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<SyncStatus>('loading');
  const [authenticated, setAuthenticated] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [previousAccountLocal, setPreviousAccountLocal] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [capability, setCapability] = useState<Record<string, unknown>>({});
  const [storageScope, setStorageScope] = useState(ANONYMOUS_KEY);
  const stateRef = useRef(state);
  const revision = useRef(0);
  const dirty = useRef(false);
  const legacyDirty = useRef(false);
  const enabled = useRef(false);
  const saving = useRef(false);
  const paused = useRef(false);
  const upgradeRequired = useRef(false);
  const version = useRef(0);
  const owner = useRef('');
  const key = useRef(ANONYMOUS_KEY);
  const connectionSequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const storageReadBlocked = useRef(false);
  const persist = useCallback(() => {
    // Do not replace unreadable originals with edits based on an empty screen.
    if (storageReadBlocked.current) { setStorageError(true); return; }
    try { localStorage.setItem(key.current, JSON.stringify({ state: stateRef.current, revision: revision.current, dirty: dirty.current, legacyDirty: legacyDirty.current } satisfies Cache)); setStorageError(false); }
    catch { setStorageError(true); }
  }, []);
  const sync = useCallback(async () => {
    if (!enabled.current || !owner.current || !dirty.current || saving.current || paused.current) return;
    if (!navigator.onLine) { setStatus('offline'); return; }
    saving.current = true; setStatus('saving');
    const sentVersion = version.current;
    const sentOwner = owner.current;
    const sentKey = key.current;
    try {
      const response = await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: stateRef.current, revision: revision.current, owner: owner.current }) });
      if (owner.current !== sentOwner || key.current !== sentKey) return;
      if (response.status === 401 || response.status === 403) { enabled.current = false; owner.current = ''; setAuthenticated(false); setPreviousAccountLocal(key.current !== ANONYMOUS_KEY); setStatus('local'); return; }
      if (response.status === 426) { upgradeRequired.current = true; enabled.current = false; paused.current = true; persist(); setStatus('upgrade'); return; }
      const result = await response.json() as StateResponse;
      if (response.status === 409) {
        enabled.current = false; paused.current = true;
        const remote = readRemoteSnapshot(result.state, result.revision);
        if (remote) { setConflict({ kind: 'conflict', state: remote, revision: result.revision!, owner: owner.current }); setStatus('conflict'); }
        else setStatus('error');
        return;
      }
      if (!response.ok) throw new Error('sync');
      revision.current = Number(result.revision) || 0;
      dirty.current = sentVersion !== version.current;
      legacyDirty.current = false;
      persist(); setStatus(dirty.current ? 'local' : 'synced');
    } catch { setStatus(navigator.onLine ? 'error' : 'offline'); }
    finally { saving.current = false; }
  }, [persist]);
  const connect = useCallback(async () => {
    if (storageReadBlocked.current) { enabled.current = false; paused.current = true; setStorageError(true); setStatus('error'); return; }
    if (paused.current || !navigator.onLine) { if (!paused.current) setStatus('offline'); return; }
    const sequence = ++connectionSequence.current;
    // A fresh GET must confirm the current authenticated owner before any queued PUT.
    enabled.current = false;
    try {
      const response = await fetch('/api/state');
      if (sequence !== connectionSequence.current) return;
      if (response.status === 401) { owner.current = ''; setAuthenticated(false); setPreviousAccountLocal(key.current !== ANONYMOUS_KEY); setStatus('local'); return; }
      if (!response.ok) { setStatus('error'); return; }
      const result = await response.json() as StateResponse;
      if (sequence !== connectionSequence.current) return;
      if (!result.owner) { setStatus('error'); return; }
      const confirmedOwner = result.owner;
      const confirmedKey = ownerKey(confirmedOwner);
      const remote = readRemoteSnapshot(result.state, result.revision);
      if (!remote) { paused.current = true; setStatus('error'); return; }
      const remoteRevision = result.revision!;
      let accountCache: Cache | null = key.current === confirmedKey ? { state: stateRef.current, revision: revision.current, dirty: dirty.current, legacyDirty: legacyDirty.current } : null;
      let anonymousCache: Cache | null = key.current === ANONYMOUS_KEY ? { state: stateRef.current, revision: revision.current, dirty: dirty.current, legacyDirty: legacyDirty.current } : null;
      try { accountCache ||= readCache(confirmedKey); anonymousCache ||= readCache(ANONYMOUS_KEY); }
      catch { storageReadBlocked.current = true; setStorageError(true); paused.current = true; setStatus('error'); return; }
      setAuthenticated(true); setPreviousAccountLocal(false);
      if (accountCache && cacheNeedsReview(accountCache, result.state, remoteRevision)) {
        owner.current = confirmedOwner; key.current = confirmedKey; setStorageScope(confirmedKey);
        stateRef.current = accountCache.state; setState(accountCache.state); revision.current = accountCache.revision;
        dirty.current = accountCache.dirty; legacyDirty.current = accountCache.legacyDirty;
        setConflict({ kind: 'conflict', state: remote, revision: remoteRevision, owner: confirmedOwner, legacy: accountCache.legacyDirty });
        paused.current = true; setStatus('conflict'); return;
      }
      if (anonymousCache && hasData(anonymousCache)) {
        // Anonymous text is kept local until the person explicitly chooses migration.
        key.current = ANONYMOUS_KEY; owner.current = ''; setStorageScope(key.current);
        stateRef.current = anonymousCache.state; setState(anonymousCache.state); revision.current = anonymousCache.revision; dirty.current = anonymousCache.dirty; legacyDirty.current = anonymousCache.legacyDirty;
        setConflict({ kind: 'migration', state: accountCache?.dirty ? accountCache.state : remote, revision: accountCache?.dirty ? accountCache.revision : remoteRevision, owner: confirmedOwner });
        paused.current = true; setStatus('conflict'); return;
      }
      owner.current = confirmedOwner; key.current = confirmedKey; setStorageScope(confirmedKey);
      try { localStorage.setItem(LAST_OWNER_KEY, confirmedOwner); } catch { setStorageError(true); }
      if (accountCache?.dirty) {
        stateRef.current = accountCache.state; setState(accountCache.state); dirty.current = true; revision.current = accountCache.revision; legacyDirty.current = accountCache.legacyDirty;
      } else { revision.current = remoteRevision; stateRef.current = remote; setState(remote); dirty.current = false; legacyDirty.current = false; }
      enabled.current = true; persist();
      if (dirty.current) void sync(); else setStatus('synced');
    } catch { if (sequence === connectionSequence.current) setStatus(navigator.onLine ? 'error' : 'offline'); }
  }, [persist, sync]);
  const commit = useCallback((next: ShoppingState | ((old: ShoppingState) => ShoppingState)) => {
    stateRef.current = typeof next === 'function' ? next(stateRef.current) : next;
    dirty.current = true; version.current += 1; setState(stateRef.current); persist();
    setStatus(upgradeRequired.current ? 'upgrade' : navigator.onLine ? (enabled.current ? 'saving' : 'local') : 'offline');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void sync(); }, 650);
  }, [persist, sync]);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const anonymous = readCache(ANONYMOUS_KEY) || readCache(PREFIX);
        const lastOwner = localStorage.getItem(LAST_OWNER_KEY);
        const account = lastOwner ? readCache(ownerKey(lastOwner)) : null;
        const cache = anonymous && hasData(anonymous) ? anonymous : account || anonymous;
        if (cache) {
          if (cache === account && lastOwner) { key.current = ownerKey(lastOwner); setStorageScope(key.current); setPreviousAccountLocal(true); }
          stateRef.current = cache.state; setState(cache.state); revision.current = cache.revision; dirty.current = cache.dirty; legacyDirty.current = cache.legacyDirty;
        }
      } catch { storageReadBlocked.current = true; setStorageError(true); }
      void connect();
    });
    const visible = setTimeout(() => { if (active) setReady(true); }, 320);
    fetch('/api/health').then(async response => response.ok ? await response.json() as Record<string, unknown> : {}).then(data => { if (active) setCapability(data); }).catch(() => {});
    const online = () => { void connect(); };
    const offline = () => { if (!upgradeRequired.current) setStatus('offline'); };
    window.addEventListener('online', online); window.addEventListener('offline', offline);
    return () => { active = false; connectionSequence.current += 1; clearTimeout(visible); if (timer.current) clearTimeout(timer.current); window.removeEventListener('online', online); window.removeEventListener('offline', offline); };
  }, [connect]);
  useEffect(() => { if (status === 'local' && enabled.current && dirty.current) { const retry = setTimeout(() => void sync(), 700); return () => clearTimeout(retry); } }, [status, sync, state]);
  const resolveConflict = (choice: 'local' | 'remote' | 'stay') => {
    if (!conflict) return;
    if (choice === 'stay') { enabled.current = false; paused.current = true; setConflict(null); setStatus('local'); return; }
    if (conflict.kind === 'migration') {
      if (choice === 'local') {
        const merged = mergeAnonymousState(conflict.state, stateRef.current);
        stateRef.current = merged; setState(merged); dirty.current = true;
      } else { stateRef.current = conflict.state; setState(conflict.state); dirty.current = false; }
      owner.current = conflict.owner; key.current = ownerKey(conflict.owner); setStorageScope(key.current);
      try { localStorage.removeItem(ANONYMOUS_KEY); localStorage.removeItem(PREFIX); localStorage.setItem(LAST_OWNER_KEY, conflict.owner); } catch { setStorageError(true); }
    } else if (choice === 'remote') { stateRef.current = conflict.state; setState(conflict.state); dirty.current = false; }
    else dirty.current = true;
    legacyDirty.current = false;
    revision.current = conflict.revision;
    setConflict(null); paused.current = false; enabled.current = true; persist();
    if (dirty.current) void sync(); else setStatus('synced');
  };
  const retry = () => { if (upgradeRequired.current) { setStatus('upgrade'); return; } if (paused.current) { if (conflict) return; paused.current = false; } if (!enabled.current) void connect(); else void sync(); };
  return { state, commit, ready, status, authenticated, storageError, storageScope, previousAccountLocal, conflict, resolveConflict, capability, retry };
}
