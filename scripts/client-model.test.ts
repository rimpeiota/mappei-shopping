import assert from 'node:assert/strict';
import test from 'node:test';
const { parseQuickText, needsProductName, itemLink, newItem, togglePurchased, applyProductTitle } = await import(new URL('../lib/client-model.ts', import.meta.url).href) as typeof import('../lib/client-model');

test('URL query punctuation is preserved as one product and never becomes the product name', () => {
  const url='https://www.amazon.co.jp/dp/B012345678?tag=a,b;ref=x';
  const items=parseQuickText(url);
  assert.equal(items.length,1); assert.equal(items[0].url,url);
  assert.equal(needsProductName(items[0]),true); assert.notEqual(items[0].name,'www.amazon.co.jp');
});
test('explicit product name and quantity are kept separately from the URL', () => {
  const [item]=parseQuickText('電動歯ブラシ2本 https://www.yodobashi.com/product/123/');
  assert.equal(item.name,'電動歯ブラシ'); assert.equal(item.quantity,2);
  assert.equal(item.url,'https://www.yodobashi.com/product/123/'); assert.equal(needsProductName(item),false);
});
test('multiple URL notes and normal groceries retain their identities', () => {
  const items=parseQuickText('牛乳2本\nhttps://www.amazon.co.jp/dp/AAA?a=1,2\nhttps://www.muji.com/jp/ja/store/test');
  assert.equal(items.length,3); assert.equal(items[0].name,'牛乳'); assert.equal(items[0].quantity,2);
  assert.ok(items[1].url.endsWith('?a=1,2')); assert.equal(needsProductName(items[2]),true);
});
test('model numbers without a quantity unit remain part of the product name', () => {
  assert.equal(parseQuickText('iPhone 16')[0].name,'iPhone 16'); assert.equal(parseQuickText('iPhone 16')[0].quantity,1);
});
test('legacy raw URL and hostname names can be repaired without changing named items', () => {
  assert.equal(needsProductName(newItem('www.amazon.co.jp',{url:'https://www.amazon.co.jp/dp/X'})),true);
  const raw=newItem('https://www.yodobashi.com/product/123/');
  assert.equal(needsProductName(raw),true); assert.equal(itemLink(raw),raw.name);
  assert.equal(needsProductName(newItem('シャンプー',{url:'https://www.amazon.co.jp/dp/X'})),false);
});
test('one checkbox purchase updates history and stock; unchecking restores unpurchased state', () => {
  const before=newItem('牛乳',{quantity:2,stock:3});
  const checked=togglePurchased(before);
  assert.equal(checked.status,'purchased'); assert.equal(checked.stock,5); assert.equal(checked.purchasedQuantity,2); assert.ok(checked.purchasedAt);
  const unchecked=togglePurchased(checked);
  assert.equal(unchecked.status,'planned'); assert.equal(unchecked.stock,3); assert.equal(unchecked.purchasedQuantity,0); assert.equal(unchecked.purchasedAt,'');
});
test('purchasing partially bought quantities does not count the already bought portion twice', () => {
  const checked=togglePurchased(newItem('タオル',{quantity:3,purchasedQuantity:1,stock:1}));
  assert.equal(checked.stock,3); assert.equal(checked.purchasedQuantity,3);
});

test('late product titles cannot replace a manual draft, saved name, or changed URL', () => {
  const url='https://www.amazon.co.jp/dp/QA';
  const pending=newItem('商品名を入力',{url});
  assert.equal(applyProductTitle(pending,url,'サーバーの商品名',true),pending);
  const named={...pending,name:'自分で付けた名前'};
  assert.equal(applyProductTitle(named,url,'サーバーの商品名'),named);
  const changed={...pending,url:'https://www.amazon.co.jp/dp/OTHER'};
  assert.equal(applyProductTitle(changed,url,'古いページの商品名'),changed);
  assert.equal(applyProductTitle(pending,url,' 実際の商品名 ').name,'実際の商品名');
});
