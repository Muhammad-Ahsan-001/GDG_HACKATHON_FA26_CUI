import { useCallback, useEffect, useRef, useState } from 'react'

export type RecorderState = 'idle' | 'recording' | 'stopped' | 'denied' | 'unsupported' | 'error'

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
const UI_FRAME_MS = 80 // ~12 fps of level/timer updates: smooth enough, cheap on low-end phones

/**
 * Client-side silence detection (CONTRACT-1B "Voice edge cases"). Levels are frame RMS of the
 * time-domain signal, 0..1 (1 = full scale). The noise floor is learnt from the first CALIBRATE_MS of
 * each take and then adapts slowly (fan switched on, traffic), so "voiced" means "clearly above the room".
 */
export const SILENCE = {
  /** learn the room's noise floor from the first 300 ms */
  CALIBRATE_MS: 300,
  /** a take needs at least this much voice to be a description (first report turn) */
  MIN_VOICED_MS: 1000,
  /** below this much voice the take is treated as silence (taps, a cough, a click) */
  NO_VOICE_MS: 250,
  /** keep counting "voiced" this long after a loud frame (gaps between syllables) */
  HANGOVER_MS: 120,
  /** a take whose loudest frame is below this is silent whatever the floor says */
  PEAK_MIN: 0.025,
  /** ignore the start-up transient (mic click / AGC settling) for the peak */
  SKIP_MS: 120,
  FLOOR_MIN: 0.003,
  FLOOR_MAX: 0.045,
  THRESHOLD_MIN: 0.018,
  THRESHOLD_MAX: 0.1,
} as const

export interface TakeStats {
  /** loudest frame RMS of the take (0..1), start-up transient excluded */
  peak: number
  /** total time the signal was clearly above the adaptive noise floor */
  voicedMs: number
  /** time actually analysed (AudioContext running, page visible); 0 when no analyser was available */
  analysedMs: number
  /** learnt noise floor (frame RMS) */
  noiseFloor: number
  durationMs: number
}
export interface TakeResult extends TakeStats { blob: Blob; mime: string }

/** 'unknown' = the take could not be analysed (no Web Audio, suspended context): let the server judge it. */
export type TakeVerdict = 'ok' | 'silent' | 'too_short' | 'unknown'

/** Decide what to do with a finished take before uploading it. `minVoicedMs` defaults to 1 s (a description);
 *  pass a lower value for short answers to a follow-up question ("haan", "nahi"). */
export function classifyTake(s: TakeStats, opts: { minVoicedMs?: number } = {}): TakeVerdict {
  const minVoiced = opts.minVoicedMs ?? SILENCE.MIN_VOICED_MS
  if (s.analysedMs <= 0 || s.analysedMs < s.durationMs * 0.5) return 'unknown'
  if (s.peak < SILENCE.PEAK_MIN || s.voicedMs < SILENCE.NO_VOICE_MS) return 'silent'
  if (s.voicedMs < minVoiced) return 'too_short'
  return 'ok'
}

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return ''
  return MIME_CANDIDATES.find((m) => { try { return MediaRecorder.isTypeSupported(m) } catch { return false } }) ?? ''
}

function getAudioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
}

export function isRecordingSupported(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined'
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const thresholdFor = (floor: number) => clamp(floor * 3 + 0.004, SILENCE.THRESHOLD_MIN, SILENCE.THRESHOLD_MAX)

/** Running voice-activity statistics of one take (updated per animation frame). */
interface Vad {
  firstAt: number
  lastAt: number
  calibrating: boolean
  cal: { rms: number; dt: number; at: number }[]
  floor: number
  threshold: number
  peak: number
  voicedMs: number
  analysedMs: number
  /** time of the last frame above the threshold (for the hang-over) */
  lastVoiceAt: number
}

function newVad(): Vad {
  return {
    firstAt: 0, lastAt: 0, calibrating: true, cal: [], floor: SILENCE.FLOOR_MIN, threshold: SILENCE.THRESHOLD_MIN,
    peak: 0, voicedMs: 0, analysedMs: 0, lastVoiceAt: -1e9,
  }
}

function countFrame(v: Vad, rms: number, dt: number, at: number) {
  if (rms > v.threshold) { v.voicedMs += dt; v.lastVoiceAt = at }
  else if (at - v.lastVoiceAt <= SILENCE.HANGOVER_MS) v.voicedMs += dt
}

function vadFrame(v: Vad, rms: number, now: number) {
  if (!v.firstAt) { v.firstAt = now; v.lastAt = now; return }
  const dt = Math.min(100, now - v.lastAt) // rAF pauses (tab hidden) must not count as audio
  v.lastAt = now
  if (dt <= 0) return
  v.analysedMs += dt
  const age = now - v.firstAt
  if (age >= SILENCE.SKIP_MS && rms > v.peak) v.peak = rms
  if (v.calibrating) {
    v.cal.push({ rms, dt, at: now })
    if (age < SILENCE.CALIBRATE_MS) return
    // 25th percentile: robust when the user starts talking straight away
    const sorted = v.cal.map((c) => c.rms).sort((a, b) => a - b)
    v.floor = clamp(sorted[Math.floor(sorted.length * 0.25)] ?? 0, SILENCE.FLOOR_MIN, SILENCE.FLOOR_MAX)
    v.threshold = thresholdFor(v.floor)
    v.calibrating = false
    for (const c of v.cal) countFrame(v, c.rms, c.dt, c.at) // speech in the first 300 ms still counts
    v.cal = []
    return
  }
  countFrame(v, rms, dt, now)
  // adapt: fall quickly towards quieter frames, rise very slowly with steady non-voice noise
  if (rms < v.floor) v.floor = Math.max(SILENCE.FLOOR_MIN, v.floor * 0.9 + rms * 0.1)
  else if (rms < v.threshold) v.floor = Math.min(SILENCE.FLOOR_MAX, v.floor * 0.995 + rms * 0.005)
  v.threshold = thresholdFor(v.floor)
}

function vadStats(v: Vad | null, durationMs: number): TakeStats {
  if (!v) return { peak: 0, voicedMs: 0, analysedMs: 0, noiseFloor: 0, durationMs }
  // a take shorter than the calibration window: judge it against the fixed minimum threshold
  if (v.calibrating && v.cal.length) {
    for (const c of v.cal) countFrame(v, c.rms, c.dt, c.at)
    v.cal = []
    v.calibrating = false
  }
  return {
    peak: Math.round(v.peak * 1000) / 1000,
    voicedMs: Math.round(v.voicedMs),
    analysedMs: Math.round(v.analysedMs),
    noiseFloor: Math.round(v.floor * 1000) / 1000,
    durationMs,
  }
}

/** Everything that belongs to one recording; a late `onstop` of an old take never touches a newer one. */
interface Take {
  recorder: MediaRecorder
  stream: MediaStream
  ctx: AudioContext | null
  vad: Vad | null
  chunks: Blob[]
  startedAt: number
  raf: number
  interval: ReturnType<typeof setInterval> | null
  autoStop: ReturnType<typeof setTimeout> | null
  /** resolvers waiting for this take's final result */
  waiters: ((r: TakeResult | null) => void)[]
  /** drop the audio on stop (reset / unmount) */
  discard: boolean
  /** stopped by the maxMs timer (reported through onAutoStop) */
  auto: boolean
  released: boolean
}

function releaseTake(tk: Take) {
  if (tk.released) return
  tk.released = true
  if (tk.raf) cancelAnimationFrame(tk.raf)
  tk.raf = 0
  if (tk.interval) clearInterval(tk.interval)
  tk.interval = null
  if (tk.autoStop) clearTimeout(tk.autoStop)
  tk.autoStop = null
  tk.stream.getTracks().forEach((tr) => tr.stop())
  if (tk.ctx && tk.ctx.state !== 'closed') void tk.ctx.close().catch(() => undefined)
  tk.ctx = null
}

/**
 * Voice-note recorder (MediaRecorder + AnalyserNode level meter via requestAnimationFrame).
 * Returns { state, start, stop, finish, reset, blob, mime, durationMs, level, peak, voicedMs, maxMs }.
 * - `stop()` resolves with the final blob (or null), so callers can stop-and-send in one tap.
 * - `finish()` resolves with the blob plus silence statistics ({ peak, voicedMs, ... }) — feed it to classifyTake().
 * - `peak` / `voicedMs` are also live state while recording (for UI hints).
 * Auto-stops after `maxMs` (then `onAutoStop` receives the result). Mic tracks and the AudioContext are released on
 * stop, reset and unmount.
 */
export function useRecorder(opts: { maxMs?: number; onAutoStop?: (r: TakeResult | null) => void } = {}) {
  const maxMs = opts.maxMs ?? 90_000
  const [state, setState] = useState<RecorderState>(() => (isRecordingSupported() ? 'idle' : 'unsupported'))
  const [blob, setBlob] = useState<Blob | null>(null)
  const [mime, setMime] = useState('')
  const [durationMs, setDurationMs] = useState(0)
  const [level, setLevel] = useState(0)
  const [peak, setPeak] = useState(0)
  const [voicedMs, setVoicedMs] = useState(0)
  const take = useRef<Take | null>(null)
  const starting = useRef(false)
  /** bumped by stop/reset/unmount so a start() still awaiting getUserMedia gives up */
  const startToken = useRef(0)
  const mounted = useRef(true)
  const onAutoStop = useRef(opts.onAutoStop)
  useEffect(() => { onAutoStop.current = opts.onAutoStop }, [opts.onAutoStop])

  const finish = useCallback((): Promise<TakeResult | null> => {
    const tk = take.current
    if (!tk) {
      if (starting.current) startToken.current++ // cancel a start still waiting for mic permission
      return Promise.resolve(null)
    }
    return new Promise<TakeResult | null>((resolve) => {
      tk.waiters.push(resolve)
      if (tk.autoStop) clearTimeout(tk.autoStop)
      tk.autoStop = null
      // 'inactive' = a stop is already in flight (e.g. auto-stop): just wait for onstop.
      // Tracks are released in onstop, after the recorder flushed its last chunk (Safari loses it otherwise).
      if (tk.recorder.state !== 'inactive') {
        try { tk.recorder.stop() } catch { releaseTake(tk); tk.waiters.splice(0).forEach((w) => w(null)) }
      }
    })
  }, [])

  const stop = useCallback((): Promise<Blob | null> => finish().then((r) => r?.blob ?? null), [finish])

  const start = useCallback(async () => {
    if (starting.current || take.current?.recorder.state === 'recording') return
    if (!isRecordingSupported()) { setState('unsupported'); return }
    starting.current = true
    const token = ++startToken.current
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      })
    } catch (e) {
      starting.current = false
      if (!mounted.current || token !== startToken.current) return
      const name = (e as { name?: string })?.name
      setState(name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError'
        ? 'denied'
        : name === 'NotFoundError' || name === 'NotSupportedError' || name === 'OverconstrainedError' ? 'unsupported' : 'error')
      return
    }
    if (!mounted.current || token !== startToken.current) {
      stream.getTracks().forEach((tr) => tr.stop())
      starting.current = false
      return
    }

    const picked = pickMime()
    let recorder: MediaRecorder
    try {
      recorder = picked ? new MediaRecorder(stream, { mimeType: picked, audioBitsPerSecond: 32_000 }) : new MediaRecorder(stream)
    } catch {
      try { recorder = new MediaRecorder(stream) } catch {
        stream.getTracks().forEach((tr) => tr.stop())
        starting.current = false
        setState('error')
        return
      }
    }

    const tk: Take = {
      recorder, stream, ctx: null, vad: null, chunks: [], startedAt: 0, raf: 0, interval: null, autoStop: null,
      waiters: [], discard: false, auto: false, released: false,
    }
    // a previous take still flushing keeps running on its own object; this one becomes current
    take.current = tk

    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) tk.chunks.push(ev.data) }
    recorder.onstop = () => {
      const type = recorder.mimeType || picked || 'audio/webm'
      const elapsed = Math.round(performance.now() - tk.startedAt)
      const out = tk.discard || tk.chunks.length === 0 ? null : new Blob(tk.chunks, { type })
      const result: TakeResult | null = out ? { blob: out, mime: type, ...vadStats(tk.vad, elapsed) } : null
      tk.chunks = []
      releaseTake(tk)
      const isCurrent = take.current === tk
      if (isCurrent) take.current = null
      if (isCurrent && mounted.current && !tk.discard) {
        setBlob(out)
        setMime(type)
        setDurationMs(elapsed)
        setLevel(0)
        if (result) { setPeak(result.peak); setVoicedMs(result.voicedMs) }
        setState(out ? 'stopped' : 'error')
      }
      const waiters = tk.waiters.splice(0)
      waiters.forEach((w) => w(result))
      if (tk.auto && waiters.length === 0 && !tk.discard && mounted.current) onAutoStop.current?.(result)
    }
    recorder.onerror = () => {
      releaseTake(tk)
      tk.chunks = []
      tk.waiters.splice(0).forEach((w) => w(null))
      if (take.current === tk) {
        take.current = null
        if (mounted.current) { setLevel(0); setState('error') }
      }
    }

    // Level meter + voice activity. Failure here is not fatal: recording still works (the take is then 'unknown').
    const Ctor = getAudioContextCtor()
    if (Ctor) {
      try {
        const ctx = new Ctor()
        tk.ctx = ctx
        if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
        const src = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        // Safari only pulls audio through nodes that reach the destination: route via a muted gain (no echo).
        const mute = ctx.createGain()
        mute.gain.value = 0
        src.connect(analyser)
        analyser.connect(mute)
        mute.connect(ctx.destination)
        const buf = new Uint8Array(analyser.fftSize)
        const vad = newVad()
        tk.vad = vad
        let smooth = 0
        let lastUi = 0
        const tick = (now: number) => {
          if (tk.released) return
          analyser.getByteTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
          const rms = Math.sqrt(sum / buf.length)
          // a suspended context delivers flat silence: don't let it count as "the user said nothing"
          if (ctx.state === 'running' && tk.recorder.state === 'recording') vadFrame(vad, rms, now)
          else vad.lastAt = now
          smooth = smooth * 0.6 + Math.min(1, Math.sqrt(rms) * 1.6) * 0.4
          if (now - lastUi >= UI_FRAME_MS && take.current === tk && tk.recorder.state === 'recording') {
            lastUi = now
            setLevel(smooth)
            setPeak(vad.peak)
            setVoicedMs(Math.round(vad.voicedMs))
            setDurationMs(Math.round(performance.now() - tk.startedAt))
          }
          tk.raf = requestAnimationFrame(tick)
        }
        tk.raf = requestAnimationFrame(tick)
      } catch {
        if (tk.ctx) void tk.ctx.close().catch(() => undefined)
        tk.ctx = null
        tk.vad = null
      }
    }

    try {
      recorder.start(1000)
    } catch {
      releaseTake(tk)
      take.current = null
      starting.current = false
      setState('error')
      return
    }
    tk.startedAt = performance.now()
    // timer without an AudioContext (no rAF loop updating the duration)
    if (!tk.ctx) {
      tk.interval = setInterval(() => {
        if (take.current === tk && tk.recorder.state === 'recording') setDurationMs(Math.round(performance.now() - tk.startedAt))
      }, 250)
    }
    tk.autoStop = setTimeout(() => {
      if (take.current !== tk) return
      tk.auto = true
      tk.autoStop = null
      if (tk.recorder.state !== 'inactive') {
        try { tk.recorder.stop() } catch { releaseTake(tk) }
      }
    }, maxMs)
    starting.current = false
    setBlob(null)
    setMime('')
    setDurationMs(0)
    setLevel(0)
    setPeak(0)
    setVoicedMs(0)
    setState('recording')
  }, [maxMs])

  /** Discard any take (running or finished) and go back to idle. */
  const reset = useCallback(() => {
    if (starting.current) startToken.current++
    const tk = take.current
    if (tk) {
      tk.discard = true
      take.current = null
      if (tk.recorder.state !== 'inactive') { try { tk.recorder.stop() } catch { /* ignore */ } }
      releaseTake(tk)
    }
    setBlob(null)
    setMime('')
    setDurationMs(0)
    setLevel(0)
    setPeak(0)
    setVoicedMs(0)
    setState(isRecordingSupported() ? 'idle' : 'unsupported')
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      startToken.current++
      const tk = take.current
      if (tk) {
        tk.discard = true
        take.current = null
        if (tk.recorder.state !== 'inactive') { try { tk.recorder.stop() } catch { /* ignore */ } }
        releaseTake(tk)
      }
    }
  }, [])

  return { state, start, stop, finish, reset, blob, mime, durationMs, level, peak, voicedMs, maxMs }
}

export type Recorder = ReturnType<typeof useRecorder>
