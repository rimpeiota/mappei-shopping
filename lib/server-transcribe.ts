import { Buffer } from "node:buffer";

export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const TRANSCRIPTION_MODEL = "@cf/openai/whisper-large-v3-turbo";
const READ_TIMEOUT_MS = 15_000;
const AI_TIMEOUT_MS = 30_000;
const MAX_TRANSCRIPT_CHARS = 10_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

export class TranscriptionError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type TranscriptionEnvironment = {
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_AI_TOKEN?: string;
};

type TranscriptionFetcher = (url: string, init: RequestInit) => Promise<Response>;

export function transcriptionConfigured(environment: TranscriptionEnvironment): boolean {
  return Boolean(environment.AI || (environment.CLOUDFLARE_ACCOUNT_ID && environment.CLOUDFLARE_AI_TOKEN));
}

export function audioContentType(value: string | null): string | null {
  const raw = value?.split(";", 1)[0].trim().toLowerCase() ?? "";
  const aliases: Record<string, string> = { "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav" };
  const type = aliases[raw] ?? raw;
  return ["audio/webm", "audio/mp4", "audio/wav", "audio/mpeg", "audio/ogg"].includes(type) ? type : null;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function little32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function mp3Frame(bytes: Uint8Array, offset: number): boolean {
  return offset + 4 <= bytes.length && bytes[offset] === 0xff && (bytes[offset + 1] & 0xe0) === 0xe0
    && ((bytes[offset + 1] >> 3) & 3) !== 1 && ((bytes[offset + 1] >> 1) & 3) === 1
    && (bytes[offset + 2] >> 4) !== 0 && (bytes[offset + 2] >> 4) !== 15
    && ((bytes[offset + 2] >> 2) & 3) !== 3;
}

export function validAudioHeader(bytes: Uint8Array, type: string): boolean {
  if (type === "audio/wav") {
    if (bytes.length < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") return false;
    let hasFormat = false;
    let position = 12;
    for (let chunks = 0; chunks < 512 && position + 8 <= bytes.length; chunks++) {
      const name = ascii(bytes, position, 4);
      const size = little32(bytes, position + 4);
      if (position + 8 + size > bytes.length) return false;
      if (name === "fmt ") {
        if (size < 16) return false;
        const view = new DataView(bytes.buffer, bytes.byteOffset + position + 8, size);
        const channels = view.getUint16(2, true);
        const sampleRate = view.getUint32(4, true);
        if (channels < 1 || channels > 8 || sampleRate < 8000 || sampleRate > 192000) return false;
        hasFormat = true;
      }
      if (name === "data") return hasFormat && size > 0;
      position += 8 + size + (size % 2);
    }
    return false;
  }
  if (type === "audio/mp4") {
    if (bytes.length < 16 || ascii(bytes, 4, 4) !== "ftyp") return false;
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (size < 16 || size > bytes.length) return false;
    const brands = new Set(["M4A ", "M4B ", "isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "qt  ", "dash", "cmfa", "cmfs"]);
    if (brands.has(ascii(bytes, 8, 4))) return true;
    for (let offset = 16; offset + 4 <= Math.min(size, 256); offset += 4) if (brands.has(ascii(bytes, offset, 4))) return true;
    return false;
  }
  if (type === "audio/webm") {
    return bytes.length >= 16 && [0x1a, 0x45, 0xdf, 0xa3].every((value, i) => bytes[i] === value)
      && ascii(bytes, 0, Math.min(bytes.length, 4096)).includes("webm");
  }
  if (type === "audio/ogg") {
    if (bytes.length < 28 || ascii(bytes, 0, 4) !== "OggS" || bytes[4] !== 0 || bytes[26] === 0) return false;
    const packetStart = 27 + bytes[26];
    if (packetStart + 8 > bytes.length) return false;
    return ["OpusHead", "\x01vorbis", "Speex   ", "\x7fFLAC"].some((header) => ascii(bytes, packetStart, header.length) === header);
  }
  if (type === "audio/mpeg") {
    let start = 0;
    if (ascii(bytes, 0, 3) === "ID3") {
      if (bytes.length < 10 || ![2, 3, 4].includes(bytes[3]) || bytes.subarray(6, 10).some((value) => value > 127)) return false;
      const size = (bytes[6] << 21) + (bytes[7] << 14) + (bytes[8] << 7) + bytes[9];
      start = 10 + size + (bytes[3] === 4 && (bytes[5] & 0x10) ? 10 : 0);
    }
    return mp3Frame(bytes, start);
  }
  return false;
}

export async function readAudioBody(request: Request, options: { maxBytes?: number; timeoutMs?: number } = {}): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? MAX_AUDIO_BYTES;
  if (Number(request.headers.get("content-length")) > maxBytes) throw new TranscriptionError(413, "音声は8MB以下で送信してください。");
  if (!request.body) throw new TranscriptionError(400, "録音データがありません。もう一度録音してください。");
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const read = async (): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new TranscriptionError(413, "音声は8MB以下で送信してください。"); }
      chunks.push(value);
    }
    if (!size) throw new TranscriptionError(400, "録音データがありません。もう一度録音してください。");
    const bytes = new Uint8Array(size);
    let position = 0;
    for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
    return bytes;
  };
  try {
    const cancelled = new Promise<never>((_, reject) => {
      const cancel = (status: number, message: string) => { void reader.cancel().catch(() => undefined); reject(new TranscriptionError(status, message)); };
      onAbort = () => cancel(408, "音声入力が中断されました。もう一度お試しください。");
      timer = setTimeout(() => cancel(408, "音声の送信に時間がかかっています。もう一度お試しください。"), options.timeoutMs ?? READ_TIMEOUT_MS);
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([read(), cancelled]);
  } catch (error) {
    if (error instanceof TranscriptionError) throw error;
    throw new TranscriptionError(400, "録音データを読み取れませんでした。もう一度録音してください。");
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) request.signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

// null means invalid provider output; an empty string means a valid, silent recording.
export function transcriptionText(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (typeof result.text !== "string" || result.text.length > MAX_TRANSCRIPT_CHARS || result.text.includes("\u0000")) return null;
  const info = result.transcription_info;
  if (info && typeof info === "object" && (info as Record<string, unknown>).duration_after_vad === 0) return "";
  return result.text.trim();
}

async function readProviderResult(response: Response): Promise<unknown> {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new TranscriptionError(502, "音声認識サービスに接続できませんでした。少し待ってお試しください。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = "";
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("Invalid result"); }
      content += decoder.decode(value, { stream: true });
    }
    const envelope: unknown = JSON.parse(content + decoder.decode());
    if (!envelope || typeof envelope !== "object" || !("result" in envelope)
      || ("success" in envelope && envelope.success === false)) throw new Error("Invalid result");
    return envelope.result;
  } finally { reader.releaseLock(); }
}

export async function transcribeAudio(bytes: Uint8Array, environment: TranscriptionEnvironment, options: {
  signal?: AbortSignal; fetcher?: TranscriptionFetcher; timeoutMs?: number;
} = {}): Promise<string> {
  if (!transcriptionConfigured(environment)) throw new TranscriptionError(503, "音声認識の接続を準備中です。文字入力をご利用ください。");
  if (bytes.byteLength > MAX_AUDIO_BYTES) throw new TranscriptionError(413, "音声は8MB以下で送信してください。");
  if (options.signal?.aborted) throw new TranscriptionError(408, "音声入力が中断されました。もう一度お試しください。");
  const input = { audio: Buffer.from(bytes).toString("base64"), language: "ja", task: "transcribe", vad_filter: true, condition_on_previous_text: false };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let timedOut = false;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => { controller.abort(); reject(new TranscriptionError(408, "音声入力が中断されました。もう一度お試しください。")); };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new TranscriptionError(504, "音声認識に時間がかかっています。短く録音してお試しください。")); }, options.timeoutMs ?? AI_TIMEOUT_MS);
    });
    const operation = environment.AI
      ? environment.AI.run(TRANSCRIPTION_MODEL, input)
      : (options.fetcher ?? fetch)(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(environment.CLOUDFLARE_ACCOUNT_ID!)}/ai/run/${TRANSCRIPTION_MODEL}`, {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${environment.CLOUDFLARE_AI_TOKEN}` },
        body: JSON.stringify(input),
      }).then(readProviderResult);
    const result = transcriptionText(await Promise.race([operation, cancelled]));
    if (result === null) throw new TranscriptionError(502, "音声認識の結果を読み取れませんでした。もう一度お試しください。");
    if (!result) throw new TranscriptionError(422, "音声が見つかりませんでした。マイクに近づいてもう一度お話しください。");
    return result;
  } catch (error) {
    if (error instanceof TranscriptionError) throw error;
    if (timedOut) throw new TranscriptionError(504, "音声認識に時間がかかっています。短く録音してお試しください。");
    if (options.signal?.aborted) throw new TranscriptionError(408, "音声入力が中断されました。もう一度お試しください。");
    throw new TranscriptionError(502, "音声認識サービスに接続できませんでした。少し待ってお試しください。");
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
  }
}
