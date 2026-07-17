import { useCallback, useEffect, useRef, useState } from 'react';
import { VOICE_ERROR_COPY, classifyMediaError, type VoiceErrorKind } from './errors';
import { nextTurnstileToken, withTurnstileHeader } from './turnstile-token';

// Records a short mic clip, transcribes it via /assistant/transcribe, and hands the text back to the
// composer (editable, not auto-sent). Every exit path — stop, error, unmount — tears down the mic
// tracks, the timers and any in-flight fetch, so nothing leaks and the OS mic indicator
// always clears. getUserMedia is triggered from start() (a click handler), never an effect, so React
// StrictMode's double-mount can't double-prompt for permission.

const ENDPOINT = '/assistant/transcribe';
const TRANSCRIBE_TIMEOUT_MS = 20_000; // a hung request must surface an error, not hang in a dead mic
const MAX_RECORDING_MS = 60_000; // hard cap — the server byte cap is the real bound; this bounds cost/UX.
const WARNING_LEAD_MS = 10_000; // flip endingSoon this long before the cap → the "10 seconds left" status
// Below this a clip is an accidental tap — the cheap first gate before we bother decoding audio.
// (Silence of any length is caught by hasSpeech() below; this just avoids decoding a sub-second blob.)
const MIN_RECORDING_MS = 700;
// Max 20ms-window RMS to count as speech (≈ -36.5 dBFS) — between measured room noise (≤ -41 dBFS) and
// soft speech (≈ -32 dBFS). Whisper invents text on silence; fail-open elsewhere protects soft speakers.
const SPEECH_RMS_THRESHOLD = 0.015;
const SILENCE_STOP_MS = 5_000; // auto-stop this long after speech ends → no long silent tail to hallucinate over
const SILENCE_MONITOR_MS = 250; // mic-level sampling cadence while recording
// Preferred containers, first supported wins; undefined → the browser's default container.
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

export type VoiceState =
  | { status: 'idle' }
  | { status: 'requesting' }
  | { status: 'recording' }
  | { status: 'transcribing' }
  | { status: 'error'; kind: VoiceErrorKind; message: string };

export interface VoiceInput {
  state: VoiceState;
  /** Recording start (ms epoch), or null when not recording — the mic ticks its own elapsed display from this. */
  startedAt: number | null;
  /** True in the final ~10s before the cap — drives the composer's "10 seconds left" status (coarse, not per-tick). */
  endingSoon: boolean;
  /** Start recording — MUST be called from a click handler (keeps getUserMedia out of an effect). */
  start: () => void;
  /** Stop recording and transcribe. */
  stop: () => void;
}

const isAbortError = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && 'name' in e && e.name === 'AbortError';

/** Read a Blob as a bare base64 string (strips the `data:…;base64,` prefix). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const s = typeof reader.result === 'string' ? reader.result : '';
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : '');
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Client-side VAD: decode the recorded clip and report whether it holds real speech energy (max 20ms-window
 * RMS ≥ threshold). Fails OPEN — if Web Audio is missing or decode throws, returns true so a user is never
 * blocked by failed analysis (accessibility). A headless one-shot at stop; the visualizer stays pure CSS.
 */
async function hasSpeech(blob: Blob): Promise<boolean> {
  const AudioCtx = typeof window !== 'undefined' ? window.AudioContext : undefined;
  if (!AudioCtx) return true;
  const ctx = new AudioCtx();
  try {
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    const data = audio.getChannelData(0);
    const win = Math.max(1, Math.floor(audio.sampleRate * 0.02)); // 20ms windows
    let maxRms = 0;
    for (let i = 0; i < data.length; i += win) {
      let sum = 0;
      let n = 0;
      for (let j = i; j < i + win && j < data.length; j++) {
        const v = data[j] ?? 0;
        sum += v * v;
        n++;
      }
      if (n > 0) maxRms = Math.max(maxRms, Math.sqrt(sum / n));
    }
    return maxRms >= SPEECH_RMS_THRESHOLD;
  } catch {
    return true; // unsupported codec / empty buffer → don't block the user
  } finally {
    void ctx.close().catch(() => {});
  }
}

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

export function useVoiceInput(onTranscript: (text: string) => void): VoiceInput {
  const [state, setState] = useState<VoiceState>({ status: 'idle' });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endingSoon, setEndingSoon] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const capTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startedAtRef = useRef(0);
  const mimeRef = useRef('audio/webm');
  const mountedRef = useRef(true);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const monitorRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSpeechAtRef = useRef(0); // 0 = no speech heard yet; else the ms of the last speech window

  // Stop the mic tracks and timers (but NOT the recorded chunks). Idempotent.
  const teardown = useCallback(() => {
    if (capTimerRef.current) clearTimeout(capTimerRef.current);
    if (warnTimerRef.current) clearTimeout(warnTimerRef.current);
    if (monitorRef.current) clearInterval(monitorRef.current);
    capTimerRef.current = null;
    warnTimerRef.current = null;
    monitorRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStartedAt(null);
    setEndingSoon(false);
  }, []);

  const fail = useCallback(
    (kind: VoiceErrorKind) => {
      teardown();
      chunksRef.current = [];
      setState({ status: 'error', kind, message: VOICE_ERROR_COPY[kind] });
    },
    [teardown],
  );

  const transcribe = useCallback(async () => {
    const chunks = chunksRef.current;
    chunksRef.current = [];
    if (chunks.length === 0 || Date.now() - startedAtRef.current < MIN_RECORDING_MS) {
      return fail('noSpeech');
    }
    setState({ status: 'transcribing' });
    const blob = new Blob(chunks, { type: mimeRef.current });
    if (!(await hasSpeech(blob))) return fail('noSpeech');
    let audio: string;
    try {
      audio = await blobToBase64(blob);
    } catch {
      return fail('capture');
    }
    const controller = new AbortController();
    abortRef.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TRANSCRIBE_TIMEOUT_MS);
    try {
      // Attach a fresh Turnstile token when the gate is active (mirrors the chat transport). Without it,
      // every voice request 403s once TURNSTILE_SECRET is provisioned for chat (shared env, one widget).
      const token = await nextTurnstileToken();
      const baseHeaders: HeadersInit = { 'Content-Type': 'application/json' };
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: token ? withTurnstileHeader(baseHeaders, token) : baseHeaders,
        body: JSON.stringify({ audio, mime: mimeRef.current }),
        signal: controller.signal,
      });
      if (!res.ok) return fail('transcription');
      const data = (await res.json()) as { text?: unknown };
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      if (text === '') return fail('noSpeech');
      onTranscript(text);
      setState({ status: 'idle' });
    } catch (err) {
      if (isAbortError(err) && !timedOut) return; // unmount abort — not an error to surface
      fail('transcription'); // timeout or network error
    } finally {
      clearTimeout(timeout);
      abortRef.current = null;
    }
  }, [fail, onTranscript]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop(); // → onstop → teardown + transcribe
  }, []);
  // The cap timeout (armed in start) needs the latest stop without re-arming — read it via a ref.
  const stopRef = useRef(stop);
  stopRef.current = stop;

  // Live silence detection: once speech has been heard, auto-stop after SILENCE_STOP_MS of quiet, so a
  // "spoke then walked away" clip has no long silent tail for Whisper to hallucinate over. Headless
  // AudioContext (visualizer stays CSS); fail-open — without Web Audio the 60s cap + post-hoc VAD still apply.
  const startSilenceMonitor = useCallback((stream: MediaStream) => {
    const AudioCtx = typeof window !== 'undefined' ? window.AudioContext : undefined;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    audioCtxRef.current = ctx;
    void ctx.resume().catch(() => {}); // autoplay policy can start it suspended → analyser would read silence
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);

    const buf = new Float32Array(analyser.fftSize);
    lastSpeechAtRef.current = 0; // reset: no speech heard yet this session

    monitorRef.current = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);

      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i] ?? 0;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);
      const now = Date.now();

      if (rms >= SPEECH_RMS_THRESHOLD) {
        lastSpeechAtRef.current = now;
      } else if (
        lastSpeechAtRef.current !== 0 &&
        now - lastSpeechAtRef.current >= SILENCE_STOP_MS
      ) {
        stopRef.current();
      }
    }, SILENCE_MONITOR_MS);
  }, []);

  const start = useCallback(() => {
    if (
      state.status === 'requesting' ||
      state.status === 'recording' ||
      state.status === 'transcribing'
    ) {
      return; // no overlapping sessions
    }
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return fail('unsupported');
    }
    setState({ status: 'requesting' });
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        // Unmounted while the permission prompt was open — stop this orphaned stream, or the mic stays live.
        if (!mountedRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const mime = pickMime();
        mimeRef.current = mime ?? 'audio/webm';
        const recorder = mime
          ? new MediaRecorder(stream, { mimeType: mime })
          : new MediaRecorder(stream);
        recorderRef.current = recorder;
        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          teardown(); // stop mic + timers; chunks survive for transcription
          void transcribe();
        };
        recorder.onerror = () => {
          recorder.onstop = null; // a stop after an error must not re-run transcribe (would clobber it)
          fail('capture');
        };
        recorder.start();
        startedAtRef.current = Date.now();
        setStartedAt(startedAtRef.current);
        setEndingSoon(false);
        setState({ status: 'recording' });
        warnTimerRef.current = setTimeout(
          () => setEndingSoon(true),
          MAX_RECORDING_MS - WARNING_LEAD_MS,
        );
        capTimerRef.current = setTimeout(() => stopRef.current(), MAX_RECORDING_MS);
        startSilenceMonitor(stream);
      })
      .catch((err) => {
        // Mirror the resolve path's mount guard: if getUserMedia rejects after unmount (permission
        // prompt dismissed post-unmount), don't run fail()/setState on a torn-down component.
        if (!mountedRef.current) return;
        fail(classifyMediaError(err));
      });
  }, [state.status, fail, transcribe, teardown, startSilenceMonitor]);

  // Cleanup on unmount — the ONLY effect (never starts capture, per the Rules of React).
  useEffect(() => {
    mountedRef.current = true; // reset on every (re)mount so StrictMode's mount→cleanup→mount is correct
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      teardown();
    };
  }, [teardown]);

  return { state, startedAt, endingSoon, start, stop };
}
