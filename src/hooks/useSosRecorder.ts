import { useCallback, useEffect, useRef, useState } from 'react'
import { SOS_CHUNK_SECONDS } from '../lib/sos'

/**
 * SOS listening recorder: ONE microphone stream, cut into self-contained audio files of `chunkSeconds`
 * by restarting MediaRecorder for every chunk (each file has its own header, so the server can transcribe
 * it on its own). Emits `{ blob, mime, seq, durationMs }` through `onChunk`; `seq` keeps counting across
 * mic restarts. No sound is ever played (the level meter runs through a muted node).
 */
export type SosMicState = 'idle' | 'starting' | 'recording' | 'stopped' | 'denied' | 'unsupported' | 'error'
export interface SosChunk { blob: Blob; mime: string; seq: number; durationMs: number }

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
/** Shorter fragments (e.g. the tail when stopping) are dropped: nothing to transcribe in them. */
const MIN_CHUNK_MS = 700
const MIN_CHUNK_BYTES = 200
/** Tracks are released after the recorder's final `stop`; this is the safety net if it never comes. */
const RELEASE_FALLBACK_MS = 2000
/** Recorder errors in a row before giving up on the stream. */
const MAX_SEGMENT_ERRORS = 3

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return ''
  return MIME_CANDIDATES.find((m) => { try { return MediaRecorder.isTypeSupported(m) } catch { return false } }) ?? ''
}

function getAudioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
}

export function isSosRecordingSupported(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined'
}

interface Segment {
  rec: MediaRecorder
  parts: Blob[]
  startedAt: number
  /** drop this segment's audio when it stops */
  discard: boolean
  /** the next recorder could not start while this one was flushing: start it from this one's onstop */
  restartAfter: boolean
  finished: boolean
}

interface Run {
  stream: MediaStream
  mime: string
  seg: Segment | null
  timer: ReturnType<typeof setTimeout> | null
  stopping: boolean
  released: boolean
  errors: number
  ctx: AudioContext | null
  analyser: AnalyserNode | null
  buf: Uint8Array<ArrayBuffer> | null
  waiters: (() => void)[]
}

interface Ctl {
  chunkMs: number
  emit: (run: Run, seg: Segment) => void
  fatal: (run: Run) => void
}

function releaseRun(run: Run) {
  if (run.released) return
  run.released = true
  if (run.timer) clearTimeout(run.timer)
  run.timer = null
  run.stream.getTracks().forEach((tr) => tr.stop())
  if (run.ctx && run.ctx.state !== 'closed') void run.ctx.close().catch(() => undefined)
  run.ctx = null
  run.analyser = null
  run.buf = null
  run.waiters.splice(0).forEach((w) => w())
}

function stopSegment(run: Run, seg: Segment, ctl: Ctl) {
  if (seg.rec.state === 'inactive') return // a stop is already in flight: onstop will finish it
  try { seg.rec.stop() } catch { finishSegment(run, seg, ctl, false) }
}

function startSegment(run: Run, ctl: Ctl): boolean {
  let rec: MediaRecorder
  try {
    rec = run.mime ? new MediaRecorder(run.stream, { mimeType: run.mime, audioBitsPerSecond: 32_000 }) : new MediaRecorder(run.stream)
  } catch {
    try { rec = new MediaRecorder(run.stream) } catch { return false }
  }
  const seg: Segment = { rec, parts: [], startedAt: performance.now(), discard: false, restartAfter: false, finished: false }
  rec.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) seg.parts.push(ev.data) }
  rec.onstop = () => finishSegment(run, seg, ctl, false)
  rec.onerror = () => finishSegment(run, seg, ctl, true)
  try {
    rec.start(1000) // 1 s slices: the final blob is still one self-contained file per recorder
  } catch {
    return false
  }
  run.seg = seg
  if (run.timer) clearTimeout(run.timer)
  run.timer = setTimeout(() => rotate(run, ctl), ctl.chunkMs)
  return true
}

/** End the current chunk and immediately begin the next one on the same stream (gap of a few ms). */
function rotate(run: Run, ctl: Ctl) {
  run.timer = null
  if (run.stopping || run.released) return
  const old = run.seg
  if (!old) return
  run.seg = null // detach first: the old segment's onstop is then a normal rotation, not an unexpected stop
  stopSegment(run, old, ctl)
  if (run.stopping || run.released || run.seg) return
  if (!startSegment(run, ctl)) {
    if (old.finished) ctl.fatal(run)
    else old.restartAfter = true // some browsers refuse a second recorder while the first flushes: retry from its onstop
  }
}

function finishSegment(run: Run, seg: Segment, ctl: Ctl, errored: boolean) {
  if (seg.finished) return
  seg.finished = true
  ctl.emit(run, seg)
  seg.parts = []
  const wasCurrent = run.seg === seg
  if (wasCurrent) run.seg = null
  if (!run.stopping && !run.released && run.seg === null) {
    // wasCurrent: the browser stopped / errored the live recorder by itself (rotation detaches first);
    // restartAfter: rotation could not open the next recorder while this one was flushing
    if (wasCurrent || seg.restartAfter) {
      if (wasCurrent) run.errors += 1
      const live = run.stream.getAudioTracks().some((tr) => tr.readyState === 'live')
      if (!live || run.errors > MAX_SEGMENT_ERRORS || !startSegment(run, ctl)) ctl.fatal(run)
    }
  } else if (!errored && !wasCurrent) {
    run.errors = 0 // a normal rotation finished cleanly
  }
  if (run.stopping && !run.seg) releaseRun(run)
}

export function useSosRecorder(opts: { onChunk: (chunk: SosChunk) => void; chunkSeconds?: number }) {
  const chunkMs = Math.max(2, opts.chunkSeconds ?? SOS_CHUNK_SECONDS) * 1000
  const [state, setState] = useState<SosMicState>(() => (isSosRecordingSupported() ? 'idle' : 'unsupported'))
  const onChunkRef = useRef(opts.onChunk)
  useEffect(() => { onChunkRef.current = opts.onChunk })
  const runRef = useRef<Run | null>(null)
  const seqRef = useRef(0)
  /** token of the start() still waiting for mic permission (0 = none); stale once startToken moves on */
  const starting = useRef(0)
  /** bumped by stop/unmount so a start() still waiting for mic permission gives up */
  const startToken = useRef(0)
  const mounted = useRef(true)

  const ctlRef = useRef<Ctl>({
    chunkMs,
    emit: (run, seg) => {
      const dur = performance.now() - seg.startedAt
      if (seg.discard || seg.parts.length === 0 || dur < MIN_CHUNK_MS) return
      const type = seg.rec.mimeType || run.mime || 'audio/webm'
      const blob = new Blob(seg.parts, { type })
      if (blob.size < MIN_CHUNK_BYTES) return
      const seq = seqRef.current++
      try { onChunkRef.current({ blob, mime: type, seq, durationMs: Math.round(dur) }) } catch { /* consumer error must not kill recording */ }
    },
    fatal: (run) => {
      run.stopping = true
      if (run.seg) {
        const seg = run.seg
        stopSegment(run, seg, ctlRef.current)
        setTimeout(() => releaseRun(run), RELEASE_FALLBACK_MS)
      } else {
        releaseRun(run)
      }
      if (runRef.current === run) {
        runRef.current = null
        if (mounted.current) setState('error')
      }
    },
  })
  useEffect(() => { ctlRef.current.chunkMs = chunkMs }, [chunkMs])

  const start = useCallback(async () => {
    // a start() still waiting for permission is reused, unless stop/unmount invalidated it (e.g. React StrictMode's
    // dev re-mount): then this call starts afresh, otherwise the stale one gives up and the mic never opens
    if (runRef.current || (starting.current !== 0 && starting.current === startToken.current)) return
    if (!isSosRecordingSupported()) { setState('unsupported'); return }
    const token = ++startToken.current
    starting.current = token
    setState('starting')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // no noise suppression: we want distant / muffled voices too (phone in a bag or pocket)
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true, channelCount: 1 },
      })
    } catch (e) {
      if (starting.current === token) starting.current = 0
      if (!mounted.current || token !== startToken.current) return
      const name = (e as { name?: string })?.name
      setState(name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError'
        ? 'denied'
        : name === 'NotFoundError' || name === 'NotSupportedError' || name === 'OverconstrainedError' ? 'unsupported' : 'error')
      return
    }
    if (!mounted.current || token !== startToken.current) {
      stream.getTracks().forEach((tr) => tr.stop())
      if (starting.current === token) starting.current = 0
      return
    }

    const run: Run = {
      stream, mime: pickMime(), seg: null, timer: null, stopping: false, released: false, errors: 0,
      ctx: null, analyser: null, buf: null, waiters: [],
    }

    // Level meter (read on demand by the UI). Failure is not fatal.
    const Ctor = getAudioContextCtor()
    if (Ctor) {
      try {
        const ctx = new Ctor()
        run.ctx = ctx
        if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
        const src = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        // Safari only pulls audio through nodes that reach the destination: route via a muted gain (silent).
        const mute = ctx.createGain()
        mute.gain.value = 0
        src.connect(analyser)
        analyser.connect(mute)
        mute.connect(ctx.destination)
        run.analyser = analyser
        run.buf = new Uint8Array(new ArrayBuffer(analyser.fftSize))
      } catch {
        if (run.ctx) void run.ctx.close().catch(() => undefined)
        run.ctx = null
        run.analyser = null
      }
    }

    // mic taken away (phone call, unplugged headset, permission revoked): keep the audio we have, report error
    stream.getAudioTracks().forEach((tr) => tr.addEventListener('ended', () => {
      if (!run.stopping && !run.released) ctlRef.current.fatal(run)
    }))

    if (!startSegment(run, ctlRef.current)) {
      releaseRun(run)
      starting.current = 0
      setState('error')
      return
    }
    runRef.current = run
    starting.current = 0
    setState('recording')
  }, [])

  /**
   * Stop listening. `flush` (default true) emits the partial last chunk; false drops it.
   * Resolves once the microphone is released.
   */
  const stop = useCallback((o: { flush?: boolean } = {}): Promise<void> => {
    const flush = o.flush ?? true
    const run = runRef.current
    if (!run) {
      if (starting.current !== 0) startToken.current++
      if (mounted.current) setState((s) => (s === 'recording' || s === 'starting' ? 'stopped' : s))
      return Promise.resolve()
    }
    runRef.current = null
    if (mounted.current) setState('stopped')
    return new Promise<void>((resolve) => {
      run.waiters.push(resolve)
      run.stopping = true
      if (run.timer) clearTimeout(run.timer)
      run.timer = null
      const seg = run.seg
      if (!seg) { releaseRun(run); return }
      seg.discard = !flush
      stopSegment(run, seg, ctlRef.current)
      if (seg.finished && !run.seg) releaseRun(run)
      setTimeout(() => releaseRun(run), RELEASE_FALLBACK_MS)
    })
  }, [])

  /** Current input level 0..1 (cheap; call from an animation loop only while it is on screen). */
  const readLevel = useCallback((): number => {
    const run = runRef.current
    if (!run?.analyser || !run.buf) return 0
    try {
      run.analyser.getByteTimeDomainData(run.buf)
    } catch {
      return 0
    }
    const buf = run.buf
    let sum = 0
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
    return Math.min(1, Math.sqrt(Math.sqrt(sum / buf.length)) * 1.6)
  }, [])

  // unmount: release the mic, drop the partial chunk
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      startToken.current++
      const run = runRef.current
      runRef.current = null
      if (run) {
        run.stopping = true
        if (run.timer) clearTimeout(run.timer)
        run.timer = null
        if (run.seg) {
          run.seg.discard = true
          stopSegment(run, run.seg, ctlRef.current)
          setTimeout(() => releaseRun(run), RELEASE_FALLBACK_MS)
        } else {
          releaseRun(run)
        }
      }
    }
  }, [])

  return { state, start, stop, readLevel, chunkMs }
}

export type SosRecorder = ReturnType<typeof useSosRecorder>
