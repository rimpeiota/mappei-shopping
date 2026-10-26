import assert from "node:assert/strict";
import test from "node:test";
const { audioContentType, validAudioHeader, readAudioBody, transcriptionText, transcribeAudio, TranscriptionError, TRANSCRIPTION_MODEL } =
  await import(new URL("../lib/server-transcribe.ts", import.meta.url).href) as typeof import("../lib/server-transcribe");

const request = (body: BodyInit | null, headers: HeadersInit = {}, signal?: AbortSignal) => new Request("https://app.invalid/api/transcribe", { method: "POST", body, headers, signal, duplex: "half" } as RequestInit);

function wav(): Uint8Array {
  const bytes = new Uint8Array(46);
  bytes.set(new TextEncoder().encode("RIFF"), 0); bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 38, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36); view.setUint32(40, 2, true);
  return bytes;
}

test("recording MIME parameters normalize and unsupported MIME is rejected", () => {
  assert.equal(audioContentType("Audio/WebM;codecs=opus"), "audio/webm");
  assert.equal(audioContentType("audio/mp4;codecs=mp4a.40.2"), "audio/mp4");
  for (const value of ["audio/x-m4a", "audio/m4a"]) assert.equal(audioContentType(value), "audio/mp4");
  for (const value of ["audio/x-wav", "audio/wave"]) assert.equal(audioContentType(value), "audio/wav");
  for (const value of [null, "text/html", "application/octet-stream", "video/mp4"]) assert.equal(audioContentType(value), null);
});

test("WAV requires format/data chunks and rejects truncated or mismatched headers", () => {
  assert.equal(validAudioHeader(wav(), "audio/wav"), true);
  assert.equal(validAudioHeader(wav().subarray(0, 44), "audio/wav"), false);
  const bad = wav(); bad[22] = 0;
  assert.equal(validAudioHeader(bad, "audio/wav"), false);
  assert.equal(validAudioHeader(wav(), "audio/mp4"), false);
});

test("MP4, WebM, Ogg Opus and MP3 require their actual container headers", () => {
  const mp4 = new Uint8Array(24); mp4[3] = 24; mp4.set(new TextEncoder().encode("ftypM4A "), 4);
  const webm = new Uint8Array(24); webm.set([0x1a, 0x45, 0xdf, 0xa3]); webm.set(new TextEncoder().encode("webm"), 10);
  const ogg = new Uint8Array(48); ogg.set(new TextEncoder().encode("OggS")); ogg[26] = 1; ogg[27] = 20; ogg.set(new TextEncoder().encode("OpusHead"), 28);
  const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]);
  const tagged = new Uint8Array(18); tagged.set([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]); tagged.set(mp3, 10);
  for (const [bytes, type] of [[mp4, "audio/mp4"], [webm, "audio/webm"], [ogg, "audio/ogg"], [mp3, "audio/mpeg"], [tagged, "audio/mpeg"]] as const) {
    assert.equal(validAudioHeader(bytes, type), true, type);
    const damaged = bytes.slice(); damaged[0] = 0;
    if (type === "audio/mp4") damaged[4] = 0;
    assert.equal(validAudioHeader(damaged, type), false, type);
  }
  assert.equal(validAudioHeader(new TextEncoder().encode("ID3not-an-audio-file"), "audio/mpeg"), false);
});

test("the bounded reader combines chunks and stops streaming bodies over its actual limit", async () => {
  const data = await readAudioBody(request(new Uint8Array([1, 2, 3])), { maxBytes: 3 });
  assert.deepEqual([...data], [1, 2, 3]);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(4)); }, cancel() { cancelled = true; } });
  await assert.rejects(readAudioBody(request(stream as BodyInit), { maxBytes: 6 }), (error: unknown) => error instanceof TranscriptionError && error.status === 413);
  assert.equal(cancelled, true);
  await assert.rejects(readAudioBody(request("x", { "content-length": "20" }), { maxBytes: 6 }), (error: unknown) => error instanceof TranscriptionError && error.status === 413);
});

test("the reader rejects empty, cancelled, and stalled uploads", async () => {
  await assert.rejects(readAudioBody(request(new Uint8Array())), (error: unknown) => error instanceof TranscriptionError && error.status === 400);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(readAudioBody(request("audio", {}, cancelled.signal)), (error: unknown) => error instanceof TranscriptionError && error.status === 408);
  const stream = new ReadableStream<Uint8Array>({ start() { /* intentionally stalled */ } });
  await assert.rejects(readAudioBody(request(stream as BodyInit), { timeoutMs: 5 }), (error: unknown) => error instanceof TranscriptionError && error.status === 408);
});

test("transcription response validation distinguishes invalid data and no speech", () => {
  assert.equal(transcriptionText({ text: " 牛乳2本、卵1パック " }), "牛乳2本、卵1パック");
  assert.equal(transcriptionText({ text: "  " }), "");
  assert.equal(transcriptionText({ text: "hallucination", transcription_info: { duration_after_vad: 0 } }), "");
  for (const value of [null, [], { text: 3 }, {}, { text: "\0" }, { text: "x".repeat(10001) }]) assert.equal(transcriptionText(value), null);
});

test("the existing Workers AI binding receives base64 audio with Japanese transcription options", async () => {
  const result = await transcribeAudio(new Uint8Array([1, 2, 3]), { AI: { async run(model, input) {
    assert.equal(model, TRANSCRIPTION_MODEL); assert.equal(input.audio, "AQID"); assert.equal(input.language, "ja");
    assert.equal(input.task, "transcribe"); assert.equal(input.vad_filter, true);
    return { text: "牛乳2本" };
  } } });
  assert.equal(result, "牛乳2本");
});

test("REST uses only existing server credentials and validates the envelope", async () => {
  const result = await transcribeAudio(new Uint8Array([1]), { CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_AI_TOKEN: "test-token" }, {
    fetcher: async (url, init) => {
      assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/${TRANSCRIPTION_MODEL}`);
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-token");
      return Response.json({ success: true, result: { text: "卵1パック" } });
    },
  });
  assert.equal(result, "卵1パック");
});

test("unconfigured, silent, invalid, and provider errors are fixed Japanese errors", async () => {
  await assert.rejects(transcribeAudio(new Uint8Array([1]), {}), (error: unknown) => error instanceof TranscriptionError && error.status === 503);
  for (const [value, status] of [[{ text: "" }, 422], [{ missing: "text" }, 502]] as const) {
    await assert.rejects(transcribeAudio(new Uint8Array([1]), { AI: { async run() { return value; } } }), (error: unknown) => error instanceof TranscriptionError && error.status === status);
  }
  await assert.rejects(transcribeAudio(new Uint8Array([1]), { CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_AI_TOKEN: "test-token" }, {
    fetcher: async () => new Response("provider-private-details", { status: 403 }),
  }), (error: unknown) => error instanceof TranscriptionError && error.status === 502 && !error.message.includes("provider-private-details"));
});

test("a stalled upstream times out and an aborted request cancels upstream", async () => {
  await assert.rejects(transcribeAudio(new Uint8Array([1]), { AI: { run: () => new Promise(() => undefined) } }, { timeoutMs: 5 }),
    (error: unknown) => error instanceof TranscriptionError && error.status === 504);
  const controller = new AbortController();
  const operation = transcribeAudio(new Uint8Array([1]), { CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_AI_TOKEN: "test-token" }, {
    signal: controller.signal,
    fetcher: async (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })),
  });
  controller.abort();
  await assert.rejects(operation, (error: unknown) => error instanceof TranscriptionError && error.status === 408);
});
