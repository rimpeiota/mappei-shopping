import { apiError, ApiError, json, readJson, requireOwner, requireSameOrigin } from "@/lib/server-http";
import { PreviewUrlError, resolveLinkPreview } from "@/lib/server-link-preview";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    requireOwner(request);
    requireSameOrigin(request);
    const body = await readJson(request, 16 * 1024);
    if (typeof body.url !== "string") throw new ApiError(400, "商品URLを入力してください。");
    return json(await resolveLinkPreview(body.url.trim()));
  } catch (error) {
    return error instanceof PreviewUrlError ? json({ error: error.message }, 400) : apiError(error);
  }
}
