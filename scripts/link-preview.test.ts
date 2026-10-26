import assert from "node:assert/strict";
import test from "node:test";
const { validatePreviewUrl, supportedPreviewSite, normalizeProductTitle, extractProductTitle, resolveLinkPreview } =
  await import(new URL("../lib/server-link-preview.ts", import.meta.url).href) as typeof import("../lib/server-link-preview");

const page = new URL("https://www.amazon.co.jp/dp/TEST");

test("public HTTPS product URLs retain query and lose fragments", () => {
  assert.equal(validatePreviewUrl("https://www.amazon.co.jp:443/dp/TEST?ref=a#details").href, "https://www.amazon.co.jp/dp/TEST?ref=a");
  assert.equal(supportedPreviewSite(page), "Amazon");
});

test("the exact SUIT SQUARE and UNITED ARROWS storefront hosts are supported", () => {
  for (const host of ["uktsc.com", "www.uktsc.com"]) assert.equal(supportedPreviewSite(new URL(`https://${host}/product/example`)), "SUIT SQUARE");
  assert.equal(supportedPreviewSite(new URL("https://store.united-arrows.co.jp/product/example")), "UNITED ARROWS");
  assert.equal(supportedPreviewSite(new URL("https://store.united-arrows.co.jp.attacker.com/product/example")), null);
});

test("unsafe protocols, credentials, ports, IP variants, and internal names are rejected", () => {
  for (const value of ["http://www.amazon.co.jp/x", "file:///etc/passwd", "https://u:p@www.amazon.co.jp/", "https://www.amazon.co.jp:444/", "https://127.0.0.1/", "https://2130706433/", "https://0x7f000001/", "https://[::1]/", "https://localhost/", "https://shop.internal/", "https://amazon.co.jp./", "https://www.amazon.co.jp\\@127.0.0.1/"]) {
    assert.throws(() => validatePreviewUrl(value), /HTTPS/u, value);
  }
});

test("unknown hosts and lookalikes are not fetched", async () => {
  let calls = 0;
  const noFetch = async () => { calls++; throw new Error("unexpected fetch"); };
  for (const value of ["https://www.amazon.co.jp.attacker.com/item", "https://attacker-amazon.co.jp/item", "https://shop.example.com/item"]) {
    const result = await resolveLinkPreview(value, noFetch);
    assert.equal(result.resolved, false);
    assert.match(result.message!, /商品名を入力/);
  }
  assert.equal(calls, 0);
});

test("OG title wins, handles attribute order/quotes, and decodes entities", () => {
  const html = `<!doctype html><html><head><title>fallback - Amazon.co.jp</title><meta content='リンゴ &amp; はちみつ &#xFF12;本 &quot;特製&quot; | Amazon.co.jp' property="og:title"><meta name="twitter:title" content="twitter"></head><body></body></html>`;
  assert.equal(extractProductTitle(html, page), 'リンゴ & はちみつ ２本 "特製"');
});

test("quoted greater-than signs do not terminate metadata attributes", () => {
  assert.equal(extractProductTitle(`<head><meta property="og:title" content="A > B 商品 | Amazon.co.jp"></head>`, page), "A > B 商品");
});

test("fake metadata in comments/scripts/templates and body is ignored", () => {
  const html = `<head><!-- <meta property="og:title" content="comment"> --><script>const s='<meta property="og:title" content="script">';</script><template><meta property="og:title" content="template"></template><title>実際の商品 | Amazon.co.jp</title></head><body><meta property="og:title" content="body"></body>`;
  assert.equal(extractProductTitle(html, page), "実際の商品");
});

test("twitter title and title fallback work without inventing metadata", () => {
  assert.equal(extractProductTitle(`<head><meta content="カップ 2個" name="twitter:title"><title>other</title></head>`, page), "カップ 2個");
  assert.equal(extractProductTitle(`<head><title>耐熱カップ - 黒 - Amazon.co.jp</title></head>`, page), "耐熱カップ - 黒");
  assert.equal(extractProductTitle(`<head><script>window.productName='secret';</script></head>`, page), null);
});

test("only known shop labels are removed and challenge pages remain unresolved", () => {
  assert.equal(normalizeProductTitle("【楽天市場】 マグカップ - Black | 楽天市場", ["楽天市場"]), "マグカップ - Black");
  assert.equal(normalizeProductTitle("Robot Check", ["Amazon"]), null);
  assert.equal(normalizeProductTitle("Amazon", ["Amazon"]), null);
  assert.equal(normalizeProductTitle("\n  靴下 &nbsp; 3足\tセット  "), "靴下 3足 セット");
});

test("Yodobashi's exact delivery tagline is removed while preserving the product", () => {
  const html = `<head><meta property="og:title" content="サランラップ サランラップ 30cm×20m 通販【全品無料配達】"></head>`;
  assert.equal(extractProductTitle(html, new URL("https://www.yodobashi.com/product/100000001002327911/")), "サランラップ サランラップ 30cm×20m");
  assert.equal(normalizeProductTitle("通販【全品無料配達】 解説本", ["ヨドバシ"]), "通販【全品無料配達】 解説本");
});

test("SUIT SQUARE's known stacked site labels are removed without altering the product", () => {
  const html = `<head><meta property="og:title" content="ウォッシャブルシャツ／長袖 | SUIT SQUARE／UNIVERSAL LANGUAGE | SUIT SQUARE（スーツスクエア）の公式ファッション通販サイト | スーツスクエア&#215;ユニバーサルランゲージ"></head>`;
  assert.equal(extractProductTitle(html, new URL("https://www.uktsc.com/product/example")), "ウォッシャブルシャツ／長袖");
});

test("public storefront anti-bot HTML without product metadata stays unresolved", () => {
  const html = `<html><body><script src="/challenge.js"></script><div>Protected storefront</div></body></html>`;
  assert.equal(extractProductTitle(html, new URL("https://store.united-arrows.co.jp/product/example")), null);
});

test("failure logging contains only the fixed code, never URL, response, or exception content", async () => {
  const warnings: unknown[][] = [];
  const previousWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    await resolveLinkPreview(page.href, async () => new Response("private provider details", { status: 403 }));
    await resolveLinkPreview(page.href, async () => { throw new Error("sensitive error details"); });
    await resolveLinkPreview(page.href, async () => new Response("<html><head></head></html>", { headers: { "content-type": "text/html" } }));
  } finally { console.warn = previousWarn; }
  assert.deepEqual(warnings, [["[shopping-link]", "http_403"], ["[shopping-link]", "fetch_failed"], ["[shopping-link]", "no_title"]]);
});

test("every redirect is checked before issuing another request", async () => {
  let calls = 0;
  for (const target of ["https://127.0.0.1/private", "https://unknown.shop/product", "http://www.amazon.co.jp/product"]) {
    const result = await resolveLinkPreview(page.href, async () => { calls++; return new Response(null, { status: 302, headers: { location: target } }); });
    assert.equal(result.resolved, false);
  }
  assert.equal(calls, 3);
});

test("a supported shortlink redirects safely without forwarding credentials", async () => {
  const calls: string[] = [];
  const result = await resolveLinkPreview("https://amzn.asia/d/test", async (url, init) => {
    calls.push(url);
    assert.equal(init.redirect, "manual");
    assert.equal(init.credentials, "omit");
    const headers = new Headers(init.headers);
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("cookie"), false);
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: page.href } })
      : new Response(`<head><title>耐熱カップ | Amazon.co.jp</title></head>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  });
  assert.deepEqual(result, { title: "耐熱カップ", url: page.href, site: "Amazon", resolved: true });
  assert.equal(calls.length, 2);
});

test("redirects stop after three allowed hops", async () => {
  let calls = 0;
  const result = await resolveLinkPreview(page.href, async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: `/item/${calls}` } });
  });
  assert.equal(result.resolved, false);
  assert.equal(calls, 4);
});

test("non-HTML and responses larger than 512KiB fall back to manual naming", async () => {
  for (const response of [
    new Response("not HTML", { headers: { "content-type": "application/json" } }),
    new Response("too big", { headers: { "content-type": "text/html", "content-length": String(512 * 1024 + 1) } }),
    new Response("x".repeat(512 * 1024 + 1), { headers: { "content-type": "text/html" } }),
  ]) {
    assert.equal((await resolveLinkPreview(page.href, async () => response)).resolved, false);
  }
});

test("large product pages can resolve from complete head metadata within the 512KiB prefix", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`<head><meta property="og:title" content="耐熱マグ | Amazon.co.jp"></head><body>${"x".repeat(600 * 1024)}`));
    },
    cancel() { cancelled = true; },
  });
  const response = new Response(stream, { headers: { "content-type": "text/html", "content-length": String(600 * 1024) } });
  const result = await resolveLinkPreview(page.href, async () => response);
  assert.equal(result.title, "耐熱マグ");
  assert.equal(result.resolved, true);
  assert.equal(cancelled, true);
});
