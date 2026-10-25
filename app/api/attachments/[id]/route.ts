import { apiError, ApiError, requireOwner } from "@/lib/server-http";
import { ALLOWED_CONTENT_TYPES, attachmentKey, bucket, cleanFileName } from "@/lib/server-attachments";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const owner = requireOwner(request);
    const { id } = await context.params;
    const object = await bucket().get(await attachmentKey(owner, id));
    if (!object) throw new ApiError(404, "添付ファイルが見つかりません。");
    const type = object.httpMetadata?.contentType ?? "application/octet-stream";
    let name = "attachment";
    try { name = cleanFileName(decodeURIComponent(object.customMetadata?.name ?? name)); } catch { /* safe fallback */ }
    const headers = new Headers({
      "Content-Type": ALLOWED_CONTENT_TYPES.has(type) ? type : "application/octet-stream",
      "Content-Disposition": `${type.startsWith("image/") ? "inline" : "attachment"}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Content-Length": String(object.size), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    return new Response(object.body as ReadableStream, { headers });
  } catch (error) { return apiError(error); }
}
