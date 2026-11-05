import PostalMime from 'postal-mime';

/** Structural contract shared with ../../../lib/commerce-model.ts. */
export type NormalizedCommerceEvent = {
  id: string;
  merchant: 'amazon' | 'rakuten' | 'unknown';
  accountScope: string;
  kind: 'ordered' | 'delivered' | 'cancelled' | 'returned' | 'review';
  orderId: string | null;
  orderLineId: string | null;
  productKey: string | null;
  shipmentId: string | null;
  quantity: number | null;
  unit: string | null;
  orderedAt: string | null;
  deliveredAt: string | null;
  explicitConfirmed: boolean;
  observedAtISO: string;
  parserVersion: 1;
};

const ORDER_WORDS = /注文|発送|出荷|配達|お届け|配送|キャンセル|返品|order|shipp?ed|delivery|delivered|cancelled|returned/iu;
const AMAZON = /(?:^|\.)amazon\.(?:co\.jp|com)$/iu;
const RAKUTEN = /(?:^|\.)rakuten\.(?:co\.jp|com)$/iu;
// Reuse the diagnostic carrier allowlist. Domain/subject matches select review candidates only.
const CARRIER = /(?:^|\.)(?:kuronekoyamato\.co\.jp|sagawa-exp\.co\.jp|japanpost\.jp)$/iu;
const CARRIER_DELIVERY_WORDS = /発送|出荷|配達|お届け|配送|投函|shipp?ed|shipment|delivery|delivered/iu;
const mimeOptions = { maxNestingDepth: 16, maxHeadersSize: 32768, maxRfc822NestingDepth: 0 };

/** Sender matching is only a candidate filter, never proof of authenticity or delivery. */
export async function inspectCandidate(rawHeaders: Uint8Array): Promise<{ merchant: NormalizedCommerceEvent['merchant']; candidate: boolean }> {
  const mail = await PostalMime.parse(rawHeaders, mimeOptions);
  const domain = mail.from?.address?.split('@').pop() ?? '';
  const merchant = AMAZON.test(domain) ? 'amazon' : RAKUTEN.test(domain) ? 'rakuten' : 'unknown';
  const subject = mail.subject ?? '';
  const mentionsShop = /amazon|アマゾン|楽天|rakuten/iu.test(subject);
  const carrierCandidate = CARRIER.test(domain) && CARRIER_DELIVERY_WORDS.test(subject);
  return { merchant, candidate: carrierCandidate || (ORDER_WORDS.test(subject) && (merchant !== 'unknown' || mentionsShop)) };
}

export async function digestKey(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Prototype: real templates and authenticity have not been verified. Always require review.
 * Do not infer order lines, product variants, shipment quantities, or delivery dates.
 * PostalMime's raw/recipient/header values stay in memory and are never returned.
 */
export async function normalizeMail(raw: Uint8Array, source: {
  integrationId: string; mailbox: string; uidValidity: string; uid: number; observedAtISO: string;
}, forceReview = false): Promise<NormalizedCommerceEvent> {
  const mail = await PostalMime.parse(raw, mimeOptions);
  const { merchant } = await inspectCandidate(raw);
  const content = `${mail.subject ?? ''}\n${mail.text ?? ''}`.slice(0, 262144);
  let kind: NormalizedCommerceEvent['kind'] = 'review';
  if (!forceReview) {
    if (/キャンセル(?:が|を)?(?:完了|承り|受け付け)|注文.{0,12}キャンセル|order.{0,20}cancelled/iu.test(content)) kind = 'cancelled';
    else if (/返品(?:を|が)?(?:受け付け|完了)|return.{0,20}(?:received|complete)/iu.test(content)) kind = 'returned';
    else if (/配達(?:が|は)?完了|お届け(?:が|は)?完了|配送(?:が|は)?完了|(?:was|has been) delivered/iu.test(content)) kind = 'delivered';
    else if (/ご注文(?:を|が|ありがとう)|注文(?:確認|を受け)|order confirmation/iu.test(content)) kind = 'ordered';
  }
  const messageId = mail.messageId?.trim();
  // A stable message-id digest avoids duplicate review events after UIDVALIDITY changes.
  // Neither the ID's contents nor a mailbox address are persisted.
  const identity = messageId && messageId.length <= 1000 ? `message:${messageId}` : `uid:${source.mailbox}:${source.uidValidity}:${source.uid}`;
  return {
    id: await digestKey(`${source.integrationId}\n${identity}`), merchant, accountScope: source.integrationId, kind,
    orderId: null, orderLineId: null, productKey: null, shipmentId: null, quantity: null, unit: null,
    orderedAt: null, deliveredAt: null, explicitConfirmed: false, observedAtISO: source.observedAtISO, parserVersion: 1,
  };
}
