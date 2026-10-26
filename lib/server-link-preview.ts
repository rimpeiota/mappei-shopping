export type LinkPreview = {
  title: string;
  url: string;
  site: string;
  resolved: boolean;
  message?: string;
};

type ShoppingSite = { hosts: readonly string[]; name: string; aliases: readonly string[] };

// Exact, vendor-controlled hosts prevent arbitrary DNS names (and rebinding) from being fetched.
// Short links may redirect only to another entry in this same list.
const SHOPPING_SITES: readonly ShoppingSite[] = [
  { hosts: ["amazon.co.jp", "www.amazon.co.jp", "amazon.com", "www.amazon.com", "amzn.asia", "amzn.to"], name: "Amazon", aliases: ["Amazon.co.jp", "Amazon.com", "Amazon", "アマゾン"] },
  { hosts: ["item.rakuten.co.jp", "www.rakuten.co.jp", "books.rakuten.co.jp", "a.r10.to"], name: "楽天市場", aliases: ["楽天市場", "楽天ブックス", "Rakuten"] },
  { hosts: ["shopping.yahoo.co.jp", "store.shopping.yahoo.co.jp"], name: "Yahoo!ショッピング", aliases: ["Yahoo!ショッピング", "Yahoo! ショッピング", "Yahooショッピング"] },
  { hosts: ["muji.com", "www.muji.com"], name: "無印良品", aliases: ["無印良品", "無印良品ネットストア", "MUJI"] },
  { hosts: ["uniqlo.com", "www.uniqlo.com"], name: "ユニクロ", aliases: ["ユニクロ", "UNIQLO"] },
  { hosts: ["nitori-net.jp", "www.nitori-net.jp"], name: "ニトリ", aliases: ["ニトリ", "ニトリネット", "ニトリ公式通販"] },
  { hosts: ["yodobashi.com", "www.yodobashi.com"], name: "ヨドバシ", aliases: ["ヨドバシ.com", "ヨドバシ"] },
  { hosts: ["biccamera.com", "www.biccamera.com"], name: "ビックカメラ", aliases: ["ビックカメラ.com", "ビックカメラ"] },
  { hosts: ["ikea.com", "www.ikea.com"], name: "IKEA", aliases: ["IKEA", "IKEA Japan"] },
  { hosts: ["loft.co.jp", "www.loft.co.jp"], name: "ロフト", aliases: ["ロフト", "ロフトネットストア", "LOFT"] },
  { hosts: ["zozo.jp"], name: "ZOZOTOWN", aliases: ["ZOZOTOWN", "ゾゾタウン"] },
  { hosts: ["qoo10.jp", "www.qoo10.jp"], name: "Qoo10", aliases: ["Qoo10", "Qoo10 - ネット通販"] },
  { hosts: ["costco.co.jp", "www.costco.co.jp"], name: "コストコ", aliases: ["コストコ", "コストコオンライン", "Costco Japan"] },
  { hosts: ["apple.com", "www.apple.com"], name: "Apple", aliases: ["Apple", "Apple（日本）", "Apple (日本)"] },
  { hosts: ["store.google.com"], name: "Google ストア", aliases: ["Google ストア", "Google Store"] },
  { hosts: ["jp.mercari.com"], name: "メルカリ", aliases: ["メルカリ", "Mercari"] },
  { hosts: ["uktsc.com", "www.uktsc.com"], name: "SUIT SQUARE", aliases: ["SUIT SQUARE", "SUIT SQUARE／UNIVERSAL LANGUAGE", "SUIT SQUARE（スーツスクエア）の公式ファッション通販サイト", "スーツスクエア×ユニバーサルランゲージ", "THE SUIT COMPANY", "ザ・スーツカンパニー"] },
  { hosts: ["store.united-arrows.co.jp"], name: "UNITED ARROWS", aliases: ["UNITED ARROWS", "ユナイテッドアローズ公式通販", "ユナイテッドアローズ公式通販 - UNITED ARROWS ONLINE", "UNITED ARROWS ONLINE"] },
];

const HOST_TO_SITE = new Map(SHOPPING_SITES.flatMap((site) => site.hosts.map((host) => [host, site] as const)));
const MAX_HTML_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 8_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class PreviewUrlError extends Error {
  constructor() { super("HTTPSの公開商品URLを入力してください。"); }
}

export function validatePreviewUrl(input: string): URL {
  if (!input || input.length > 4096 || /[\u0000-\u0020\u007f\\]/u.test(input)) throw new PreviewUrlError();
  let url: URL;
  try { url = new URL(input); } catch { throw new PreviewUrlError(); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
    || !host || !host.includes(".") || host.endsWith(".") || host.includes(":") || host.includes("[")
    || /^\d+(?:\.\d+){0,3}$/u.test(host)
    || /(?:^|\.)(?:localhost|local|internal|intranet|test|invalid|example|onion|home|lan)$/u.test(host)) throw new PreviewUrlError();
  url.hash = "";
  return url;
}

export function supportedPreviewSite(url: URL): string | null {
  return HOST_TO_SITE.get(url.hostname.toLowerCase())?.name ?? null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  ndash: "–", mdash: "—", hellip: "…", middot: "·", copy: "©", reg: "®", trade: "™", yen: "¥", times: "×", bull: "•",
};

export function decodeMetadataEntities(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|[0-9]+);?|&([a-z][a-z0-9]+);/giu, (entity, numeric: string | undefined, named: string | undefined) => {
    if (named) return NAMED_ENTITIES[named.toLowerCase()] ?? entity;
    const code = numeric?.toLowerCase().startsWith("x") ? Number.parseInt(numeric.slice(1), 16) : Number(numeric);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
  });
}

function escapePattern(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }

export function normalizeProductTitle(raw: string, aliases: readonly string[] = []): string | null {
  let title = decodeMetadataEntities(raw).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim();
  // Strip only known shop labels at a clear boundary, never arbitrary product suffixes.
  const knownSites = [...aliases].filter(Boolean).sort((a, b) => b.length - a.length);
  for (let pass = 0; pass < 2; pass++) {
    for (const alias of knownSites) {
      const escaped = escapePattern(alias);
      title = title.replace(new RegExp(`^\\s*(?:【${escaped}】|\\[${escaped}\\]|${escaped}\\s*[|｜:：–—-])\\s*`, "iu"), "")
        .replace(new RegExp(`\\s*[|｜:：–—-]\\s*${escaped}\\s*$`, "iu"), "").trim();
    }
  }
  if (knownSites.some((alias) => alias === "ヨドバシ" || alias === "ヨドバシ.com")) {
    title = title.replace(/\s+通販【全品無料配達】\s*$/u, "").trim();
  }
  if (!title || knownSites.some((alias) => title.toLowerCase() === alias.toLowerCase())
    || /(?:captcha|robot check|access denied|access blocked|just a moment|are you a robot|ご利用の確認|アクセスが拒否|ページが見つかりません|お探しのページ|ロボットではない|人間であること|ログインしてください)/iu.test(title)
    || /^(?:ログイン|サインイン|Sign in|Login|404(?: Not Found)?|Forbidden|Error)$/iu.test(title)) return null;
  return Array.from(title).slice(0, 240).join("");
}

type HtmlTag = { name: string; closing: boolean; attributes: Map<string, string>; end: number };

// This bounded tokenizer reads data only: it never constructs a DOM, evaluates script,
// resolves <base>, or follows links from untrusted HTML. It respects quoted '>' characters.
function readTag(html: string, start: number): HtmlTag | null {
  let quote = "";
  let end = start + 1;
  for (; end < html.length; end++) {
    const char = html[end];
    if (quote) { if (char === quote) quote = ""; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === ">") break;
  }
  if (end >= html.length) return null;
  const body = html.slice(start, end + 1);
  const tag = body.match(/^<\s*(\/?)\s*([a-z][a-z0-9:-]*)\b/iu);
  if (!tag) return { name: "", closing: false, attributes: new Map(), end: end + 1 };
  const attributes = new Map<string, string>();
  const source = body.slice(tag[0].length, -1);
  for (const match of source.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu)) {
    const key = match[1].toLowerCase();
    if (!attributes.has(key)) attributes.set(key, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return { name: tag[2].toLowerCase(), closing: Boolean(tag[1]), attributes, end: end + 1 };
}

export function extractProductTitle(html: string, pageUrl: URL): string | null {
  const site = HOST_TO_SITE.get(pageUrl.hostname.toLowerCase());
  const candidates = { og: [] as string[], twitter: [] as string[], title: [] as string[] };
  const aliases = site ? [site.name, ...site.aliases, ...site.hosts] : [pageUrl.hostname];
  let position = 0;
  while (position < html.length) {
    const start = html.indexOf("<", position);
    if (start < 0) break;
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      if (end < 0) break;
      position = end + 3;
      continue;
    }
    const tag = readTag(html, start);
    if (!tag) break;
    position = tag.end;
    if (!tag.name) continue;
    if ((tag.name === "head" && tag.closing) || (tag.name === "body" && !tag.closing)) break;
    if (tag.closing) continue;
    if (["script", "style", "textarea", "xmp", "iframe", "noembed", "noframes", "noscript", "template"].includes(tag.name)) {
      const closing = new RegExp(`</\\s*${tag.name}\\s*>`, "giu");
      closing.lastIndex = position;
      const end = closing.exec(html);
      if (!end) break;
      position = end.index + end[0].length;
      continue;
    }
    if (tag.name === "title") {
      const closing = /<\/\s*title\s*>/giu;
      closing.lastIndex = position;
      const end = closing.exec(html);
      if (end) { candidates.title.push(html.slice(position, end.index)); position = end.index + end[0].length; }
    } else if (tag.name === "meta") {
      const field = (tag.attributes.get("property") ?? tag.attributes.get("name") ?? "").trim().toLowerCase();
      const content = tag.attributes.get("content");
      if (content === undefined) continue;
      if (field === "og:title") candidates.og.push(content);
      else if (field === "twitter:title") candidates.twitter.push(content);
    }
  }
  for (const raw of [...candidates.og, ...candidates.twitter, ...candidates.title]) {
    const title = normalizeProductTitle(raw, aliases);
    if (title) return title;
  }
  return null;
}

function unresolved(url: URL, message: string): LinkPreview {
  return { title: "", url: url.href, site: supportedPreviewSite(url) ?? url.hostname, resolved: false, message };
}

async function readHtml(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // Product pages may have megabytes of body markup. Read only a bounded prefix;
      // a complete title/meta in the head is sufficient and the remaining stream is cancelled.
      const remaining = MAX_HTML_BYTES - size;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      size += chunk.byteLength;
      if (size === MAX_HTML_BYTES) { await reader.cancel(); break; }
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
  const charset = response.headers.get("content-type")?.match(/charset\s*=\s*["']?([^\s;"']+)/iu)?.[1] ?? "utf-8";
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

type PreviewFetcher = (url: string, init: RequestInit) => Promise<Response>;
type PreviewFailureCode = "timeout" | "fetch_failed" | "no_title" | `http_${number}`;

export async function resolveLinkPreview(input: string, fetcher: PreviewFetcher = fetch): Promise<LinkPreview> {
  const original = validatePreviewUrl(input);
  if (!supportedPreviewSite(original)) return unresolved(original, "このサイトの自動取得には未対応です。商品名を入力してください。");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failureLogged = false;
  const failed = (message: string, code: PreviewFailureCode): LinkPreview => {
    // Log only fixed internal codes / HTTP status; never URL, title, body, or exceptions.
    if (!failureLogged) { console.warn("[shopping-link]", code); failureLogged = true; }
    return unresolved(original, message);
  };
  const work = async (): Promise<LinkPreview> => {
    let current = original;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      if (controller.signal.aborted) return failed("取得に時間がかかっています。商品名を入力してください。", "timeout");
      const response = await fetcher(current.href, {
        method: "GET", redirect: "manual", credentials: "omit", signal: controller.signal,
        headers: { Accept: "text/html,application/xhtml+xml", "Accept-Language": "ja,en;q=0.7", "User-Agent": "MappeiShopping/1.0" },
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects === MAX_REDIRECTS) return failed("商品ページへ移動できませんでした。商品名を入力してください。", "fetch_failed");
        let next: URL;
        try { next = validatePreviewUrl(new URL(location, current).href); }
        catch { return failed("安全に取得できない移動先です。商品名を入力してください。", "fetch_failed"); }
        if (!supportedPreviewSite(next)) return failed("移動先サイトの自動取得には未対応です。商品名を入力してください。", "fetch_failed");
        current = next;
        continue;
      }
      if (!response.ok || !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/iu.test(response.headers.get("content-type") ?? "")) {
        await response.body?.cancel();
        return failed("商品ページを読み取れませんでした。商品名を入力してください。", response.ok ? "fetch_failed" : `http_${response.status}`);
      }
      const html = await readHtml(response);
      if (html === null) return failed("ページを読み取れる範囲を超えました。商品名を入力してください。", "fetch_failed");
      const title = extractProductTitle(html, current);
      return title ? { title, url: current.href, site: supportedPreviewSite(current)!, resolved: true }
        : failed("商品名を見つけられませんでした。商品名を入力してください。", "no_title");
    }
    return failed("商品ページへ移動できませんでした。商品名を入力してください。", "fetch_failed");
  };
  try {
    const timeout = new Promise<LinkPreview>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(failed("取得に時間がかかっています。商品名を入力してください。", "timeout")); }, TIMEOUT_MS);
    });
    return await Promise.race([work(), timeout]);
  } catch { return failed("商品ページを取得できませんでした。商品名を入力してください。", controller.signal.aborted ? "timeout" : "fetch_failed"); }
  finally { if (timer) clearTimeout(timer); }
}
