import PostalMime from 'postal-mime';
import { digestKey } from './event.ts';

export type MailEvidenceSource = {
  integrationId: string;
  uid: number;
  /** IMAP INTERNALDATE, in epoch milliseconds; never the untrusted Date header. */
  internalDate: number;
  keyword: string;
};

/** Diagnostic hints only. No field is sufficient evidence for changing a shopping item. */
export type MailEvidence = {
  messageDigest: string;
  uid: number;
  receivedAtISO: string;
  merchantHint: 'amazon' | 'rakuten' | 'unknown';
  carrierHint: 'yamato' | 'sagawa' | 'japanpost' | 'unknown';
  keywordMentioned: boolean;
  subjectOrderRelated: boolean;
  kindHint: 'ordered' | 'shipped' | 'delivered' | 'cancelled' | 'returned' | 'review';
  /** Separate from body boilerplate; still an unverified diagnostic hint. */
  subjectKindHint: MailEvidence['kindHint'];
  hasText: boolean;
  hasHtml: boolean;
  orderIdDigests: string[];
  /** Only explicitly labelled tracking numbers; original digits never leave memory. */
  trackingNumberDigests: string[];
  /** Public catalog URLs only, with query strings and fragments removed. */
  rakutenProductKeys: string[];
  /** Only explicitly labelled quantities; never inferred from the product name. */
  quantityCandidates: number[];
  explicitQuantitySeen: boolean;
  /** Header mentions can be forged; these are not verified authentication results. */
  authenticationHints: { dkimPassMentioned: boolean; spfPassMentioned: boolean };
  confirmed: false;
};

const MAX_MAIL_BYTES = 262144;
const MAX_MATCHES = 20;
const mimeOptions = { maxNestingDepth: 16, maxHeadersSize: 32768, maxRfc822NestingDepth: 0 };
const ORDER_WORDS = /注文|受注|発送|出荷|配達|お届け|配送|投函|キャンセル|返品|order|shipp?ed|shipment|delivery|delivered|cancelled|returned/iu;
const normal = (value: string) => value.normalize('NFKC').toLowerCase();
const keywordForm = (value: string) => normal(value).replace(/[\p{P}\p{Z}\s]/gu, '');

function decodeEntities(value: string): string {
  return value.replace(/&(?:#(x[0-9a-f]+|[0-9]+)|([a-z]+));/giu, (whole, numeric: string | undefined, name: string | undefined) => {
    if (numeric) {
      const code = numeric[0].toLowerCase() === 'x' ? Number.parseInt(numeric.slice(1), 16) : Number(numeric);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
    }
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return named[name?.toLowerCase() ?? ''] ?? whole;
  });
}

function withoutHtmlQuotes(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(?:script|style|head)\b[^>]*>[\s\S]*?<\/(?:script|style|head)\s*>/giu, ' ')
    // Greedy removal is conservative for nested blockquotes: quoted completion text cannot win.
    .replace(/<blockquote\b[\s\S]*<\/blockquote\s*>/giu, ' ')
    .replace(/<(?:div|section)\b[^>]*\bclass\s*=\s*["'][^"']*(?:gmail_quote|yahoo_quoted)[^"']*["'][^>]*>[\s\S]*<\/(?:div|section)\s*>/giu, ' ');
}

function plainHtml(html: string): string {
  return decodeEntities(html
    .replace(/<(?:br|hr)\b[^>]*\/?\s*>|<\/(?:p|div|li|tr|h[1-6])\s*>/giu, '\n')
    .replace(/<[^>]*>/gu, ' '));
}

function withoutTextQuotes(text: string): string {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*(?:-{2,}\s*(?:original|forwarded) message|on .{1,200}wrote:|元のメッセージ|転送されたメッセージ)/iu.test(line)) break;
    if (!/^\s*[>|]/u.test(line)) lines.push(line);
  }
  return lines.join('\n');
}

function domainMatches(domain: string, suffix: string): boolean {
  return domain === suffix || domain.endsWith(`.${suffix}`);
}

function merchantHint(domain: string, visible: string, productKeys: string[]): MailEvidence['merchantHint'] {
  const amazon = domainMatches(domain, 'amazon.co.jp') || domainMatches(domain, 'amazon.com') || /amazon|アマゾン/iu.test(visible);
  const rakuten = domainMatches(domain, 'rakuten.co.jp') || domainMatches(domain, 'rakuten.com') || /楽天|rakuten/iu.test(visible) || productKeys.length > 0;
  return amazon === rakuten ? 'unknown' : amazon ? 'amazon' : 'rakuten';
}

function carrierHint(domain: string, visible: string): MailEvidence['carrierHint'] {
  const matches: MailEvidence['carrierHint'][] = [];
  if (domainMatches(domain, 'kuronekoyamato.co.jp') || /ヤマト運輸|クロネコヤマト|yamato transport/iu.test(visible)) matches.push('yamato');
  if (domainMatches(domain, 'sagawa-exp.co.jp') || /佐川急便|sagawa/iu.test(visible)) matches.push('sagawa');
  if (domainMatches(domain, 'japanpost.jp') || /日本郵便|ゆうパック|japan post/iu.test(visible)) matches.push('japanpost');
  return matches.length === 1 ? matches[0] : 'unknown';
}

function productKeys(content: string): string[] {
  const results = new Set<string>();
  for (const match of content.matchAll(/https?:\/\/item\.rakuten\.co\.jp[^\s<>"'）)\]}]*/giu)) {
    try {
      const link = decodeEntities(match[0]);
      // Reject explicit ports, even when URL would normalize a default :80/:443 away.
      if (!/^https?:\/\/item\.rakuten\.co\.jp\//iu.test(link)) continue;
      const url = new URL(link);
      if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'item.rakuten.co.jp' || url.username || url.password || url.port) continue;
      const path = url.pathname.match(/^\/([a-z0-9][a-z0-9_-]{0,79})\/([a-z0-9][a-z0-9_.-]{0,159})\/?$/iu);
      if (!path || path[1] === '.' || path[2] === '.' || path[2] === '..') continue;
      results.add(`https://item.rakuten.co.jp/${path[1].toLowerCase()}/${path[2]}/`);
      if (results.size === MAX_MATCHES) break;
    } catch { /* Malformed or personal links do not enter the result. */ }
  }
  return [...results].sort();
}

function kindHint(content: string): MailEvidence['kindHint'] {
  // Quoted examples, negations, and future/conditional wording cannot produce completion hints.
  const sentences = normal(content)
    .replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"/gu, ' ')
    .split(/[\n。！？!?]/u)
    .filter(line => !/未完了|未配達|未配送|未発送|予定|見込|見積|目安|完了(?:後|時|まで|したら|の場合|すると)|まだ|してい(?:ない|ません)|されてい(?:ない|ません)|では(?:ない|ありません)|でき(?:ない|ません)|(?:完了|発送|出荷|お届け).{0,12}(?:しません|しない|してない|されません|されない)|not\b|\b(?:will|expected|estimated|scheduled|if|when)\b/iu.test(line));
  const unquoted = sentences.join('\n');
  if (/キャンセル(?:が|を)?(?:完了|承り|受け付け)|注文.{0,12}キャンセル|order.{0,20}cancel(?:led|ed)/iu.test(unquoted)) return 'cancelled';
  if (/返品(?:を|が)?(?:受け付け|完了)|return.{0,20}(?:received|complete)/iu.test(unquoted)) return 'returned';
  if (/(?:配達|お届け|配送|投函)(?:が|は)?(?:完了|済み)|(?:was|has been) delivered|delivery (?:is )?complete/iu.test(unquoted)) return 'delivered';
  if (/(?:発送|出荷)(?:が|を)?(?:完了|いたしました|しました)|発送のお知らせ|商品発送のご連絡|(?:was|has been) shipped|shipping confirmation/iu.test(unquoted)) return 'shipped';
  if (/ご注文(?:を|が|ありがとう|内容(?:の)?ご?確認)|注文(?:確認|を受け|を承)|受注確認|order confirmation/iu.test(unquoted)) return 'ordered';
  return 'review';
}

function quantityCandidates(content: string): number[] {
  const values = new Set<number>();
  const add = (digits: string) => {
    const value = Number(digits);
    if (Number.isInteger(value) && value >= 1 && value <= 9999 && values.size < MAX_MATCHES) values.add(value);
  };
  for (const match of content.matchAll(/(?:ご?注文(?:数量|個数|数)|購入(?:数量|個数|数)|数量|個数|\bquantity\b|\bqty\b)\s*(?:[\]】)]\s*)?(?:[:=]\s*)?([0-9]{1,4})(?![0-9.,-])/giu)) add(match[1]);
  // A complete price/currency and unit form is required; a name such as “6点” cannot match.
  for (const match of content.matchAll(/(?<![0-9.,])(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,9})\s*(?:\(\s*円\s*\)|円)\s*[x×]\s*([0-9]{1,4})(?![0-9.,-])\s*\(\s*個\s*\)/giu)) add(match[1]);
  return [...values].sort((a, b) => a - b);
}

/**
 * Parses a single bounded mail entirely in memory. No raw mail, address, tracking value,
 * original order/message ID, or personal URL may leave this diagnostic projection.
 */
export async function inspectMailEvidence(raw: Uint8Array, source: MailEvidenceSource): Promise<MailEvidence> {
  if (!(raw instanceof Uint8Array) || raw.length === 0 || raw.length > MAX_MAIL_BYTES
      || !source.integrationId || source.integrationId.length > 200
      || !Number.isSafeInteger(source.uid) || source.uid <= 0
      || !Number.isSafeInteger(source.internalDate) || !Number.isFinite(new Date(source.internalDate).getTime())
      || typeof source.keyword !== 'string' || source.keyword.length > 160 || !keywordForm(source.keyword)) {
    throw new Error('invalid_probe_input');
  }
  let mail: Awaited<ReturnType<typeof PostalMime.parse>>;
  try { mail = await PostalMime.parse(raw, mimeOptions); } catch { throw new Error('mail_parse_failed'); }
  const subject = mail.subject ?? '';
  const text = withoutTextQuotes(mail.text ?? '');
  const html = withoutHtmlQuotes(mail.html ?? '');
  const visible = `${subject}\n${text}\n${plainHtml(html)}`;
  const normalized = normal(visible);
  const rakutenProductKeys = productKeys(`${text}\n${html}`);
  const orderIds = new Set<string>();
  for (const match of normalized.matchAll(/(?<![0-9a-z-])(?:[0-9]{6}-[0-9]{8}-[0-9]{5,12}|[0-9]{3}-[0-9]{7}-[0-9]{7})(?![0-9a-z-])/gu)) {
    orderIds.add(match[0]);
    if (orderIds.size === MAX_MATCHES) break;
  }
  const trackingNumbers = new Set<string>();
  for (const match of normalized.matchAll(/(?:お(?:問い合わせ|問合せ)(?:伝票)?(?:番号|no\.?)|お荷物伝票(?:番号|no\.?)|(?:送り状|送状|伝票)(?:番号|no\.?)|追跡番号|\btracking[ ]+number)\s*(?:[\]】)]\s*)?[:#]?\s*([0-9][0-9 -]{0,63})(?![0-9a-z -])/gu)) {
    const number = match[1].trim();
    if (!/^[0-9]+(?:[ -]+[0-9]+)*$/u.test(number)) continue;
    const digits = number.replace(/[ -]/gu, '');
    if (digits.length < 10 || digits.length > 14) continue;
    trackingNumbers.add(digits);
    if (trackingNumbers.size === MAX_MATCHES) break;
  }
  const domain = (mail.from?.address?.split('@').pop() ?? '').toLowerCase();
  const auth = mail.headers.filter(header => header.key.toLowerCase() === 'authentication-results').map(header => header.value).join('\n');
  const receivedSpf = mail.headers.filter(header => header.key.toLowerCase() === 'received-spf').map(header => header.value).join('\n');
  const messageId = mail.messageId?.trim();
  const identity = messageId && messageId.length <= 1000 ? `message:${messageId}` : `uid:${source.uid}:${source.internalDate}`;
  const quantities = quantityCandidates(normalized);
  return {
    messageDigest: await digestKey(`${source.integrationId}\nprobe-${identity}`),
    uid: source.uid,
    receivedAtISO: new Date(source.internalDate).toISOString(),
    merchantHint: merchantHint(domain, visible, rakutenProductKeys),
    carrierHint: carrierHint(domain, visible),
    keywordMentioned: keywordForm(visible).includes(keywordForm(source.keyword)),
    subjectOrderRelated: ORDER_WORDS.test(subject),
    kindHint: kindHint(visible),
    subjectKindHint: kindHint(subject),
    hasText: Boolean(mail.text?.trim()),
    hasHtml: Boolean(mail.html?.trim()),
    orderIdDigests: (await Promise.all([...orderIds].map(id => digestKey(`${source.integrationId}\nprobe-order:${id}`)))).sort(),
    trackingNumberDigests: (await Promise.all([...trackingNumbers].map(digits => digestKey(`${source.integrationId}\nprobe-tracking:${digits}`)))).sort(),
    rakutenProductKeys,
    // A product name such as “6点テストクリップ” is not a quantity field.
    quantityCandidates: quantities,
    explicitQuantitySeen: quantities.length > 0,
    authenticationHints: {
      dkimPassMentioned: /(?:^|[;\s])dkim\s*=\s*pass(?:[;\s(]|$)/iu.test(auth),
      spfPassMentioned: /(?:^|[;\s])spf\s*=\s*pass(?:[;\s(]|$)/iu.test(auth) || /^\s*pass(?:\s|\()/imu.test(receivedSpf),
    },
    confirmed: false,
  };
}
