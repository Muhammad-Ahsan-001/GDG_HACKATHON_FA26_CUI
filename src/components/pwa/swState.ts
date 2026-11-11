// Service-worker lifecycle state shared between src/main.tsx (registerSW callbacks) and <UpdatePrompt/>.
import { useSyncExternalStore } from 'react'

export interface SwState {
  /** a new version took control (autoUpdate) or is waiting (prompt mode) — the page should refresh */
  updateReady: boolean
  /** first install finished: the app shell is cached and works offline */
  offlineReady: boolean
}

let state: SwState = { updateReady: false, offlineReady: false }
let apply: () => void = () => window.location.reload()
const listeners = new Set<() => void>()

function set(next: Partial<SwState>) {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

/** `applyFn` activates the update (default: reload the page). */
export function markUpdateReady(applyFn?: () => void): void {
  if (applyFn) apply = applyFn
  set({ updateReady: true })
}

export function markOfflineReady(): void {
  set({ offlineReady: true })
}

export function clearOfflineReady(): void {
  set({ offlineReady: false })
}

export function dismissUpdate(): void {
  set({ updateReady: false })
}

export function applyUpdate(): void {
  apply()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const getSnapshot = () => state

export function useSwState(): SwState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
