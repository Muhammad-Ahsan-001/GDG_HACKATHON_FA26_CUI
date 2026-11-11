// SOS session controller used by /sos: server session (sos Edge Function), chunked mic upload queue,
// live location, realtime status, screen wake lock, manual alert and ending. Silent by design.
import { useCallback, useEffect, useRef, useState } from 'react'
import { distanceM } from '../../hooks/useGeolocation'
import { useSosRecorder, type SosChunk } from '../../hooks/useSosRecorder'
import { api } from '../../lib/api'
import type { SosResponse, SosSession, SosStatus, SosTrigger, ThreatLevel } from '../../lib/sos'
import { supabase } from '../../lib/supabase'
import { stopVoice } from '../../lib/voice/player'
import {
  isPermanentError, orgNamesOf, readSosOrgs, saveSosOrgs, sleep, sosChunkPath, uploadSosChunk, vibrate,
} from './sosClient'

export type AlertSendState = 'idle' | 'sending' | 'retrying' | 'failed'
export type SosGeoState = 'locating' | 'ok' | 'denied' | 'unavailable'
export type AlertSource = 'ai' | 'manual'

interface Fix { lat: number; lng: number; accuracy: number; at: number }
interface PendingChunk { seq: number; path: string; tries: number }

const LOC_MIN_INTERVAL_MS = 15_000   // send at most every 15 s …
const LOC_MIN_MOVE_M = 25            // … or sooner once moved 25 m
const LOC_MOVE_RATE_MS = 5_000       // (never more than one update per 5 s)
const LOC_TICK_MS = 5_000
const START_RETRY_MS = [0, 1500, 4000, 8000]
const ALERT_MAX_ATTEMPTS = 8
const CHUNK_MAX_TRIES = 3
/** Ending within this window without an alert = "started by mistake" (outcome 'cancelled'). */
const MISTAKE_WINDOW_MS = 15_000
const ENDED_STATUSES: SosStatus[] = ['safe', 'cancelled', 'resolved']
const THREAT_RANK: Record<ThreatLevel, number> = { none: 0, possible: 1, high: 2 }

type WakeSentinel = { release: () => Promise<void>; addEventListener?: (type: 'release', cb: () => void) => void }
type WakeLockApi = { request: (type: 'screen') => Promise<WakeSentinel> }

export function useSosSession({ sessionId, trigger, uid }: { sessionId: string; trigger: SosTrigger; uid: string | null }) {
  const [startedAt] = useState(() => Date.now())
  const [alert, setAlert] = useState<{ source: AlertSource } | null>(null)
  /** police org names (null = not known yet, [] = no police covers this spot) */
  const [orgs, setOrgs] = useState<string[] | null>(() => readSosOrgs(sessionId))
  const [threat, setThreat] = useState<ThreatLevel>('none')
  const [reason, setReason] = useState<{ en: string; ur: string } | null>(null)
  const [alertSend, setAlertSend] = useState<AlertSendState>('idle')
  /** set when the server ended the session (e.g. police resolved it) */
  const [endedBy, setEndedBy] = useState<SosStatus | null>(null)
  /** the user ended it here ("I'm safe") */
  const [finished, setFinished] = useState(false)
  const [startTrouble, setStartTrouble] = useState(false)
  const [sent, setSent] = useState(0)
  const [netIssue, setNetIssue] = useState(false)
  const [geo, setGeo] = useState<{ state: SosGeoState; accuracy: number | null }>(() => ({
    state: typeof navigator !== 'undefined' && 'geolocation' in navigator ? 'locating' : 'unavailable', accuracy: null,
  }))

  const alive = useRef(true)
  const alertedRef = useRef(false)
  const alertBusy = useRef(false)
  const finishing = useRef(false)
  const startOk = useRef(false)
  const startInflight = useRef<Promise<boolean> | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const pending = useRef<PendingChunk[]>([])
  const fixRef = useRef<Fix | null>(null)
  const lastLoc = useRef<{ lat: number; lng: number; at: number; fixAt: number } | null>(null)
  const locBusy = useRef(false)
  const uidRef = useRef(uid)
  useEffect(() => { uidRef.current = uid }, [uid])

  const locFields = () => {
    const f = fixRef.current
    return f ? { lat: f.lat, lng: f.lng } : {}
  }

  const markAlerted = useCallback((source: AlertSource) => {
    if (alertedRef.current) return
    alertedRef.current = true
    setAlert({ source })
    vibrate([300, 120, 300]) // silent cue: police were told
  }, [])

  /** Merge a server answer (Edge Function response or realtime row) into the UI state. */
  const apply = useCallback((res: Partial<SosResponse> | null | undefined, source?: AlertSource) => {
    if (!res) return
    const level = res.threat_level
    if (level && THREAT_RANK[level] !== undefined) setThreat((prev) => (THREAT_RANK[level] > THREAT_RANK[prev] ? level : prev))
    if (res.reason_en || res.reason_ur) setReason({ en: res.reason_en ?? '', ur: res.reason_ur ?? '' })
    const names = orgNamesOf(res)
    if (names) { setOrgs(names); saveSosOrgs(sessionId, names) }
    if (res.alerted || res.status === 'alerted') {
      markAlerted(source ?? (alertBusy.current ? 'manual' : level === 'high' ? 'ai' : 'manual'))
    }
    if (res.status && ENDED_STATUSES.includes(res.status) && !finishing.current) setEndedBy(res.status)
  }, [sessionId, markAlerted])

  /** Create the server session once (idempotent on the server); concurrent callers share one request. */
  const ensureStarted = useCallback((): Promise<boolean> => {
    if (startOk.current) return Promise.resolve(true)
    if (startInflight.current) return startInflight.current
    const p = (async () => {
      try {
        const f = fixRef.current
        const res = await api.sos({
          action: 'start', session_id: sessionId, trigger,
          ...(f ? { lat: f.lat, lng: f.lng, accuracy_m: Math.round(f.accuracy) } : {}),
        })
        startOk.current = true
        setStartTrouble(false)
        apply(res)
        return true
      } catch {
        setStartTrouble(true)
        return false
      } finally {
        startInflight.current = null
      }
    })()
    startInflight.current = p
    return p
  }, [sessionId, trigger, apply])

  /** Register uploaded chunks with the server in order; stops at the first failure (retried with the next chunk). */
  const flushChunks = useCallback(async () => {
    if (!pending.current.length) return
    if (!(await ensureStarted())) { setNetIssue(true); return }
    while (pending.current.length) {
      const c = pending.current[0]
      try {
        const res = await api.sos({ action: 'chunk', session_id: sessionId, seq: c.seq, audio_path: c.path, ...locFields() })
        pending.current.shift()
        setSent((n) => n + 1)
        setNetIssue(false)
        apply(res)
      } catch (e) {
        c.tries += 1
        const permanent = isPermanentError(e)
        if (permanent || c.tries >= CHUNK_MAX_TRIES) pending.current.shift()
        if (!permanent) setNetIssue(true)
        return
      }
    }
  }, [ensureStarted, sessionId, apply])

  /** Each chunk: upload → register (`sos` chunk). One queue, so uploads never overlap; failures don't stop it. */
  const onChunk = useCallback((chunk: SosChunk) => {
    queue.current = queue.current.then(async () => {
      if (finishing.current && !alertedRef.current) return // user is safe: leftovers are not analysed
      const u = uidRef.current
      if (!u) return
      const path = sosChunkPath(u, sessionId, chunk.seq, chunk.mime)
      if (await uploadSosChunk(path, chunk.blob, chunk.mime)) pending.current.push({ seq: chunk.seq, path, tries: 0 })
      else setNetIssue(true)
      await flushChunks()
    }).catch(() => undefined)
  }, [sessionId, flushChunks])

  const recorder = useSosRecorder({ onChunk })
  const { start: startMic, stop: stopMic } = recorder

  // ---- location: high-accuracy watch → `sos` location (≥ 15 s apart, or ≥ 25 m moved)
  const maybeSendLocation = useCallback(async () => {
    const f = fixRef.current
    if (!f || locBusy.current || finishing.current) return
    const last = lastLoc.current
    if (last) {
      if (f.at === last.fixAt) return
      const since = Date.now() - last.at
      const moved = distanceM(last, f)
      if (!(since >= LOC_MIN_INTERVAL_MS || (moved >= LOC_MIN_MOVE_M && since >= LOC_MOVE_RATE_MS))) return
    }
    locBusy.current = true
    try {
      if (!(await ensureStarted())) return
      await api.sos({ action: 'location', session_id: sessionId, lat: f.lat, lng: f.lng, accuracy_m: Math.round(f.accuracy) })
      lastLoc.current = { lat: f.lat, lng: f.lng, at: Date.now(), fixAt: f.at }
    } catch { /* the next fix / tick retries */ } finally {
      locBusy.current = false
    }
  }, [ensureStarted, sessionId])

  const active = !endedBy && !finished

  useEffect(() => {
    if (!active || !('geolocation' in navigator)) return
    const id = navigator.geolocation.watchPosition(
      (p) => {
        fixRef.current = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() }
        const acc = Math.max(1, Math.round(p.coords.accuracy / 5) * 5) // fewer re-renders
        setGeo((g) => (g.state === 'ok' && g.accuracy === acc ? g : { state: 'ok', accuracy: acc }))
        void maybeSendLocation()
      },
      (e) => {
        if (e.code === e.PERMISSION_DENIED) setGeo({ state: 'denied', accuracy: null })
        else setGeo((g) => (g.state === 'ok' ? g : { state: 'locating', accuracy: null })) // the watch keeps trying
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
    )
    const tick = setInterval(() => { void maybeSendLocation() }, LOC_TICK_MS)
    return () => { navigator.geolocation.clearWatch(id); clearInterval(tick) }
  }, [active, maybeSendLocation])

  // ---- realtime: the server flips the session to 'alerted' (AI heard a threat) or police resolve it
  useEffect(() => {
    const ch = supabase
      .channel(`sos-${sessionId}-${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sos_sessions', filter: `id=eq.${sessionId}` }, (payload) => {
        if (payload.eventType === 'DELETE') return
        const row = payload.new as Partial<SosSession>
        apply({ status: row.status, threat_level: row.threat_level })
        const r = row.threat_reason
        if (r) setReason((prev) => prev ?? { en: r, ur: r })
      })
      .subscribe()
    return () => { void supabase.removeChannel(ch) }
  }, [sessionId, apply])

  // ---- screen wake lock while active (re-acquired when the page becomes visible again)
  useEffect(() => {
    if (!active) return
    const wl = (navigator as unknown as { wakeLock?: WakeLockApi }).wakeLock
    if (!wl) return
    let on = true
    let sentinel: WakeSentinel | null = null
    const acquire = async () => {
      if (!on || sentinel || document.visibilityState !== 'visible') return
      try {
        const s = await wl.request('screen')
        if (!on) { void s.release().catch(() => undefined); return }
        sentinel = s
        s.addEventListener?.('release', () => { if (sentinel === s) sentinel = null })
      } catch { /* denied (battery saver) — not fatal */ }
    }
    void acquire()
    const onVis = () => { if (document.visibilityState === 'visible') void acquire() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      on = false
      document.removeEventListener('visibilitychange', onVis)
      const s = sentinel
      sentinel = null
      if (s) void s.release().catch(() => undefined)
    }
  }, [active])

  // ---- mount: silence any voice prompt, create the session, open the mic
  useEffect(() => {
    alive.current = true
    stopVoice()
    void (async () => {
      for (const wait of START_RETRY_MS) {
        if (!alive.current || startOk.current) return
        if (wait) await sleep(wait)
        if (!alive.current) return
        if (await ensureStarted()) return
      }
    })()
    void startMic()
    return () => {
      alive.current = false
      // Deferred so React StrictMode's dev re-mount does not end the session. Leaving the screen without
      // "I'm safe" cancels a session that never alerted; an alerted one stays open for police.
      setTimeout(() => {
        if (alive.current || finishing.current) return
        finishing.current = true
        if (!alertedRef.current && startOk.current) {
          void api.sos({ action: 'end', session_id: sessionId, outcome: 'cancelled' }).catch(() => undefined)
        }
      }, 0)
    }
  }, [ensureStarted, startMic, sessionId])

  // server ended the session elsewhere: stop listening
  useEffect(() => {
    if (!endedBy) return
    finishing.current = true
    void stopMic({ flush: false })
  }, [endedBy, stopMic])

  /** Manual escalation ("Send alert now") — no AI needed, works without the mic. Retries with backoff. */
  const sendAlert = useCallback(async () => {
    if (alertBusy.current || alertedRef.current || finishing.current) return
    alertBusy.current = true
    setAlertSend('sending')
    vibrate(40)
    try {
      for (let attempt = 0; alive.current && !alertedRef.current; attempt++) {
        if (await ensureStarted()) {
          try {
            const res = await api.sos({ action: 'alert', session_id: sessionId, ...locFields() })
            apply(res, 'manual')
            markAlerted('manual') // the server accepted the alert
            setAlertSend('idle')
            return
          } catch (e) {
            if (isPermanentError(e)) { setAlertSend('failed'); return }
          }
        }
        if (attempt >= ALERT_MAX_ATTEMPTS - 1) { setAlertSend('failed'); return }
        setAlertSend('retrying')
        await sleep(Math.min(15_000, 2000 * 2 ** attempt))
      }
      if (alertedRef.current) setAlertSend('idle')
    } finally {
      alertBusy.current = false
    }
  }, [ensureStarted, sessionId, apply, markAlerted])

  /** "I'm safe": stop listening and end the session (in the background, after queued evidence). */
  const finish = useCallback(async () => {
    if (finishing.current) return
    finishing.current = true
    setFinished(true)
    const alerted = alertedRef.current
    const outcome: 'safe' | 'cancelled' = alerted || Date.now() - startedAt >= MISTAKE_WINDOW_MS ? 'safe' : 'cancelled'
    // keep the last seconds as evidence only when police are involved
    await stopMic({ flush: alerted })
    queue.current = queue.current.then(async () => {
      if (!startOk.current && startInflight.current) await startInflight.current
      if (!startOk.current) return // the server never had this session
      for (let i = 0; i < 3; i++) {
        try {
          await api.sos({ action: 'end', session_id: sessionId, outcome })
          return
        } catch (e) {
          if (isPermanentError(e)) return
          await sleep(1500 * (i + 1))
        }
      }
    }).catch(() => undefined)
  }, [startedAt, stopMic, sessionId])

  const retryMic = useCallback(() => { void startMic() }, [startMic])

  return {
    startedAt,
    mic: recorder.state,
    readLevel: recorder.readLevel,
    retryMic,
    alert,
    orgs,
    threat,
    reason,
    alertSend,
    endedBy,
    finished,
    startTrouble,
    sent,
    netIssue,
    geo,
    sendAlert,
    finish,
  }
}
