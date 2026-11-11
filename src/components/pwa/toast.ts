// Tiny global toast store. Call `toast({ title, body?, url? })` from anywhere (no provider needed);
// <Toaster/> (mounted once in App.tsx) renders them at the top of the screen.
import type { LucideIcon } from 'lucide-react'
import { useSyncExternalStore } from 'react'

export type ToastTone = 'info' | 'success' | 'warning' | 'error' | 'alert'

export interface ToastInput {
  title: string
  body?: string
  /** in-app path opened when the toast is tapped, e.g. /pin/<id> */
  url?: string | null
  tone?: ToastTone
  /** icon shown in the coloured circle (defaults by tone) */
  icon?: LucideIcon
  /** circle colour override (use CATEGORY_META / STATUS_META colours, never ad-hoc ones) */
  color?: string
  /** auto-dismiss after this many ms (default 6000; 0 = stay until dismissed) */
  durationMs?: number
}

export interface Toast extends ToastInput {
  id: number
  createdAt: number
}

const MAX_VISIBLE = 3
const DEFAULT_DURATION_MS = 6000

let toasts: Toast[] = []
let nextId = 1
const listeners = new Set<() => void>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function emit() {
  for (const l of listeners) l()
}

/** Show a toast; returns its id. */
export function toast(input: ToastInput): number {
  const id = nextId++
  const item: Toast = { tone: 'info', ...input, id, createdAt: Date.now() }
  const dropped = toasts.slice(MAX_VISIBLE - 1)
  for (const d of dropped) clearTimer(d.id)
  toasts = [item, ...toasts.slice(0, MAX_VISIBLE - 1)]
  const duration = input.durationMs ?? DEFAULT_DURATION_MS
  if (duration > 0) timers.set(id, setTimeout(() => dismissToast(id), duration))
  emit()
  return id
}

export function dismissToast(id: number): void {
  clearTimer(id)
  const next = toasts.filter((t) => t.id !== id)
  if (next.length === toasts.length) return
  toasts = next
  emit()
}

/** Pause auto-dismiss (e.g. while the user is touching the toast). */
export function holdToast(id: number): void {
  clearTimer(id)
}

function clearTimer(id: number) {
  const t = timers.get(id)
  if (t) clearTimeout(t)
  timers.delete(id)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const getSnapshot = () => toasts

/** Current toasts, newest first. */
export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
