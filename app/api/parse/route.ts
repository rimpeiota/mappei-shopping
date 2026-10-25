import { apiError, ApiError, json, readJson, requireOwner, requireSameOrigin } from "@/lib/server-http";
import { aiConfigured, extractShoppingItems } from "@/lib/server-ai";
import { parseShoppingText } from "@/lib/server-parser";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    requireOwner(request);
    requireSameOrigin(request);
    const body = await readJson(request, 40_000);
    if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 10_000) throw new ApiError(400, "1〜10,000文字で入力してください。");
    const text = body.text.trim();
    const items = await extractShoppingItems(text);
    if (items) return json({ items, engine: "workers-ai" });
    const localItems = parseShoppingText(text);
    if (localItems.length === 0) throw new ApiError(422, "商品名を読み取れませんでした。商品名と数量を確認してください。");
    return json({ items: localItems, engine: "local-parser", message: aiConfigured()
      ? "AIに接続できなかったため、通常の文字解析を使いました。内容を確認してください。"
      : "AI接続が未設定のため、通常の文字解析を使いました。" });
  } catch (error) { return apiError(error); }
}
