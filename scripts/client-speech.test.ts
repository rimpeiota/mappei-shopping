import assert from 'node:assert/strict';
import test from 'node:test';
import type { SpeechCallbacks, SpeechClock, SpeechPhase, SpeechRecognizer, SpeechResultEvent } from '../lib/client-speech';
const { prefersRecordedSpeech, startSpeechSession } = await import(new URL('../lib/client-speech.ts', import.meta.url).href) as typeof import('../lib/client-speech');

test('Chrome on iPhone/iPad selects recording while Safari, Android, and desktop keep browser recognition', () => {
  assert.equal(prefersRecordedSpeech('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/140.0.0.0 Mobile/15E148 Safari/604.1'), true);
  assert.equal(prefersRecordedSpeech('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/140.0.0.0 Mobile/15E148 Safari/604.1'), true);
  for (const userAgent of [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 15) Chrome/140.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/140.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) FxiOS/140.0 Mobile/15E148 Safari/605.1.15',
    '',
  ]) assert.equal(prefersRecordedSpeech(userAgent), false);
});

class FakeClock implements SpeechClock {
  now = 0;
  private nextId = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, delayMs: number) {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return id;
  }
  clearTimeout(handle: unknown) { this.timers.delete(handle as number); }
  get pending() { return this.timers.size; }
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = end;
  }
}
class FakeRecognizer implements SpeechRecognizer {
  lang = '';
  continuous = true;
  interimResults = false;
  onstart: SpeechRecognizer['onstart'] = null;
  onresult: SpeechRecognizer['onresult'] = null;
  onerror: SpeechRecognizer['onerror'] = null;
  onend: SpeechRecognizer['onend'] = null;
  starts = 0;
  stops = 0;
  aborts = 0;
  startError: unknown;
  stopError: unknown;
  onAbort: (() => void) | null = null;
  start() { this.starts += 1; if (this.startError) throw this.startError; }
  stop() { this.stops += 1; if (this.stopError) throw this.stopError; }
  abort() { this.aborts += 1; this.onAbort?.(); }
}
function result(entries: { text: string; final: boolean }[], resultIndex = 0): SpeechResultEvent {
  return { resultIndex, results: entries.map(entry => ({ 0: { transcript: entry.text }, isFinal: entry.final })) };
}
function harness(recognizer = new FakeRecognizer()) {
  const clock = new FakeClock();
  const phases: SpeechPhase[] = [], transcripts: string[] = [], interims: string[] = [], errors: string[] = [];
  const callbacks: SpeechCallbacks = { onPhase: phase => phases.push(phase), onTranscript: text => transcripts.push(text), onInterim: text => interims.push(text), onError: error => errors.push(error) };
  const session = startSpeechSession(recognizer, callbacks, { clock });
  return { recognizer, clock, session, callbacks, phases, transcripts, interims, errors };
}

test('start request remains starting until the recognizer actually starts', () => {
  const h = harness();
  assert.equal(h.recognizer.lang, 'ja-JP');
  assert.equal(h.recognizer.continuous, false);
  assert.equal(h.recognizer.interimResults, true);
  assert.equal(h.recognizer.starts, 1);
  assert.deepEqual(h.phases, ['starting']);
  h.clock.advance(14_999);
  assert.deepEqual(h.phases, ['starting']);
  h.recognizer.onstart?.();
  assert.deepEqual(h.phases, ['starting', 'listening']);
  assert.equal(h.clock.pending, 1);
  h.session.cancel();
});

test('interim text is replaceable while final indices are delivered exactly once', () => {
  const h = harness(); h.recognizer.onstart?.();
  h.recognizer.onresult?.(result([{ text: '牛', final: false }]));
  h.recognizer.onresult?.(result([{ text: '牛乳', final: false }]));
  assert.deepEqual(h.interims, ['牛', '牛乳']);
  h.recognizer.onresult?.(result([{ text: '牛乳', final: true }]));
  h.recognizer.onresult?.(result([{ text: '牛乳', final: true }]));
  h.recognizer.onresult?.(result([{ text: '牛乳', final: true }, { text: '卵', final: false }], 1));
  h.recognizer.onresult?.(result([{ text: '牛乳', final: true }, { text: '卵1パック', final: true }]));
  h.recognizer.onresult?.(result([{ text: '牛乳', final: true }, { text: '卵1パック', final: true }]));
  assert.deepEqual(h.transcripts, ['牛乳', '卵1パック']);
  assert.deepEqual(h.interims, ['牛', '牛乳', '', '卵', '']);
  h.recognizer.onend?.();
  assert.deepEqual(h.errors, []);
  assert.equal(h.phases.at(-1), 'idle');
  assert.equal(h.clock.pending, 0);
});

test('Stop keeps the final-result handler alive until onend', () => {
  const h = harness(); h.recognizer.onstart?.();
  h.recognizer.onresult?.(result([{ text: '洗剤', final: false }]));
  h.session.stop(); h.session.stop();
  assert.equal(h.recognizer.stops, 1);
  assert.equal(h.phases.at(-1), 'stopping');
  h.clock.advance(2_999);
  h.recognizer.onresult?.(result([{ text: '洗剤2袋', final: true }]));
  h.recognizer.onend?.();
  h.clock.advance(100_000);
  assert.deepEqual(h.transcripts, ['洗剤2袋']);
  assert.deepEqual(h.errors, []);
  assert.equal(h.recognizer.aborts, 0);
  assert.deepEqual(h.phases, ['starting', 'listening', 'stopping', 'idle']);
});

test('a permission prompt that never resolves times out without claiming to listen', () => {
  const h = harness();
  const lateStart = h.recognizer.onstart!, lateResult = h.recognizer.onresult!, lateEnd = h.recognizer.onend!, lateError = h.recognizer.onerror!;
  h.clock.advance(15_000);
  assert.deepEqual(h.phases, ['starting', 'idle']);
  assert.deepEqual(h.errors, ['start-timeout']);
  assert.equal(h.recognizer.aborts, 1);
  assert.equal(h.clock.pending, 0);
  lateStart(); lateResult(result([{ text: '遅延した認識', final: true }])); lateError({ error: 'not-allowed' }); lateEnd();
  assert.deepEqual(h.transcripts, []);
  assert.deepEqual(h.errors, ['start-timeout']);
});

test('Stop while permission is pending never re-enters listening on a late onstart', () => {
  const h = harness();
  h.session.stop();
  h.recognizer.onstart?.();
  assert.deepEqual(h.phases, ['starting', 'stopping']);
  assert.equal(h.recognizer.stops, 2);
  h.recognizer.onresult?.(result([{ text: '牛乳', final: true }]));
  h.recognizer.onend?.();
  assert.deepEqual(h.transcripts, ['牛乳']);
  assert.deepEqual(h.errors, []);
  assert.equal(h.clock.pending, 0);
});

test('Stop timeout aborts and leaves already-final text intact', () => {
  const h = harness(); h.recognizer.onstart?.();
  h.recognizer.onresult?.(result([{ text: '卵', final: true }]));
  h.session.stop();
  h.clock.advance(3_000);
  assert.deepEqual(h.errors, ['stop-timeout']);
  assert.deepEqual(h.transcripts, ['卵']);
  assert.equal(h.recognizer.aborts, 1);
  assert.equal(h.clock.pending, 0);
  assert.equal(h.recognizer.onresult, null);
});

test('Cancel clears interim text, aborts once, and neutralizes saved late callbacks', () => {
  const h = harness(); h.recognizer.onstart?.();
  h.recognizer.onresult?.(result([{ text: '牛乳', final: true }, { text: '未確定', final: false }]));
  const lateStart = h.recognizer.onstart!, lateResult = h.recognizer.onresult!, lateError = h.recognizer.onerror!, lateEnd = h.recognizer.onend!;
  h.recognizer.onAbort = () => { lateError({ error: 'aborted' }); lateEnd(); };
  h.session.cancel(); h.session.cancel(); h.session.stop();
  lateStart(); lateResult(result([{ text: '重複', final: true }, { text: '追加されない', final: true }])); lateError({ error: 'network' }); lateEnd();
  h.clock.advance(100_000);
  assert.deepEqual(h.transcripts, ['牛乳']);
  assert.deepEqual(h.interims, ['未確定', '']);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.phases, ['starting', 'listening', 'idle']);
  assert.equal(h.recognizer.aborts, 1);
  assert.equal(h.clock.pending, 0);
});

test('a replacement session on the same recognizer cannot receive stale session events', () => {
  const recognizer = new FakeRecognizer();
  const old = harness(recognizer);
  const lateStart = recognizer.onstart!, lateResult = recognizer.onresult!, lateError = recognizer.onerror!, lateEnd = recognizer.onend!;
  const current = harness(recognizer);
  assert.deepEqual(old.phases, ['starting', 'idle']);
  assert.equal(old.clock.pending, 0);
  lateStart(); lateResult(result([{ text: '古い入力', final: true }])); lateError({ error: 'network' }); lateEnd();
  recognizer.onstart?.(); recognizer.onresult?.(result([{ text: '現在の入力', final: true }])); recognizer.onend?.();
  old.clock.advance(100_000); current.clock.advance(100_000);
  assert.deepEqual(old.transcripts, []);
  assert.deepEqual(old.errors, []);
  assert.deepEqual(current.transcripts, ['現在の入力']);
  assert.deepEqual(current.errors, []);
});

test('an end with no final result reports no-speech, including interim-only recognition', () => {
  for (const text of ['', '未確定だけ']) {
    const h = harness(); h.recognizer.onstart?.();
    if (text) h.recognizer.onresult?.(result([{ text, final: false }]));
    h.recognizer.onend?.();
    assert.deepEqual(h.errors, ['no-speech']);
    assert.deepEqual(h.transcripts, []);
    assert.equal(h.clock.pending, 0);
    if (text) assert.deepEqual(h.interims, [text, '']);
  }
});

test('native error codes are preserved and subsequent end cannot add no-speech', () => {
  for (const code of ['not-allowed', 'service-not-allowed', 'network', 'no-speech', 'audio-capture', 'aborted', 'language-not-supported']) {
    const h = harness(); h.recognizer.onstart?.();
    const lateEnd = h.recognizer.onend!;
    h.recognizer.onerror?.({ error: code }); lateEnd();
    assert.deepEqual(h.errors, [code]);
    assert.equal(h.recognizer.aborts, 1);
    assert.equal(h.clock.pending, 0);
    assert.equal(h.phases.at(-1), 'idle');
  }
});

test('network failure does not erase text that was already finalized', () => {
  const h = harness(); h.recognizer.onstart?.();
  h.recognizer.onresult?.(result([{ text: '卵1パック', final: true }, { text: '牛', final: false }]));
  h.recognizer.onerror?.({ error: 'network' });
  assert.deepEqual(h.transcripts, ['卵1パック']);
  assert.deepEqual(h.interims, ['牛', '']);
  assert.deepEqual(h.errors, ['network']);
});

test('synchronous start exceptions are classified and cleaned up', () => {
  for (const [name, code] of [['NotAllowedError', 'not-allowed'], ['SecurityError', 'not-allowed'], ['InvalidStateError', 'invalid-state'], ['Error', 'start-failed']]) {
    const recognizer = new FakeRecognizer(); recognizer.startError = Object.assign(new Error('browser failure'), { name });
    const h = harness(recognizer);
    assert.deepEqual(h.errors, [code]);
    assert.deepEqual(h.phases, ['starting', 'idle']);
    assert.equal(h.clock.pending, 0);
    assert.equal(recognizer.onstart, null);
    assert.equal(recognizer.aborts, 1);
  }
});

test('watchdog measures actual listening time and ends a hung session after sixty seconds', () => {
  const h = harness(); h.clock.advance(14_000); h.recognizer.onstart?.();
  h.clock.advance(59_999);
  assert.deepEqual(h.errors, []);
  h.clock.advance(1);
  assert.deepEqual(h.errors, ['session-timeout']);
  assert.equal(h.recognizer.aborts, 1);
  assert.equal(h.clock.pending, 0);
});

test('a stop request near the watchdog limit still permits its final-result grace period', () => {
  const h = harness(); h.recognizer.onstart?.(); h.clock.advance(59_500); h.session.stop(); h.clock.advance(2_500);
  h.recognizer.onresult?.(result([{ text: '最後の入力', final: true }])); h.recognizer.onend?.();
  assert.deepEqual(h.errors, []); assert.deepEqual(h.transcripts, ['最後の入力']); assert.equal(h.clock.pending, 0);
});

test('cancelling synchronously from a phase callback cannot leave a timer behind', () => {
  for (const phase of ['listening', 'stopping'] as const) {
    const recognizer = new FakeRecognizer(), clock = new FakeClock();
    const session = startSpeechSession(recognizer, { onPhase: next => { if (next === phase) session.cancel(); }, onTranscript() {}, onInterim() {}, onError() {} }, { clock });
    recognizer.onstart?.();
    if (phase === 'stopping') session.stop();
    assert.equal(clock.pending, 0);
    assert.equal(recognizer.aborts, 1);
  }
});

test('a replacement started from the starting callback prevents the stale start call', () => {
  const recognizer = new FakeRecognizer(), clock = new FakeClock();
  let replacement: ReturnType<typeof startSpeechSession> | undefined;
  startSpeechSession(recognizer, {
    onPhase: phase => {
      if (phase === 'starting') replacement = startSpeechSession(recognizer, { onPhase() {}, onTranscript() {}, onInterim() {}, onError() {} }, { clock });
    },
    onTranscript() {}, onInterim() {}, onError() {},
  }, { clock });
  assert.equal(recognizer.starts, 1);
  assert.equal(clock.pending, 1);
  replacement!.cancel();
  assert.equal(clock.pending, 0);
});
