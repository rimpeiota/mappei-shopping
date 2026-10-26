'use client';
import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { Mic, MicOff, Plus, Sparkles, X } from 'lucide-react';
import { startSpeechSession, type SpeechRecognizer } from '@/lib/client-speech';

type VoicePhase = 'idle' | 'starting' | 'listening' | 'stopping' | 'permission' | 'recording' | 'transcribing';
const MAX_AUDIO = 8 * 1024 * 1024;
const errorMessages: Record<string, string> = {
  unsupported: 'このブラウザでは直接の音声認識を使えません。下の「録音して文字にする」か、キーボードのマイクを使ってください。',
  'not-allowed': 'マイクの利用が許可されていません。ブラウザのサイト設定でマイクを許可してから、もう一度お試しください。',
  'service-not-allowed': 'ブラウザの音声認識サービスを利用できません。「録音して文字にする」をお試しください。SafariではSiri・音声入力の設定も確認してください。',
  network: 'ブラウザの音声認識サービスに接続できません。「録音して文字にする」か、キーボードのマイクをお試しください。',
  'audio-capture': 'マイクを使えません。ほかのアプリでのマイク使用と、端末・ブラウザのマイク設定を確認してください。',
  'no-speech': '音声を聞き取れませんでした。マイクの近くで話して、もう一度お試しください。',
  'language-not-supported': 'このブラウザでは日本語の音声認識を利用できません。「録音して文字にする」をお試しください。',
  'start-timeout': 'マイクの許可待ちか、音声認識を開始できない状態です。許可画面・サイト設定を確認するか、下の録音をお試しください。',
};
const captions: Record<VoicePhase, string> = {
  idle: '入力は端末に即時保存', starting: 'マイクの許可・音声認識の開始を待っています',
  listening: '聞き取り中 · 終わったらマイクを押す', stopping: '聞き取りを終了しています…',
  permission: '録音用マイクの許可を待っています', recording: '録音中 · 終了ボタンで文字にします（最大45秒）',
  transcribing: '音声を文字にしています…',
};

export function QuickComposer({ value, onChange, onSubmit, inputRef, aiPending, authenticated, scope }: {
  value: string; onChange: Dispatch<SetStateAction<string>>; onSubmit: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>; aiPending: number; authenticated: boolean; scope: string;
}) {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [error, setError] = useState('');
  const [interim, setInterim] = useState('');
  const [help, setHelp] = useState(false);
  const [retryAudio, setRetryAudio] = useState<Blob | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const session = useRef<ReturnType<typeof startSpeechSession> | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentScope = useRef(scope);
  useEffect(() => { currentScope.current = scope; }, [scope]);

  const releaseMicrophone = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
  };
  const cancel = () => {
    generation.current += 1;
    session.current?.cancel(); session.current = null;
    request.current?.abort(); request.current = null;
    const recording = recorder.current; recorder.current = null;
    if (recording && recording.state !== 'inactive') recording.stop();
    releaseMicrophone();
    setPhase('idle'); setInterim('');
  };
  // Audio stays in memory only. Switching accounts or leaving the page cancels all work.
  useEffect(() => {
    const hide = () => { if (document.hidden) cancel(); };
    document.addEventListener('visibilitychange', hide);
    return () => {
      generation.current += 1;
      session.current?.cancel(); request.current?.abort();
      if (recorder.current?.state === 'recording') recorder.current.stop();
      releaseMicrophone();
      document.removeEventListener('visibilitychange', hide);
    };
    // The session belongs to this account's composer; callbacks also check its scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const fail = (message: string) => { setError(message); setHelp(true); setPhase('idle'); setInterim(''); };
  const append = (text: string) => {
    const words = text.trim(); if (!words) return;
    onChange(old => `${old}${old.trim() ? '、' : ''}${words}`.slice(0, 4000));
  };
  const startBrowser = () => {
    cancel(); setError(''); setRetryAudio(null);
    const browser = window as unknown as { SpeechRecognition?: new () => SpeechRecognizer; webkitSpeechRecognition?: new () => SpeechRecognizer };
    const Constructor = browser.SpeechRecognition || browser.webkitSpeechRecognition;
    if (!Constructor) { fail(errorMessages.unsupported); inputRef.current?.focus(); return; }
    const id = generation.current, owner = scope;
    const valid = () => generation.current === id && currentScope.current === owner;
    try {
      session.current = startSpeechSession(new Constructor(), {
        onPhase: next => { if (valid()) setPhase(next); },
        onInterim: text => { if (valid()) setInterim(text); },
        onTranscript: text => { if (valid()) { append(text); setError(''); } },
        onError: code => { if (valid()) fail(errorMessages[code] || '音声入力を開始できませんでした。もう一度試すか、下の録音を使ってください。'); },
      });
    } catch { fail('音声入力を開始できませんでした。下の録音か、キーボードのマイクをお試しください。'); }
  };
  const transcribe = async (audio: Blob) => {
    if (!authenticated) { fail('録音の文字起こしにはサインインが必要です。キーボードのマイクからも入力できます。'); return; }
    if (!navigator.onLine) { fail('文字起こしには通信が必要です。接続後に再試行できます。'); setRetryAudio(audio); return; }
    if (!audio.size || audio.size > MAX_AUDIO) { fail('音声は8MB以下で、短く録音してください。'); return; }
    const id = ++generation.current, owner = scope;
    const controller = new AbortController(); request.current = controller;
    setRetryAudio(audio); setPhase('transcribing'); setError('');
    const timeout = setTimeout(() => controller.abort(), 40_000);
    let message = '音声を送信できませんでした。通信を確認して再試行してください。';
    try {
      const response = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': audio.type || 'application/octet-stream' }, body: audio, signal: controller.signal });
      let result: { text?: string; error?: string };
      try { result = await response.json() as { text?: string; error?: string }; }
      catch { message = '音声認識の応答を確認できませんでした。少し待って再試行してください。'; throw new Error('Invalid response'); }
      if (generation.current !== id || currentScope.current !== owner) return;
      if (!response.ok || typeof result.text !== 'string' || !result.text.trim()) { message = result.error || '音声を文字にできませんでした。もう一度お試しください。'; throw new Error('Transcription unavailable'); }
      append(result.text); setRetryAudio(null); setPhase('idle'); setHelp(false); inputRef.current?.focus();
    } catch {
      if (generation.current !== id || currentScope.current !== owner) return;
      fail(controller.signal.aborted ? '文字起こしが時間内に終わりませんでした。短い音声で再試行してください。' : message);
    } finally { clearTimeout(timeout); if (request.current === controller) request.current = null; }
  };
  const startRecording = async () => {
    cancel(); setError(''); setRetryAudio(null); setHelp(true);
    if (!authenticated) { fail('録音の文字起こしにはサインインが必要です。キーボードのマイクからも入力できます。'); return; }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { fail('このブラウザでは録音できません。SafariやChromeで直接開くか、キーボードのマイクを使ってください。'); return; }
    const id = generation.current, owner = scope;
    const valid = () => generation.current === id && currentScope.current === owner;
    setPhase('permission');
    timer.current = setTimeout(() => { if (valid()) { generation.current += 1; fail('録音のマイク許可を確認してください。許可後に「録音して文字にする」をもう一度押してください。'); } }, 20_000);
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!valid()) { audioStream.getTracks().forEach(track => track.stop()); return; }
      if (timer.current) clearTimeout(timer.current);
      stream.current = audioStream;
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      const recording = new MediaRecorder(audioStream, mime ? { mimeType: mime } : undefined);
      recorder.current = recording;
      const chunks: Blob[] = []; let bytes = 0;
      recording.ondataavailable = event => {
        if (!valid() || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > MAX_AUDIO) { cancel(); fail('録音が8MBを超えました。短く録音し直してください。'); return; }
        chunks.push(event.data);
      };
      recording.onerror = () => { if (valid()) { cancel(); fail('録音を続けられませんでした。マイクを確認してもう一度お試しください。'); } };
      recording.onstop = () => {
        if (!valid()) return;
        releaseMicrophone(); recorder.current = null;
        void transcribe(new Blob(chunks, { type: recording.mimeType || chunks[0]?.type || mime || '' }));
      };
      recording.start(1000); setPhase('recording');
      timer.current = setTimeout(() => { if (valid() && recording.state === 'recording') { recording.stop(); releaseMicrophone(); } }, 45_000);
    } catch (failure) {
      if (!valid()) return;
      releaseMicrophone();
      const name = failure instanceof Error ? failure.name : '';
      fail(name === 'NotAllowedError' || name === 'SecurityError' ? errorMessages['not-allowed'] : errorMessages['audio-capture']);
    }
  };
  const active = phase !== 'idle';
  const buttonLabel = phase === 'recording' ? '録音を終了して文字にする' : phase === 'starting' || phase === 'permission' ? '音声入力をキャンセル' : phase === 'transcribing' ? '文字起こし中' : active ? '音声入力を停止' : '音声入力';
  return <div className="composer-dock">
    <form className={`composer glass ${active ? 'listening' : ''}`} onSubmit={event => { event.preventDefault(); onSubmit(); }}>
      <textarea ref={inputRef} aria-label="買うものを入力" placeholder={phase === 'listening' ? '聞き取り中…' : '買うもの・URL'} value={value} rows={1} maxLength={4000} onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onSubmit(); } }} />
      <div className="composer-actions">
        {aiPending > 0 && <span aria-label="AI補完中" className="ai-working"><Sparkles size={14} /></span>}
        <button className={`icon-button voice-button ${active ? 'active' : ''}`} type="button" aria-label={buttonLabel} aria-pressed={active} disabled={phase === 'transcribing' || phase === 'stopping'} onClick={() => {
          if (phase === 'recording') { recorder.current?.stop(); releaseMicrophone(); }
          else if (phase === 'starting' || phase === 'permission') cancel();
          else if (phase === 'listening') session.current?.stop();
          else startBrowser();
        }}>{active ? <MicOff size={19} /> : <Mic size={19} />}</button>
        <button type="submit" className="add-button" disabled={!value.trim()} aria-label="リストに追加"><Plus size={18} /><span>追加</span></button>
      </div>
    </form>
    <div className="composer-caption" role="status"><span>{captions[phase]}</span>{aiPending > 0 && <span> · AI補完中</span>}</div>
    {interim && <p className="voice-interim" aria-live="polite">{interim}</p>}
    {help && <section className="voice-help" aria-label="音声入力の案内">
      <div className="voice-help-heading"><strong>音声入力</strong><button type="button" className="icon-button" aria-label="音声入力の案内を閉じる" onClick={() => { cancel(); setHelp(false); setError(''); setRetryAudio(null); }}><X size={18} /></button></div>
      {error && <p role="alert">{error}</p>}
      <p className="field-note">録音と音声ファイルはCloudflareへ送って文字にします。このアプリには音声を保存しません。</p>
      <div className="voice-help-actions">
        {phase === 'recording' ? <button type="button" className="button primary" onClick={() => { recorder.current?.stop(); releaseMicrophone(); }}>録音を終了して文字にする</button> : <button type="button" className="button secondary" disabled={active} onClick={() => void startRecording()}>録音して文字にする</button>}
        <button type="button" className="button secondary" disabled={active} onClick={() => fileRef.current?.click()}>音声ファイルから入力</button>
        {retryAudio && phase === 'idle' && <button type="button" className="button secondary" onClick={() => void transcribe(retryAudio)}>文字起こしを再試行</button>}
        {active && <button type="button" className="text-button" onClick={cancel}>キャンセル</button>}
        <button type="button" className="text-button" disabled={active} onClick={startBrowser}>ブラウザの音声認識を再試行</button>
        <button type="button" className="text-button" onClick={() => { cancel(); inputRef.current?.focus(); }}>キーボードで入力</button>
      </div>
      <details><summary>マイク設定の確認方法</summary><p>サイト設定の「マイク」を許可してください。iPhoneではSafariやChromeでアプリのURLを直接開いて試してください。Safariの音声認識にはSiri・音声入力の設定も関係します。端末のキーボードにあるマイクからも入力できます。</p></details>
    </section>}
    <input ref={fileRef} type="file" className="hidden-file" aria-label="文字起こし用の音声ファイル" accept="audio/webm,audio/mp4,audio/m4a,audio/x-m4a,audio/wav,audio/x-wav,audio/mpeg,audio/ogg,.m4a,.wav,.webm,.mp3,.ogg" onChange={event => { const audio = event.target.files?.[0]; if (audio) { cancel(); setHelp(true); void transcribe(audio); } event.target.value = ''; }} />
  </div>;
}
