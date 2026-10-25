export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export function apiError(error: unknown): Response {
  if (error instanceof ApiError) return json({ error: error.message }, error.status);
  return json({ error: "処理に失敗しました。少し待ってもう一度お試しください。" }, 500);
}

export function requireOwner(request: Request): string {
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner || owner.length > 256 || /[\u0000-\u001f\u007f]/u.test(owner)) throw new ApiError(401, "サインインしてください。");
  return owner;
}

export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) throw new ApiError(403, "同じアプリ画面から操作してください。");
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new ApiError(403, "同じアプリ画面から操作してください。");
}

export async function boundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) throw new ApiError(413, "データが大きすぎます。");
  if (!request.body) throw new ApiError(400, "入力がありません。");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ApiError(413, "データが大きすぎます。"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) { result.set(chunk, position); position += chunk.byteLength; }
  return result;
}

export async function readJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ApiError(415, "JSON形式で送信してください。");
  const bytes = await boundedBody(request, maxBytes);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new ApiError(400, "JSONの形式を確認してください。"); }
  if (!isRecord(value)) throw new ApiError(400, "入力の形式を確認してください。");
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function ownerHash(owner: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
