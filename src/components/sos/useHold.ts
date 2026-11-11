import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { vibrate } from './sosClient'

const QUICK_TAP_MS = 450
const HINT_MS = 2400

/**
 * Press-and-hold gesture (prevents accidental SOS / accidental "I'm safe").
 * `holding` drives a CSS fill animation of `ms` length; `onDone` fires once the hold completes.
 * A quick tap shows `hint` for a moment ("hold the button"). Works with touch, mouse, pen and Enter/Space.
 */
export function useHold(ms: number, onDone: () => void, opts: { disabled?: boolean } = {}) {
  const disabled = Boolean(opts.disabled)
  const [holding, setHolding] = useState(false)
  const [hint, setHint] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startedAt = useRef(0)
  const done = useRef(onDone)
  useEffect(() => { done.current = onDone })

  const begin = useCallback(() => {
    if (disabled || timer.current) return
    startedAt.current = performance.now()
    setHolding(true)
    setHint(false)
    vibrate(15)
    timer.current = setTimeout(() => {
      timer.current = null
      setHolding(false)
      vibrate([70])
      done.current()
    }, ms)
  }, [disabled, ms])

  const end = useCallback(() => {
    if (!timer.current) return
    clearTimeout(timer.current)
    timer.current = null
    setHolding(false)
    if (performance.now() - startedAt.current < QUICK_TAP_MS) {
      setHint(true)
      if (hintTimer.current) clearTimeout(hintTimer.current)
      hintTimer.current = setTimeout(() => setHint(false), HINT_MS)
    }
  }, [])

  // a disabled control can't stay "held"
  useEffect(() => {
    if (disabled && timer.current) { clearTimeout(timer.current); timer.current = null; setHolding(false) }
  }, [disabled])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
    if (hintTimer.current) clearTimeout(hintTimer.current)
  }, [])

  const bind = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      // capture: a finger sliding a little off the button keeps holding
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* old browsers */ }
      begin()
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); begin() }
    },
    onKeyUp: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter' || e.key === ' ') end()
    },
    onBlur: end,
    // long-press must not open the browser's context menu / text selection
    onContextMenu: (e: MouseEvent<HTMLElement>) => e.preventDefault(),
  }

  return { holding, hint, bind }
}
