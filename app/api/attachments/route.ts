import { apiError, ApiError, boundedBody, json, requireOwner, requireSameOrigin } from "@/lib/server-http";
import { ALLOWED_CONTENT_TYPES, attachmentKey, bucket, cleanFileName, MAX_FILE_BYTES, verifyFileType } from "@/lib/server-attachments";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const owner = requireOwner(request);
    requireSameOrigin(request);
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) throw new ApiError(415, "ファイル形式を確認してください。");
    const bytes = await boundedBody(request, MAX_FILE_BYTES + 64 * 1024);
    let form: FormData;
    try { form = await new Response(bytes as BodyInit, { headers: { "Content-Type": contentType } }).formData(); }
    catch { throw new ApiError(400, "添付ファイルの形式を確認してください。"); }
    const file = form.get("file");
    if (!file || typeof file === "string") throw new ApiError(400, "ファイルを選んでください。");
    if (file.size < 1 || file.size > MAX_FILE_BYTES) throw new ApiError(413, "ファイルは10MBまでです。");
    if (!ALLOWED_CONTENT_TYPES.has(file.type)) throw new ApiError(415, "JPEG・PNG・WebP・GIF・PDF・テキストを添付できます。");
    const data = new Uint8Array(await file.arrayBuffer());
    if (!verifyFileType(data, file.type)) throw new ApiError(415, "ファイルの内容と種類が一致しません。");
    const id = crypto.randomUUID();
    const name = cleanFileName(file.name);
    await bucket().put(await attachmentKey(owner, id), data as ArrayBufferView, {
      httpMetadata: { contentType: file.type },
      customMetadata: { name: encodeURIComponent(name), uploadedAt: new Date().toISOString() },
    });
    return json({ id, url: `/api/attachments/${id}`, name, type: file.type }, 201);
  } catch (error) { return apiError(error); }
}
