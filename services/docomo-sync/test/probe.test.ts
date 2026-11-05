import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectMailEvidence } from '../src/probe.ts';

const source = {
  integrationId: 'synthetic-integration-01', uid: 73,
  internalDate: Date.parse('2026-11-03T08:00:00+09:00'), keyword: '6点テストクリップ',
};
const encoder = new TextEncoder();
function mail(subject: string, body: string, options: { from?: string; html?: boolean; headers?: string; messageId?: string } = {}) {
  return encoder.encode([
    `From: ${options.from ?? 'Synthetic Shop <notice@rakuten.co.jp>'}`,
    'To: PRIVATE-RECIPIENT-MARKER <private-address@example.test>',
    `Message-ID: <${options.messageId ?? 'private-message-marker@example.test'}>`,
    'Date: Sun, 1 Nov 2026 23:00:00 +0900',
    `Subject: ${subject}`,
    options.headers ?? '',
    'MIME-Version: 1.0',
    `Content-Type: ${options.html ? 'text/html' : 'text/plain'}; charset=utf-8`,
  ].filter(Boolean).join('\r\n') + `\r\n\r\n${body}`);
}

test('projection exposes only fixed hints, hashes and canonical public product URLs', async () => {
  const result = await inspectMailEvidence(mail('楽天 ご注文ありがとうございます', [
    '6点テストクリップ',
    '注文番号: 123456-20261103-123456789',
    '数量: 1',
    'PRIVATE-NAME-MARKER 様',
    '送付先 PRIVATE-ADDRESS-MARKER',
    '追跡番号: PRIVATE-TRACKING-MARKER',
    'https://item.rakuten.co.jp/synthetic-shop/hanger-lock/?scid=PRIVATE-QUERY-MARKER#PRIVATE-FRAGMENT-MARKER',
    'https://my.rakuten.co.jp/order/PRIVATE-ORDER-URL?token=PRIVATE-TOKEN-MARKER',
  ].join('\n')), source);
  assert.deepEqual(Object.keys(result).sort(), [
    'messageDigest', 'uid', 'receivedAtISO', 'merchantHint', 'carrierHint', 'keywordMentioned',
    'subjectOrderRelated', 'kindHint', 'subjectKindHint', 'hasText', 'hasHtml', 'orderIdDigests', 'trackingNumberDigests', 'rakutenProductKeys',
    'quantityCandidates', 'explicitQuantitySeen', 'authenticationHints', 'confirmed',
  ].sort());
  assert.match(result.messageDigest, /^[0-9a-f]{64}$/u);
  assert.match(result.orderIdDigests[0], /^[0-9a-f]{64}$/u);
  assert.equal(result.orderIdDigests.length, 1);
  assert.equal(result.receivedAtISO, '2026-11-02T23:00:00.000Z');
  assert.equal(result.uid, 73);
  assert.equal(result.merchantHint, 'rakuten');
  assert.equal(result.kindHint, 'ordered');
  assert.equal(result.keywordMentioned, true);
  assert.equal(result.explicitQuantitySeen, true);
  assert.deepEqual(result.rakutenProductKeys, ['https://item.rakuten.co.jp/synthetic-shop/hanger-lock/']);
  assert.equal(result.confirmed, false);
  const output = JSON.stringify(result);
  for (const value of ['PRIVATE-', 'private-address', 'private-message', '123456-20261103-123456789',
    'ご注文ありがとうございます', '6点テストクリップ', 'my.rakuten', 'scid=', 'token=']) {
    assert.equal(output.includes(value), false, `private value escaped: ${value}`);
  }
});

test('product-name counts never become quantities or delivery confirmation', async () => {
  const result = await inspectMailEvidence(mail('発送のお知らせ', '6点テストクリップ\n明日お届け予定です。'), source);
  assert.equal(result.keywordMentioned, true);
  assert.equal(result.explicitQuantitySeen, false);
  assert.equal(result.kindHint, 'shipped');
  assert.equal(result.confirmed, false);
  for (const text of ['商品名: 6点テストクリップ', '6個セット', '幅60cm', '注文番号: 123456-20261103-12345']) {
    assert.equal((await inspectMailEvidence(mail('商品の情報', text), source)).explicitQuantitySeen, false);
  }
  for (const text of ['数量：２', '注文数 1', 'ご注文個数: 3', 'Quantity: 4', 'QTY = 5']) {
    assert.equal((await inspectMailEvidence(mail('商品の情報', text), source)).explicitQuantitySeen, true);
  }
});

test('HTML-only bodies are inspected statically and never retain executable or personal markup', async () => {
  const result = await inspectMailEvidence(mail('お届けが完了しました', [
    '<html><head><title>PRIVATE-HEAD-MARKER</title><script>throw "PRIVATE-SCRIPT-MARKER"</script></head><body>',
    '<p>6点&nbsp;テスト&#12463;&#12522;&#12483;&#12503;</p>',
    '<table><tr><td>数量</td><td>1</td></tr></table>',
    '<a href="https://item.rakuten.co.jp/synthetic-shop/hanger-lock/?token=PRIVATE-HTML-TOKEN&amp;scid=advertisement">商品</a>',
    '<p>注文番号 123456-20261103-12345</p>',
    '</body></html>',
  ].join(''), { html: true }), source);
  assert.equal(result.hasHtml, true); assert.equal(result.hasText, false);
  assert.equal(result.keywordMentioned, true); assert.equal(result.explicitQuantitySeen, true);
  assert.equal(result.kindHint, 'delivered'); assert.equal(result.confirmed, false);
  assert.deepEqual(result.rakutenProductKeys, ['https://item.rakuten.co.jp/synthetic-shop/hanger-lock/']);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('planned, conditional, negative and quoted delivery language remains review-only', async () => {
  for (const body of [
    '配達完了予定です。', '配達が完了していません。', 'まだ配達完了ではありません。',
    '配達が完了しません。', '配達完了してない。',
    '配達が完了したら通知します。', '配達完了後に更新します。', 'お届け完了までお待ちください。',
    'Your order has not been delivered.', 'Your order will be delivered today.',
    '「配達が完了しました」という例文です。', '> 配達が完了しました',
    'On Tue, Example wrote:\n配達が完了しました',
  ]) {
    const result = await inspectMailEvidence(mail('配送状況', body), source);
    assert.equal(result.kindHint, 'review', body); assert.equal(result.confirmed, false);
  }
  const quoted = await inspectMailEvidence(mail('配送状況', '<p>配送状況をご確認ください。</p><blockquote><p>配達が完了しました</p><blockquote>引用</blockquote></blockquote>', { html: true }), source);
  assert.equal(quoted.kindHint, 'review');
  const htmlExample = await inspectMailEvidence(mail('配送状況', '<script>配達が完了しました</script><style>配達完了</style><p>ご確認ください</p>', { html: true }), source);
  assert.equal(htmlExample.kindHint, 'review');
});

test('carrier mail can be order-related without the merchant candidate filter', async () => {
  const result = await inspectMailEvidence(mail('お届け完了のお知らせ', 'お届けが完了しました。', { from: 'notice@kuronekoyamato.co.jp' }), source);
  assert.equal(result.carrierHint, 'yamato'); assert.equal(result.merchantHint, 'unknown');
  assert.equal(result.subjectOrderRelated, true); assert.equal(result.kindHint, 'delivered');
  assert.equal(result.confirmed, false);
  assert.equal((await inspectMailEvidence(mail('配送のお知らせ', '', { from: 'notice@sagawa-exp.co.jp' }), source)).carrierHint, 'sagawa');
  assert.equal((await inspectMailEvidence(mail('配達完了', '', { from: 'notice@post.japanpost.jp' }), source)).carrierHint, 'japanpost');
  const fake = await inspectMailEvidence(mail('日記', 'Hello', { from: 'notice@rakuten.co.jp.evil.test' }), source);
  assert.equal(fake.merchantHint, 'unknown'); assert.equal(fake.subjectOrderRelated, false);
});

test('authentication headers are reported as mentions and never promoted to confirmation', async () => {
  const result = await inspectMailEvidence(mail('配達完了', '配達が完了しました', { headers:
    'Authentication-Results: synthetic.example; dkim=pass header.d=example.test; spf=pass smtp.mailfrom=example.test\r\nX-Private-Marker: PRIVATE-AUTH-MARKER',
  }), source);
  assert.deepEqual(result.authenticationHints, { dkimPassMentioned: true, spfPassMentioned: true });
  assert.equal(result.confirmed, false); assert.equal(JSON.stringify(result).includes('example.test'), false);
  const failed = await inspectMailEvidence(mail('配達完了', 'dkim=pass spf=pass', { headers: 'Authentication-Results: synthetic.example; dkim=fail; spf=fail' }), source);
  assert.deepEqual(failed.authenticationHints, { dkimPassMentioned: false, spfPassMentioned: false });
  const spf = await inspectMailEvidence(mail('配達完了', '', { headers: 'Received-SPF: Pass (synthetic.example)' }), source);
  assert.equal(spf.authenticationHints.spfPassMentioned, true);
});

test('order IDs are shape-bounded, deduplicated and integration-salted', async () => {
  const body = [
    '123456-20261103-12345', '123456-20261103-12345', '123-1234567-1234567',
    'x123456-20261103-12345', '123456-20261103-1234567890123', '123456-20261103-1234',
    '1234567-20261103-12345', '123-1234567-12345678',
  ].join('\n');
  const result = await inspectMailEvidence(mail('注文確認', body), source);
  assert.equal(result.orderIdDigests.length, 2);
  const other = await inspectMailEvidence(mail('注文確認', body), { ...source, integrationId: 'synthetic-other-scope' });
  assert.ok(result.orderIdDigests.every(value => !other.orderIdDigests.includes(value)));
  assert.notEqual(result.messageDigest, other.messageDigest);
  assert.equal((await inspectMailEvidence(mail('注文確認', body), { ...source, uid: 99 })).messageDigest, result.messageDigest);
});

test('labelled tracking hashes join shipment and delivery without leaking original values', async () => {
  const shipped = await inspectMailEvidence(mail('発送のお知らせ', '6点テストクリップ\nお問い合わせ伝票番号：1234-5678-9012'), source);
  const delivered = await inspectMailEvidence(mail('お届け完了のお知らせ', '配達が完了しました。\nTracking number: 1234 5678 9012', {
    from: 'notice@kuronekoyamato.co.jp', messageId: 'synthetic-carrier-message@example.test',
  }), source);
  assert.equal(shipped.trackingNumberDigests.length, 1);
  assert.match(shipped.trackingNumberDigests[0], /^[0-9a-f]{64}$/u);
  assert.deepEqual(delivered.trackingNumberDigests, shipped.trackingNumberDigests);
  assert.equal(delivered.keywordMentioned, false);
  assert.equal(delivered.kindHint, 'delivered');
  assert.equal(shipped.confirmed, false); assert.equal(delivered.confirmed, false);
  const other = await inspectMailEvidence(mail('発送のお知らせ', '追跡番号: 123456789012'), { ...source, integrationId: 'synthetic-other-scope' });
  assert.notDeepEqual(other.trackingNumberDigests, shipped.trackingNumberDigests);
  for (const evidence of [shipped, delivered, other]) {
    const serialized = JSON.stringify(evidence);
    for (const raw of ['1234-5678-9012', '1234 5678 9012', '123456789012']) assert.equal(serialized.includes(raw), false);
  }
});

test('tracking extraction requires an explicit label and a complete ten-to-fourteen-digit value', async () => {
  for (const label of ['お問い合わせ伝票番号', 'お問い合わせ番号', 'お問合せ番号', 'お問合せ伝票番号',
    '送り状番号', '伝票番号', '追跡番号', 'tracking number', '[お問い合わせ番号]', '【お問合せ番号】',
    '送状No', '送り状No.', '[伝票No.]', 'お荷物伝票番号']) {
    const evidence = await inspectMailEvidence(mail('配送状況', `${label}: 1234567890\n${label}: １２３４５６７８９０１２３４`), source);
    assert.equal(evidence.trackingNumberDigests.length, 2, label);
  }
  for (const text of [
    '電話番号: 090-1234-5678', '金額: 123456789012円', '6点テストクリップ',
    '注文番号: 123456-20261103-12345', '1234-5678-9012',
    'お問い合わせ番号: 123456789', '追跡番号: 123456789012345',
    '伝票番号: 1234-5678-9012-345', 'tracking number: 123456789012abc', '追跡番号: 123456789012-',
    'お問い合わせ: 090-1234-5678',
    '追跡番号: ' + '1'.repeat(100),
  ]) {
    assert.deepEqual((await inspectMailEvidence(mail('配送状況', text), source)).trackingNumberDigests, [], text);
  }
  const html = await inspectMailEvidence(mail('配送状況', '<table><tr><td>お問い合わせ番号</td><td>1234-5678-9012</td></tr></table>', { html: true }), source);
  assert.equal(html.trackingNumberDigests.length, 1);
});

test('product links discard personal endpoints, unsafe hosts, attributes and query data', async () => {
  const content = [
    'https://item.rakuten.co.jp/shop-name/item-001/?scid=PRIVATE-TOKEN',
    'https://item.rakuten.co.jp/shop-name/item-001/#PRIVATE-FRAGMENT',
    'https://item.rakuten.co.jp.evil.test/shop-name/item-002/',
    'http://item.rakuten.co.jp/shop-name/item-003/',
    'https://item.rakuten.co.jp:444/shop-name/item-004/',
    'http://item.rakuten.co.jp:80/shop-name/item-007/',
    'https://item.rakuten.co.jp:443/shop-name/item-008/',
    'https://item.rakuten.co.jp/shop-name/item-005/orders/private/',
    'https://item.rakuten.co.jp/shop-name/private@example.test/',
    'https://item.rakuten.co.jp/shop-name/item%2Fprivate/',
    'https://user:private@item.rakuten.co.jp/shop-name/item-006/',
    'https://my.rakuten.co.jp/order/private/?token=PRIVATE-TOKEN',
  ].join('\n');
  assert.deepEqual((await inspectMailEvidence(mail('商品案内', content), source)).rakutenProductKeys,
    ['https://item.rakuten.co.jp/shop-name/item-001/', 'https://item.rakuten.co.jp/shop-name/item-003/']);
});

test('quantity candidates require explicit bracket labels or complete price-times-unit syntax', async () => {
  for (const text of ['[個数] 1', '【数量】：１', '(注文数) = 1', '1,234(円) x 1 (個)', '999円×1(個)']) {
    const result = await inspectMailEvidence(mail('ご注文内容ご確認', text), source);
    assert.deepEqual(result.quantityCandidates, [1], text);
    assert.equal(result.explicitQuantitySeen, true); assert.equal(result.confirmed, false);
  }
  const two = await inspectMailEvidence(mail('注文確認', '[個数] 2\n【数量】2\n1999(円) x 3 (個)\n数量:9999'), source);
  assert.deepEqual(two.quantityCandidates, [2, 3, 9999]);
  for (const text of ['6点テストクリップ', '[個数] 0', '[個数] -1', '[個数] 10000', '数量:1.5',
    'quantity6', '金額:1234円', '1234 x 1 (個)', '1234円 x 1', '1234円 x 10000(個)', '注文番号:123456-20261103-12345']) {
    const result = await inspectMailEvidence(mail('商品案内', text), source);
    assert.deepEqual(result.quantityCandidates, [], text); assert.equal(result.explicitQuantitySeen, false);
  }
  const bounded = await inspectMailEvidence(mail('注文確認', Array.from({ length: 25 }, (_, index) => `[個数] ${index + 1}`).join('\n')), source);
  assert.equal(bounded.quantityCandidates.length, 20);
});

test('subject hints stay separate from cancellation wording in body boilerplate', async () => {
  const shipment = await inspectMailEvidence(mail('商品発送のご連絡', '6点テストクリップ\n注文をキャンセルする場合はご連絡ください。'), source);
  assert.equal(shipment.subjectKindHint, 'shipped');
  assert.equal(shipment.kindHint, 'cancelled');
  assert.equal(shipment.confirmed, false);
  for (const subject of ['ご注文内容ご確認', 'ご注文内容のご確認']) {
    const ordered = await inspectMailEvidence(mail(subject, ''), source);
    assert.equal(ordered.subjectKindHint, 'ordered'); assert.equal(ordered.confirmed, false);
  }
  const planned = await inspectMailEvidence(mail('商品発送予定のご連絡', '配達が完了しました。'), source);
  assert.equal(planned.subjectKindHint, 'review'); assert.equal(planned.kindHint, 'delivered');
});

test('encoded MIME subjects and normalized keywords work without returning subject text', async () => {
  const subject = Buffer.from('楽天 配達完了').toString('base64');
  const result = await inspectMailEvidence(mail(`=?UTF-8?B?${subject}?=`, '６点 テスト クリップ'), source);
  assert.equal(result.keywordMentioned, true); assert.equal(result.subjectOrderRelated, true);
  assert.equal(result.kindHint, 'delivered'); assert.equal(result.explicitQuantitySeen, false);
  assert.equal(JSON.stringify(result).includes('楽天'), false);
});

test('untrusted inputs are bounded and fail with a fixed error only', async () => {
  const raw = mail('PRIVATE-SUBJECT', 'PRIVATE-BODY');
  for (const input of [
    { ...source, uid: 0 }, { ...source, uid: Number.MAX_SAFE_INTEGER + 1 },
    { ...source, internalDate: NaN }, { ...source, internalDate: 8640000000000001 },
    { ...source, keyword: '' }, { ...source, keyword: ' '.repeat(10) },
    { ...source, keyword: 'x'.repeat(161) }, { ...source, integrationId: '' },
  ]) await assert.rejects(() => inspectMailEvidence(raw, input), { message: 'invalid_probe_input' });
  await assert.rejects(() => inspectMailEvidence(new Uint8Array(262145), source), { message: 'invalid_probe_input' });
  await assert.rejects(() => inspectMailEvidence(new Uint8Array(0), source), { message: 'invalid_probe_input' });
});
