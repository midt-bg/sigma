import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useVoiceInput } from './useVoiceInput';

// jsdom has no MediaRecorder / getUserMedia — we stub both. The real record→encode→upload round-trip
// (codecs, permission prompts, cross-browser) is inherently a manual/E2E check, called out in the plan.

class FakeMediaRecorder {
  static isTypeSupported = () => true;
  static last: FakeMediaRecorder | null = null;
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeMediaRecorder.last = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

const setGetUserMedia = (impl: unknown) =>
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: impl },
  });

const fakeStream = () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream;

// jsdom has no Web Audio. Stub AudioContext for both paths: post-hoc decode (VAD) reports `amplitude`;
// the live analyser (auto-stop monitor) reports `liveLevel`, which the auto-stop test mutates over time.
let liveLevel = 0;
const stubAudioContext = (amplitude: number) => {
  const data = new Float32Array(16000).fill(amplitude);
  class FakeAudioContext {
    decodeAudioData = async () => ({ sampleRate: 16000, getChannelData: () => data });
    createAnalyser = () => ({
      fftSize: 512,
      getFloatTimeDomainData: (b: Float32Array) => b.fill(liveLevel),
    });
    createMediaStreamSource = () => ({ connect: () => {} });
    resume = async () => {};
    close = async () => {};
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
};

afterEach(() => {
  liveLevel = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
});

describe('useVoiceInput', () => {
  it('surfaces an "unsupported" error (never a crash) when MediaRecorder is missing', () => {
    vi.stubGlobal('MediaRecorder', undefined);
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput(onTranscript));

    act(() => result.current.start());

    expect(result.current.state).toMatchObject({ status: 'error', kind: 'unsupported' });
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('surfaces a "denied" error when the mic permission is refused', async () => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const denied = Object.assign(new Error('no'), { name: 'NotAllowedError' });
    setGetUserMedia(vi.fn().mockRejectedValue(denied));
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput(onTranscript));

    act(() => result.current.start());

    await waitFor(() => expect(result.current.state.status).toBe('error'));
    expect(result.current.state).toMatchObject({ status: 'error', kind: 'denied' });
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('stops an orphaned mic stream when unmounted while the permission prompt is pending', async () => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const track = { stop: vi.fn() };
    let resolveGum: (s: MediaStream) => void = () => {};
    const gum = new Promise<MediaStream>((r) => (resolveGum = r));
    setGetUserMedia(vi.fn().mockReturnValue(gum));
    const { result, unmount } = renderHook(() => useVoiceInput(vi.fn()));

    act(() => result.current.start()); // 'requesting' — getUserMedia still pending
    unmount(); // cleanup runs, mountedRef → false, while the stream is not yet acquired
    await act(async () => {
      resolveGum({ getTracks: () => [track] } as unknown as MediaStream);
      await gum;
    });

    expect(track.stop).toHaveBeenCalledTimes(1); // the late stream is released, not left live
  });

  it('records, transcribes, and hands back the text (returns to idle)', async () => {
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    setGetUserMedia(vi.fn().mockResolvedValue(fakeStream()));
    stubAudioContext(0.3); // real speech energy — clears the VAD
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ text: 'здравей' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput(onTranscript));

    act(() => result.current.start());
    await waitFor(() => expect(result.current.state.status).toBe('recording'));

    clock = 2000; // 2s of recording — clears the min-duration gate
    act(() => result.current.stop());
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('здравей'));
    expect(result.current.state.status).toBe('idle');
  });

  it('auto-stops after sustained silence once speech has been heard', async () => {
    vi.useFakeTimers();
    const now = vi.spyOn(Date, 'now');
    let t = 0;
    now.mockImplementation(() => t);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    setGetUserMedia(vi.fn().mockResolvedValue(fakeStream()));
    stubAudioContext(0.3); // post-hoc decode reports speech, so the auto-stopped clip isn't gated
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ text: 'здравей' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput(onTranscript));

    await act(async () => {
      result.current.start();
    });
    expect(result.current.state.status).toBe('recording');

    liveLevel = 0.3; // heard speech at t≈300ms
    t = 300;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    liveLevel = 0; // then silence for > SILENCE_STOP_MS (5s) → the monitor stops recording itself
    t = 6300;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    // No manual stop() was called — silence alone ended the recording and drove transcription.
    expect(onTranscript).toHaveBeenCalledWith('здравей');
    expect(result.current.state.status).toBe('idle');
    vi.useRealTimers();
  });

  it('skips the endpoint for a too-short clip (accidental tap → no speech)', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(0); // start and stop at the same instant → 0ms elapsed
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    setGetUserMedia(vi.fn().mockResolvedValue(fakeStream()));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput(onTranscript));

    act(() => result.current.start());
    await waitFor(() => expect(result.current.state.status).toBe('recording'));
    act(() => result.current.stop());

    await waitFor(() =>
      expect(result.current.state).toMatchObject({ status: 'error', kind: 'noSpeech' }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('gates a long but silent clip via VAD (no speech energy → not sent)', async () => {
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    setGetUserMedia(vi.fn().mockResolvedValue(fakeStream()));
    stubAudioContext(0); // silence — below the RMS threshold
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput(onTranscript));

    act(() => result.current.start());
    await waitFor(() => expect(result.current.state.status).toBe('recording'));
    clock = 3000; // well past the min-duration gate, so only VAD can reject it
    act(() => result.current.stop());

    await waitFor(() =>
      expect(result.current.state).toMatchObject({ status: 'error', kind: 'noSpeech' }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('keeps the capture error when a stop fires after a recorder error (no noSpeech clobber)', async () => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    setGetUserMedia(vi.fn().mockResolvedValue(fakeStream()));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput(onTranscript));

    act(() => result.current.start());
    await waitFor(() => expect(result.current.state.status).toBe('recording'));

    act(() => {
      FakeMediaRecorder.last?.onerror?.(); // recorder error → fail('capture'), onstop nulled
      FakeMediaRecorder.last?.onstop?.(); // late stop must be a no-op now
    });

    expect(result.current.state).toMatchObject({ status: 'error', kind: 'capture' });
    expect(onTranscript).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces a transcription error when the endpoint fails', async () => {
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    setGetUserMedia(vi.fn().mockResolvedValue(fakeStream()));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput(onTranscript));

    act(() => result.current.start());
    await waitFor(() => expect(result.current.state.status).toBe('recording'));

    clock = 2000; // clear the min-duration gate so we reach the endpoint
    act(() => result.current.stop());
    await waitFor(() =>
      expect(result.current.state).toMatchObject({ status: 'error', kind: 'transcription' }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
  });
});
