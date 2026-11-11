import { useCallback, useEffect, useRef, useState } from 'react'

export type RecorderState = 'idle' | 'recording' | 'stopped' | 'denied' | 'unsupported' | 'error'

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
const UI_FRAME_MS = 80 // ~12 fps of level/timer updates: smooth enough, cheap on low-end phones

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

/** Everything that belongs to one recording; a late `onstop` of an old take never touches a newer one. */
interface Take {
  recorder: MediaRecorder
  stream: MediaStream
  ctx: AudioContext | null
  chunks: Blob[]
  startedAt: number
  raf: number
  interval: ReturnType<typeof setInterval> | null
  autoStop: ReturnType<typeof setTimeout> | null
  /** resolvers waiting for this take's final blob */
  waiters: ((b: Blob | null) => void)[]
  /** drop the audio on stop (reset / unmount) */
  discard: boolean
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
 * Returns { state, start, stop, reset, blob, mime, durationMs, level, maxMs }.
 * `stop()` resolves with the final blob (or null), so callers can stop-and-send in one tap.
 * Auto-stops after `maxMs`. Mic tracks and the AudioContext are released on stop, reset and unmount.
 */
export function useRecorder(opts: { maxMs?: number } = {}) {
  const maxMs = opts.maxMs ?? 90_000
  const [state, setState] = useState<RecorderState>(() => (isRecordingSupported() ? 'idle' : 'unsupported'))
  const [blob, setBlob] = useState<Blob | null>(null)
  const [mime, setMime] = useState('')
  const [durationMs, setDurationMs] = useState(0)
  const [level, setLevel] = useState(0)
  const take = useRef<Take | null>(null)
  const starting = useRef(false)
  /** bumped by stop/reset/unmount so a start() still awaiting getUserMedia gives up */
  const startToken = useRef(0)
  const mounted = useRef(true)

  const stop = useCallback((): Promise<Blob | null> => {
    const tk = take.current
    if (!tk) {
      if (starting.current) startToken.current++ // cancel a start still waiting for mic permission
      return Promise.resolve(null)
    }
    return new Promise<Blob | null>((resolve) => {
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
      recorder, stream, ctx: null, chunks: [], startedAt: 0, raf: 0, interval: null, autoStop: null,
      waiters: [], discard: false, released: false,
    }
    // a previous take still flushing keeps running on its own object; this one becomes current
    take.current = tk

    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) tk.chunks.push(ev.data) }
    recorder.onstop = () => {
      const type = recorder.mimeType || picked || 'audio/webm'
      const elapsed = Math.round(performance.now() - tk.startedAt)
      const out = tk.discard || tk.chunks.length === 0 ? null : new Blob(tk.chunks, { type })
      tk.chunks = []
      releaseTake(tk)
      const isCurrent = take.current === tk
      if (isCurrent) take.current = null
      if (isCurrent && mounted.current && !tk.discard) {
        setBlob(out)
        setMime(type)
        setDurationMs(elapsed)
        setLevel(0)
        setState(out ? 'stopped' : 'error')
      }
      tk.waiters.splice(0).forEach((w) => w(out))
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

    // Level meter. Failure here is not fatal: recording still works without the bars.
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
        let smooth = 0
        let lastUi = 0
        const tick = (now: number) => {
          if (tk.released) return
          analyser.getByteTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
          const rms = Math.sqrt(sum / buf.length)
          smooth = smooth * 0.6 + Math.min(1, Math.sqrt(rms) * 1.6) * 0.4
          if (now - lastUi >= UI_FRAME_MS && take.current === tk && tk.recorder.state === 'recording') {
            lastUi = now
            setLevel(smooth)
            setDurationMs(Math.round(performance.now() - tk.startedAt))
          }
          tk.raf = requestAnimationFrame(tick)
        }
        tk.raf = requestAnimationFrame(tick)
      } catch {
        if (tk.ctx) void tk.ctx.close().catch(() => undefined)
        tk.ctx = null
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
    tk.autoStop = setTimeout(() => { if (take.current === tk) void stop() }, maxMs)
    starting.current = false
    setBlob(null)
    setMime('')
    setDurationMs(0)
    setLevel(0)
    setState('recording')
  }, [maxMs, stop])

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

  return { state, start, stop, reset, blob, mime, durationMs, level, maxMs }
}

export type Recorder = ReturnType<typeof useRecorder>
