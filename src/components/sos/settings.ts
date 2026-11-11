// Per-device SOS trigger settings (localStorage, every access wrapped in try/catch).
//   sos.volume — 3 presses of a hardware volume key start SOS (default ON)
//   sos.shake  — 3 strong shakes start SOS (default OFF, opt-in; iOS needs a motion permission tap)
import { useSyncExternalStore } from 'react'

export type SosSettingKey = 'volume' | 'shake'
export type SosSettings = Readonly<Record<SosSettingKey, boolean>>

const STORAGE_KEYS: Record<SosSettingKey, string> = { volume: 'sos.volume', shake: 'sos.shake' }
const DEFAULTS: SosSettings = { volume: true, shake: false }

function readOne(k: SosSettingKey): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEYS[k])
    if (v === '1' || v === 'true') return true
    if (v === '0' || v === 'false') return false
  } catch { /* storage unavailable */ }
  return DEFAULTS[k]
}

function readAll(): SosSettings {
  return { volume: readOne('volume'), shake: readOne('shake') }
}

let snapshot: SosSettings = readAll()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function onStorage(e: StorageEvent) {
  if (e.key && e.key !== STORAGE_KEYS.volume && e.key !== STORAGE_KEYS.shake) return
  const next = readAll()
  if (next.volume !== snapshot.volume || next.shake !== snapshot.shake) { snapshot = next; emit() }
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  if (listeners.size === 1 && typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

export function getSosSettings(): SosSettings {
  return snapshot
}

export function setSosSetting(key: SosSettingKey, on: boolean): void {
  try { localStorage.setItem(STORAGE_KEYS[key], on ? '1' : '0') } catch { /* storage unavailable: in-memory only */ }
  if (snapshot[key] === on) return
  snapshot = { ...snapshot, [key]: on }
  emit()
}

/** Live SOS settings (updates across components and other tabs). */
export function useSosSettings(): SosSettings {
  return useSyncExternalStore(subscribe, getSosSettings, getSosSettings)
}

// ---- device motion (shake trigger)
type MotionPermissionCtor = { requestPermission?: () => Promise<'granted' | 'denied' | 'default'> }

export function motionSupported(): boolean {
  return typeof window !== 'undefined' && 'DeviceMotionEvent' in window
}

/**
 * iOS 13+ only delivers devicemotion after DeviceMotionEvent.requestPermission(), which must be called
 * from a tap. Other browsers need no permission. Call this from the toggle's click handler.
 */
export async function requestMotionPermission(): Promise<'granted' | 'denied' | 'unsupported'> {
  if (!motionSupported()) return 'unsupported'
  const ctor = window.DeviceMotionEvent as unknown as MotionPermissionCtor
  if (typeof ctor.requestPermission !== 'function') return 'granted'
  try {
    return (await ctor.requestPermission()) === 'granted' ? 'granted' : 'denied'
  } catch {
    return 'denied'
  }
}
