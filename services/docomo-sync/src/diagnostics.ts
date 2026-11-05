import { CollectorError, LOOKBACK_DAYS, MAX_MAIL_BYTES, ReadOnlyImap } from './imap.ts';
import { inspectMailEvidence, type MailEvidence } from './probe.ts';
import type { Env } from './service.ts';

export type ProbeInput = { keyword: string; since: string; beforeUid: number; trackingDigests: string[]; uids?: number[] };

/** Fixed mailbox, bounded dates, and data-only keywords. No caller-supplied IMAP commands. */
export async function readProbeInput(request: Request, now = Date.now()): Promise<ProbeInput | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let complete = false;
  try {
    const text = await Promise.race([
      (async () => {
        const chunks: Uint8Array[] = []; let size = 0;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 2048) throw new Error('input_limit');
          chunks.push(next.value);
        }
        const bytes = new Uint8Array(size); let at = 0;
        for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('input_timeout')), 1000); }),
    ]);
    complete = true;
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some(key => !['keyword', 'since', 'beforeUid', 'trackingDigests', 'uids'].includes(key))) return null;
    if (typeof body.keyword !== 'string' || body.keyword.trim().length < 2 || body.keyword.length > 64 || /[\x00-\x1f\x7f]/u.test(body.keyword)) return null;
    if (body.keyword.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '').length < 2) return null;
    if (typeof body.since !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(body.since)) return null;
    const since = Date.parse(body.since + 'T00:00:00.000Z');
    const earliestDay = Date.parse(new Date(now - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10) + 'T00:00:00.000Z');
    if (!Number.isFinite(since) || new Date(since).toISOString().slice(0, 10) !== body.since || since > now || since < earliestDay) return null;
    const beforeUid = body.beforeUid ?? 0;
    if (!Number.isSafeInteger(beforeUid) || (beforeUid as number) < 0 || (beforeUid as number) > 0xffffffff) return null;
    const trackingDigests = body.trackingDigests ?? [];
    if (!Array.isArray(trackingDigests) || trackingDigests.length > 5 || trackingDigests.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))) return null;
    const uids = body.uids;
    if (uids !== undefined && (!Array.isArray(uids) || uids.length < 1 || uids.length > 5 || beforeUid !== 0
      || uids.some(value => !Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff))) return null;
    return { keyword: body.keyword.trim(), since: body.since, beforeUid: beforeUid as number, trackingDigests: [...new Set(trackingDigests)] as string[],
      ...(uids === undefined ? {} : { uids: [...new Set(uids as number[])] }) };
  } catch { return null; }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!complete) void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* A pending cancelled read must not delay rejection. */ }
  }
}

/** Does not change collection cursors, events, purchases, or mail. Only auth failures stop future login. */
export async function probeMailbox(env: Env, input: ProbeInput, open: () => ReadOnlyImap, now = Date.now()) {
  const db = env.DB!;
  const prior = await db.prepare('SELECT auth_blocked FROM collector_state WHERE id = 1').first<{ auth_blocked: number }>();
  if (!prior) throw new CollectorError('database_schema_missing');
  if (prior.auth_blocked) return { result: 'authentication_blocked' };
  const leaseUntil = now + 240000;
  const lease = await db.prepare('UPDATE collector_state SET lease_until = ? WHERE id = 1 AND lease_until <= ? AND auth_blocked = 0').bind(leaseUntil, now).run();
  if (!lease.meta.changes) return { result: 'already_running' };
  let imap: ReadOnlyImap | undefined;
  try {
    imap = open();
    await imap.login(env.DOCOMO_ACCOUNT_ID!, env.DOCOMO_IMAP_PASSWORD!);
    await imap.examine(env.MAILBOX || 'INBOX');
    const since = Math.max(Date.parse(input.since + 'T00:00:00.000Z'), now - LOOKBACK_DAYS * 86400000);
    const page = input.uids ? { uids: [...input.uids].sort((a, b) => b - a), limited: false }
      : await imap.searchRecent(new Date(since), input.beforeUid);
    const matches: MailEvidence[] = [];
    let checkedUids = 0, relatedCount = 0, bodyReads = 0, skippedLarge = 0, nextBeforeUid = input.beforeUid;
    for (const uid of page.uids) {
      const header = await imap.headers(uid);
      checkedUids += 1; nextBeforeUid = uid;
      if (header.internalDate < since || header.internalDate > now + 300000) continue;
      const source = { integrationId: env.INTEGRATION_ID!, uid, internalDate: header.internalDate, keyword: input.keyword };
      const hint = await inspectMailEvidence(header.bytes, source);
      if (!hint.subjectOrderRelated && !hint.keywordMentioned) continue;
      relatedCount += 1;
      if (header.size > MAX_MAIL_BYTES) { skippedLarge += 1; if (hint.keywordMentioned) matches.push(hint); continue; }
      const evidence = await inspectMailEvidence(await imap.body(uid), source);
      bodyReads += 1;
      if (evidence.keywordMentioned || evidence.trackingNumberDigests.some(value => input.trackingDigests.includes(value))) matches.push(evidence);
      if (bodyReads >= 20) break;
    }
    return { result: 'success', checkedUids, relatedCount, bodyReads, skippedLarge, nextBeforeUid,
      hasMore: page.limited || checkedUids < page.uids.length, matches };
  } catch (error) {
    const code = error instanceof CollectorError ? error.code : 'probe_failed';
    await db.prepare('UPDATE collector_state SET last_error_code = ?, auth_blocked = ? WHERE id = 1 AND lease_until = ?')
      .bind(code, code === 'imap_authentication_failed' ? 1 : 0, leaseUntil).run();
    return { result: code };
  } finally {
    await imap?.close();
    await db.prepare('UPDATE collector_state SET lease_until = 0 WHERE id = 1 AND lease_until = ?').bind(leaseUntil).run();
  }
}
