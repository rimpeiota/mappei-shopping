import { env } from "cloudflare:workers";
import { ApiError, ownerHash } from "@/lib/server-http";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf", "text/plain"]);

export function bucket(): R2Bucket {
  if (!env.BUCKET) throw new ApiError(503, "添付ファイルのクラウド保存を準備中です。");
  return env.BUCKET;
}

export async function attachmentKey(owner: string, id: string): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) throw new ApiError(404, "添付ファイルが見つかりません。");
  return `users/${await ownerHash(owner)}/attachments/${id}`;
}

export function cleanFileName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f/\\]/gu, "_").trim().slice(0, 160) || "attachment";
}

export function verifyFileType(bytes: Uint8Array, type: string): boolean {
  if (type === "text/plain") return !bytes.subarray(0, 4096).some((byte) => byte === 0);
  if (type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/png") return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte);
  const prefix = new TextDecoder().decode(bytes.subarray(0, 12));
  if (type === "image/gif") return prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a");
  if (type === "image/webp") return prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP";
  if (type === "application/pdf") return prefix.startsWith("%PDF-");
  return false;
}
