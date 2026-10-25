import { env } from "cloudflare:workers";
import { json } from "@/lib/server-http";
import { aiConfigured } from "@/lib/server-ai";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return json({ ok: true, storage: env.DB ? "d1" : "unavailable", attachments: Boolean(env.BUCKET), ai: aiConfigured() ? "configured" : "not-configured" });
}
