// New-alert feedback: a short two-tone Web Audio beep + vibration. No audio files, works offline.

let ctx: AudioContext | null = null

function audioContext(): AudioContext | null {
  if (ctx) return ctx
  try {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    ctx = new Ctor()
    return ctx
  } catch {
    return null
  }
}

/** Call from a user gesture (pointerdown) so later beeps are allowed by autoplay policy. */
export function unlockAudio(): void {
  const c = audioContext()
  if (c && c.state === 'suspended') void c.resume().catch(() => { /* still locked */ })
}

/** Two quick rising tones (~0.45 s). Silent no-op if audio is unavailable or still locked. */
export function beep(): void {
  const c = audioContext()
  if (!c) return
  try {
    if (c.state === 'suspended') void c.resume().catch(() => { /* locked */ })
    const t0 = c.currentTime + 0.01
    const tones: [number, number][] = [[880, 0], [1320, 0.22]]
    for (const [freq, offset] of tones) {
      const osc = c.createOscillator()
      const gain = c.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const start = t0 + offset
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.4, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.19)
      osc.connect(gain)
      gain.connect(c.destination)
      osc.start(start)
      osc.stop(start + 0.21)
    }
  } catch {
    /* ignore audio errors */
  }
}

export function vibrate(): void {
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate([200, 100, 200])
  } catch {
    /* not allowed (no user activation) */
  }
}

/**
 * SOS alarm: a loud two-tone "hi-lo" siren (~3 s), unmistakably different from the normal two-beep alert.
 * Square wave through a low-pass filter: piercing on cheap phone speakers without clipping.
 */
export function siren(durationS = 3): void {
  const c = audioContext()
  if (!c) return
  try {
    if (c.state === 'suspended') void c.resume().catch(() => { /* locked */ })
    const t0 = c.currentTime + 0.02
    const end = t0 + durationS
    const osc = c.createOscillator()
    const lowpass = c.createBiquadFilter()
    const gain = c.createGain()
    osc.type = 'square'
    lowpass.type = 'lowpass'
    lowpass.frequency.value = 2600
    const step = 0.34
    for (let i = 0, t = t0; t < end; i++, t += step) osc.frequency.setValueAtTime(i % 2 ? 740 : 988, t)
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(0.55, t0 + 0.04)
    gain.gain.setValueAtTime(0.55, end - 0.1)
    gain.gain.exponentialRampToValueAtTime(0.0001, end)
    osc.connect(lowpass)
    lowpass.connect(gain)
    gain.connect(c.destination)
    osc.start(t0)
    osc.stop(end + 0.02)
  } catch {
    /* ignore audio errors */
  }
}

/** Long, insistent SOS vibration (distinct from the short new-alert buzz). */
export function vibrateSos(): void {
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate([700, 150, 700, 150, 1100])
  } catch {
    /* not allowed (no user activation) */
  }
}
