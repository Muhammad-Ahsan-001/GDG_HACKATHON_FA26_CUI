import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import type { SosTrigger } from '../../lib/sos'
import { motionSupported, useSosSettings } from './settings'
import { vibrate } from './sosClient'

// Volume keys: 3 presses within 2.5 s.
const VOLUME_KEYS = new Set(['AudioVolumeUp', 'AudioVolumeDown', 'VolumeUp', 'VolumeDown'])
const VOLUME_KEYCODES = new Set([174, 175, 182, 183])
const VOLUME_PRESSES = 3
const VOLUME_WINDOW_MS = 2500

// Shake: 3 strong peaks within 2 s (a peak = linear acceleration above ~1.6 g, peaks >= 250 ms apart).
const SHAKE_PEAKS = 3
const SHAKE_WINDOW_MS = 2000
const SHAKE_THRESHOLD = 16 // m/s², gravity removed
const SHAKE_MIN_GAP_MS = 250

const COOLDOWN_MS = 4000
/** Routes where the global triggers stay quiet: SOS itself and the staff consoles. */
const QUIET_PREFIXES = ['/sos', '/dashboard', '/admin']

function isVolumeKey(e: KeyboardEvent): boolean {
  return VOLUME_KEYS.has(e.key) || VOLUME_KEYCODES.has(e.keyCode)
}

/** Acceleration without gravity (m/s²); falls back to |a incl. gravity| − g on devices without `acceleration`. */
function linearMagnitude(e: DeviceMotionEvent): number | null {
  const a = e.acceleration
  if (a && a.x != null && a.y != null && a.z != null) return Math.hypot(a.x, a.y, a.z)
  const g = e.accelerationIncludingGravity
  if (g && g.x != null && g.y != null && g.z != null) return Math.abs(Math.hypot(g.x, g.y, g.z) - 9.81)
  return null
}

/** Keep timestamps inside the window, add `now`, report whether the count was reached. */
function push(times: number[], now: number, windowMs: number, needed: number): boolean {
  while (times.length && now - times[0] > windowMs) times.shift()
  times.push(now)
  return times.length >= needed
}

/**
 * App-wide, invisible SOS triggers (mounted once in <PwaLayer/>):
 *  - hardware volume keys pressed 3× within 2.5 s (best effort: only some Android browsers deliver them,
 *    and only while the app is open in the foreground);
 *  - opt-in shake detector (3 strong shakes in 2 s).
 * Both → navigate('/sos?trigger=volume|shake'). Settings: localStorage sos.volume (default on), sos.shake (default off).
 * Armed only while signed in (anonymous OK) and never on /sos or the staff consoles.
 */
export function SosTriggers() {
  const nav = useNavigate()
  const { pathname } = useLocation()
  const { session } = useAuth()
  const settings = useSosSettings()
  const armed = Boolean(session) && !QUIET_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  const lastFire = useRef(0)

  const fire = useRef<(trigger: SosTrigger) => void>(() => undefined)
  useEffect(() => {
    fire.current = (trigger) => {
      const now = Date.now()
      if (now - lastFire.current < COOLDOWN_MS) return
      lastFire.current = now
      vibrate([60, 40, 60])
      nav(`/sos?trigger=${trigger}`)
    }
  }, [nav])

  // ---- volume keys
  useEffect(() => {
    if (!armed || !settings.volume) return
    const presses: number[] = []
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || !isVolumeKey(e)) return
      if (push(presses, performance.now(), VOLUME_WINDOW_MS, VOLUME_PRESSES)) {
        presses.length = 0
        fire.current('volume')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [armed, settings.volume])

  // ---- shake
  useEffect(() => {
    if (!armed || !settings.shake || !motionSupported()) return
    const peaks: number[] = []
    let lastPeak = 0
    const onMotion = (e: DeviceMotionEvent) => {
      const mag = linearMagnitude(e)
      if (mag === null || mag < SHAKE_THRESHOLD) return
      const now = performance.now()
      if (now - lastPeak < SHAKE_MIN_GAP_MS) return
      lastPeak = now
      if (push(peaks, now, SHAKE_WINDOW_MS, SHAKE_PEAKS)) {
        peaks.length = 0
        fire.current('shake')
      }
    }
    window.addEventListener('devicemotion', onMotion)
    return () => window.removeEventListener('devicemotion', onMotion)
  }, [armed, settings.shake])

  return null
}
