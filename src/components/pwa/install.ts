// "Add to home screen" state. The beforeinstallprompt listener is attached at module load (this module is
// imported from App.tsx before the first render) so an early event is never missed.
import { useSyncExternalStore } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

export interface InstallState {
  /** Chrome/Edge/Samsung: the native install dialog can be opened with promptInstall() */
  canInstall: boolean
  /** iOS/iPadOS Safari: no install API — show the Share → Add to Home Screen hint instead */
  iosHint: boolean
  /** running as an installed app (standalone) or just installed */
  installed: boolean
}

let deferred: BeforeInstallPromptEvent | null = null
let installed = isStandalone()
let snapshot: InstallState = compute()
const listeners = new Set<() => void>()
const installedListeners = new Set<() => void>()

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const nav = navigator as Navigator & { standalone?: boolean }
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  // iPadOS 13+ reports itself as Macintosh; touch points give it away
  return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)
}

function compute(): InstallState {
  return { canInstall: Boolean(deferred) && !installed, iosHint: !installed && isIos(), installed }
}

function emit() {
  snapshot = compute()
  for (const l of listeners) l()
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault() // suppress Chrome's mini-infobar; we show our own chip
    deferred = e as BeforeInstallPromptEvent
    emit()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    installed = true
    emit()
    for (const l of installedListeners) l()
  })
}

/** Open the native install dialog. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const e = deferred
  if (!e) return 'unavailable'
  deferred = null // the event can only be used once
  emit()
  try {
    await e.prompt()
    const { outcome } = await e.userChoice
    return outcome
  } catch {
    return 'dismissed'
  }
}

/** Called once when the app gets installed (appinstalled event). */
export function onAppInstalled(cb: () => void): () => void {
  installedListeners.add(cb)
  return () => { installedListeners.delete(cb) }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const getSnapshot = () => snapshot

/** Reactive install state, usable by any page (e.g. an "Install" button on Landing or Me). */
export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
