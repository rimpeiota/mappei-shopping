import { env } from "cloudflare:workers";
import { apiError, json, requireOwner, requireSameOrigin } from "@/lib/server-http";
import { audioContentType, readAudioBody, transcribeAudio, TranscriptionError, validAudioHeader } from "@/lib/server-transcribe";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    requireOwner(request);
    requireSameOrigin(request);
    const type = audioContentType(request.headers.get("content-type"));
    if (!type) throw new TranscriptionError(415, "この録音形式には対応していません。別のブラウザでお試しください。");
    const bytes = await readAudioBody(request);
    if (!validAudioHeader(bytes, type)) throw new TranscriptionError(415, "録音データの形式を確認できませんでした。もう一度録音してください。");
    const text = await transcribeAudio(bytes, env, { signal: request.signal });
    return json({ text, engine: "workers-ai" });
  } catch (error) {
    return error instanceof TranscriptionError ? json({ error: error.message }, error.status) : apiError(error);
  }
}
