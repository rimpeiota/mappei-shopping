export type ParsedItem = {
  name: string; quantity: number; unit: string;
  category: "食品" | "日用品" | "衣類" | "家電" | "その他";
  store?: string;
};

const UNITS = "パック|ケース|セット|キログラム|ミリリットル|グラム|リットル|kg|ml|mL|cm|個|本|袋|箱|枚|缶|玉|束|房|粒|足|着|台|冊|組|g|L|l";
const QUANTITY = "([0-9]+(?:\\.[0-9]+)?)\\s*(" + UNITS + ")";
const suffixQuantity = new RegExp("\\s*(?:を)?\\s*" + QUANTITY + "\\s*$", "iu");
const prefixQuantity = new RegExp("^" + QUANTITY + "\\s*(?:の)?\\s*", "iu");

function normalize(value: string): string {
  return value.replace(/[０-９．]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[一二三四五六七八九十]+(?=\s*(?:個|本|袋|箱|枚|缶|玉|束|房|粒|足|着|台|冊|組|パック|ケース|セット))/gu, kanjiNumber);
}

function kanjiNumber(value: string): string {
  const digits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === "十") return "10";
  const parts = value.split("十");
  if (parts.length === 2) return String((parts[0] ? digits[parts[0]] ?? 1 : 1) * 10 + (digits[parts[1]] ?? 0));
  return value.length === 1 ? String(digits[value] ?? value) : value;
}

export function inferCategory(name: string): ParsedItem["category"] {
  if (/牛乳|卵|たまご|パン|米|ご飯|肉|魚|野菜|果物|りんご|リンゴ|バナナ|トマト|玉ねぎ|たまねぎ|にんじん|人参|じゃがいも|豆腐|納豆|ヨーグルト|チーズ|バター|水|お茶|茶葉|コーヒー|紅茶|ジュース|酒|ビール|味噌|みそ|醤油|しょうゆ|砂糖|塩|油|麺|パスタ|うどん|そば|菓子|おやつ|チョコ|冷凍|ハム|ソーセージ|キャベツ|レタス|きゅうり|豆乳/u.test(name)) return "食品";
  if (/洗剤|柔軟剤|トイレ|ティッシュ|シャンプー|リンス|コンディショナー|石鹸|せっけん|ソープ|歯ブラシ|歯磨き|スポンジ|ごみ袋|ゴミ袋|ラップ|アルミホイル|ペーパー|除菌|マスク|おむつ|電池|消臭|ハンドクリーム/u.test(name)) return "日用品";
  if (/服|シャツ|パンツ|靴|くつ|靴下|下着|ジャケット|コート|帽子|スカート|ワンピース|セーター/u.test(name)) return "衣類";
  if (/充電器|ケーブル|パソコン|イヤホン|スマホ|冷蔵庫|洗濯機|掃除機|レンジ|テレビ|モニタ|キーボード|マウス/u.test(name)) return "家電";
  return "その他";
}

function canonicalUnit(unit: string): string {
  const map: Record<string, string> = { グラム: "g", キログラム: "kg", ミリリットル: "mL", ml: "mL", リットル: "L", l: "L" };
  return map[unit] ?? unit;
}

export function parseShoppingText(text: string): ParsedItem[] {
  const normalized = normalize(text).trim();
  let sharedStore: string | undefined;
  const storePrefix = normalized.match(/^(スーパー|ドラッグストア|コンビニ|ホームセンター|コストコ|イオン|無印良品|Amazon|楽天)(?:で|：|:)\s*/iu);
  if (storePrefix) sharedStore = storePrefix[1];
  const list = storePrefix ? normalized.slice(storePrefix[0].length) : normalized;
  // Protect common product words containing the conjunction character before splitting a list.
  const protectedWords: string[] = [];
  const protectedList = list.replace(/さといも|はとむぎ|はと麦|おっとっと|しっとり|とろける|とろみ|とんがり|ところてん|とんかつ/gu, (word) => {
    protectedWords.push(word);
    return `\uE000${protectedWords.length - 1}\uE001`;
  });
  const parts = protectedList.replace(/(?:を)?(?:買って(?:きて|おいて)?|買う|購入して|追加して|追加|お願いします|お願い)(?:ください)?[。.!！]?\s*$/u, "")
    .split(/\r?\n|[、,，;；。]+|それから|あとは|あと(?=\s)|\s+and\s+|(?<=[^\sっ・、,\nと])と(?=[^と])/u);
  const result: ParsedItem[] = [];
  for (let part of parts) {
    part = part.replace(/\uE000([0-9]+)\uE001/gu, (_, index: string) => protectedWords[Number(index)] ?? "");
    part = part.replace(/^\s*(?:[-*・●]|それと|あと)\s*/u, "").trim();
    if (!part) continue;
    let store = sharedStore;
    const storeSuffix = part.match(/\s+[@＠]([^@＠]{1,60})$/u);
    if (storeSuffix) { store = storeSuffix[1].trim(); part = part.slice(0, storeSuffix.index).trim(); }
    let quantity = 1;
    let unit = "個";
    const suffix = part.match(suffixQuantity);
    const prefix = suffix ? null : part.match(prefixQuantity);
    const amount = suffix ?? prefix;
    if (amount) {
      quantity = Number(amount[1]); unit = canonicalUnit(amount[2]);
      part = suffix ? part.slice(0, suffix.index).trim() : part.slice(amount[0].length).trim();
    }
    const name = part.replace(/を$/u, "").trim().slice(0, 240);
    if (!name || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) continue;
    result.push({ name, quantity, unit, category: inferCategory(name), ...(store ? { store } : {}) });
    if (result.length >= 100) break;
  }
  return result;
}

export function validateParsedItems(value: unknown): ParsedItem[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) return null;
  const items: ParsedItem[] = [];
  const categories = new Set(["食品", "日用品", "衣類", "家電", "その他"]);
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return null;
    const item = candidate as Record<string, unknown>;
    if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 240
      || typeof item.quantity !== "number" || !Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 1_000_000
      || typeof item.unit !== "string" || !item.unit.trim() || item.unit.length > 20
      || typeof item.category !== "string" || !categories.has(item.category)
      || (item.store !== undefined && (typeof item.store !== "string" || item.store.length > 60))) return null;
    items.push({ name: item.name.trim(), quantity: item.quantity, unit: item.unit.trim(), category: item.category as ParsedItem["category"],
      ...(typeof item.store === "string" && item.store.trim() ? { store: item.store.trim() } : {}) });
  }
  return items;
}
