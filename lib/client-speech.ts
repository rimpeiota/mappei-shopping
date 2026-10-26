/** Browser-independent lifecycle management for one Web Speech recognition session. */
export type SpeechPhase = 'starting' | 'listening' | 'stopping' | 'idle';

export interface SpeechResultEvent {
  resultIndex: number;
  results: {
    readonly length: number;
    readonly [index: number]: {
      readonly isFinal: boolean;
      readonly [alternative: number]: { readonly transcript: string };
    };
  };
}

export interface SpeechRecognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface SpeechCallbacks {
  onPhase(phase: SpeechPhase): void;
  /** Only newly finalized result indices are emitted; previous final text is never re-emitted. */
  onTranscript(text: string): void;
  /** The current unfinished text, or an empty string when that text is cleared. */
  onInterim(text: string): void;
  /** Native error codes remain unchanged. Lifecycle timeouts use explicit *-timeout codes. */
  onError(code: string): void;
}

export interface SpeechSession {
  /** Request a final result, allowing up to three seconds for the browser to finish. */
  stop(): void;
  /** Discard unfinished recognition and suppress every later event from this session. */
  cancel(): void;
}

export interface SpeechClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SpeechSessionOptions {
  /** Optional deterministic timer source for tests; the browser uses its normal timers. */
  clock?: SpeechClock;
}

const browserClock: SpeechClock = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};
const sessions = new WeakMap<SpeechRecognizer, SpeechSession>();

function synchronousErrorCode(error: unknown, fallback: string): string {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'not-allowed';
  if (name === 'InvalidStateError') return 'invalid-state';
  return fallback;
}

/**
 * Does not request a microphone or choose a browser implementation itself.
 * `starting` means start was requested; only the recognizer's onstart means listening.
 * After a terminal error/end/cancel, saved references to old handlers are inert too.
 */
export function startSpeechSession(
  recognizer: SpeechRecognizer,
  callbacks: SpeechCallbacks,
  options: SpeechSessionOptions = {},
): SpeechSession {
  sessions.get(recognizer)?.cancel();
  const clock = options.clock ?? browserClock;
  let active = true;
  let phase: SpeechPhase = 'starting';
  let interim = '';
  let hasFinalText = false;
  const finalIndices = new Set<number>();
  let startTimer: unknown = null;
  let stopTimer: unknown = null;
  let watchdog: unknown = null;

  const clearTimers = () => {
    if (startTimer !== null) clock.clearTimeout(startTimer);
    if (stopTimer !== null) clock.clearTimeout(stopTimer);
    if (watchdog !== null) clock.clearTimeout(watchdog);
    startTimer = stopTimer = watchdog = null;
  };
  const setInterim = (text: string) => {
    if (text === interim) return;
    interim = text;
    callbacks.onInterim(text);
  };
  const setPhase = (next: SpeechPhase) => {
    if (phase === next) return;
    phase = next;
    callbacks.onPhase(next);
  };
  const finish = (error?: string, abort = false) => {
    if (!active) return;
    active = false;
    clearTimers();
    // Detach before abort: some implementations emit error/end synchronously from abort().
    if (recognizer.onstart === handleStart) recognizer.onstart = null;
    if (recognizer.onresult === handleResult) recognizer.onresult = null;
    if (recognizer.onerror === handleError) recognizer.onerror = null;
    if (recognizer.onend === handleEnd) recognizer.onend = null;
    if (sessions.get(recognizer) === session) sessions.delete(recognizer);
    if (abort) { try { recognizer.abort(); } catch { /* Cleanup must remain complete even if abort throws. */ } }
    setInterim('');
    if (error) callbacks.onError(error);
    setPhase('idle');
  };
  const handleStart = () => {
    if (!active) return;
    if (startTimer !== null) clock.clearTimeout(startTimer);
    startTimer = null;
    // A permission prompt may finish after the user has already pressed Stop.
    if (phase === 'stopping') {
      try { recognizer.stop(); } catch (error) { finish(synchronousErrorCode(error, 'stop-failed'), true); }
      return;
    }
    if (phase === 'listening') return;
    setPhase('listening');
    if (!active) return;
    watchdog = clock.setTimeout(() => finish('session-timeout', true), 60_000);
  };
  const handleResult = (event: SpeechResultEvent) => {
    if (!active) return;
    const length = event.results.length;
    const changedFrom = Number.isFinite(event.resultIndex) ? Math.max(0, Math.floor(event.resultIndex)) : 0;
    for (let index = changedFrom; index < length; index += 1) {
      const result = event.results[index];
      if (!result?.isFinal || finalIndices.has(index)) continue;
      const text = result[0]?.transcript?.trim();
      if (!text) continue;
      finalIndices.add(index);
      hasFinalText = true;
      callbacks.onTranscript(text);
      if (!active) return;
    }
    const unfinished: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const result = event.results[index];
      if (!result || result.isFinal || finalIndices.has(index)) continue;
      const text = result[0]?.transcript?.trim();
      if (text) unfinished.push(text);
    }
    setInterim(unfinished.join(' '));
  };
  const handleError = (event: { error: string }) => {
    if (!active) return;
    finish(event.error, true);
  };
  const handleEnd = () => {
    if (!active) return;
    finish(hasFinalText ? undefined : 'no-speech');
  };
  const session: SpeechSession = {
    stop() {
      if (!active || phase === 'stopping') return;
      if (startTimer !== null) clock.clearTimeout(startTimer);
      if (watchdog !== null) clock.clearTimeout(watchdog);
      startTimer = watchdog = null;
      setPhase('stopping');
      if (!active) return;
      stopTimer = clock.setTimeout(() => finish('stop-timeout', true), 3_000);
      try { recognizer.stop(); } catch (error) { finish(synchronousErrorCode(error, 'stop-failed'), true); }
    },
    cancel() { finish(undefined, true); },
  };

  recognizer.lang = 'ja-JP';
  recognizer.continuous = false;
  recognizer.interimResults = true;
  recognizer.onstart = handleStart;
  recognizer.onresult = handleResult;
  recognizer.onerror = handleError;
  recognizer.onend = handleEnd;
  sessions.set(recognizer, session);
  callbacks.onPhase('starting');
  if (!active) return session;
  startTimer = clock.setTimeout(() => finish('start-timeout', true), 15_000);
  try { recognizer.start(); } catch (error) { finish(synchronousErrorCode(error, 'start-failed'), true); }
  return session;
}
