// Lazy chunk: the WebGL dotted globe (cobe). Spins, decelerates onto Pakistan, then dives in (scale) and
// tells the stage to cross-fade into the live Leaflet map. Pauses when off-screen or the tab is hidden.
import createGlobe, { type Arc, type Marker } from 'cobe'
import { useEffect, useRef } from 'react'

const D = Math.PI / 180
const ISB: [number, number] = [33.6844, 73.0479]

// [lat, lng, size] — Islamabad & Rawalpindi lead, other Pakistani cities glow softer
const CITIES: [number, number, number][] = [
  [33.6844, 73.0479, 0.075], // Islamabad
  [33.5651, 73.0169, 0.055], // Rawalpindi
  [31.5204, 74.3587, 0.04],  // Lahore
  [24.8607, 67.0011, 0.045], // Karachi
  [34.0151, 71.5249, 0.035], // Peshawar
  [30.1798, 66.975, 0.03],   // Quetta
  [30.1575, 71.5249, 0.03],  // Multan
  [31.4504, 73.135, 0.03],   // Faisalabad
]
const AMBER: [number, number, number] = [1, 0.74, 0.28]
const TEAL: [number, number, number] = [0.37, 0.95, 0.85]
const ARCS: Arc[] = [CITIES[2], CITIES[3], CITIES[4], CITIES[5]].map(([la, ln]) => ({ from: [la, ln], to: ISB }))

// cobe: a point faces the camera when phi = 3π/2 − lng and theta = lat
const TARGET_PHI = 1.5 * Math.PI - ISB[1] * D
const TARGET_THETA = ISB[0] * D
const START_PHI = TARGET_PHI - 1.55 * Math.PI
const START_THETA = 0.18
const SPIN_MS = 3600
const ZOOM_FROM = 2500
const ZOOM_TO = 4900
const ARRIVE_MS = 4000
const MAX_SCALE = 2.7

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const easeOutCubic = (x: number) => 1 - (1 - x) ** 3
const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2)

/** cobe's own projection (dist/index.esm.js `O`), used to pin the HTML city label onto Islamabad. */
function project(lat: number, lng: number, phi: number, theta: number, scale: number) {
  const r = lat * D
  const a = lng * D - Math.PI
  const k = 0.8 + 0.01 // cobe globe radius + markerElevation
  const v = [-Math.cos(r) * Math.cos(a) * k, Math.sin(r) * k, Math.cos(r) * Math.sin(a) * k]
  const ct = Math.cos(theta), st = Math.sin(theta), cp = Math.cos(phi), sp = Math.sin(phi)
  const x = cp * v[0] + sp * v[2]
  const y = sp * st * v[0] + ct * v[1] - cp * st * v[2]
  const z = -sp * ct * v[0] + st * v[1] + cp * ct * v[2]
  return { x: (x * scale + 1) / 2, y: (-y * scale + 1) / 2, visible: z >= 0 }
}

export default function CobeGlobe({ onReady, onArrive, label }: {
  onReady?: () => void
  onArrive?: () => void
  label?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const cbRef = useRef({ onReady, onArrive })
  cbRef.current = { onReady, onArrive }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // cobe re-parents its canvas, so the canvas is created here, outside React's tree
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true')
    host.appendChild(canvas)

    const narrow = window.innerWidth < 640
    const dpr = Math.min(window.devicePixelRatio || 1, narrow ? 1.5 : 2)
    let size = Math.max(1, host.offsetWidth)

    const markers = (pulse: number): Marker[] => CITIES.map(([la, ln, s], i) => ({
      location: [la, ln],
      size: i === 0 ? s * (1 + 0.28 * pulse) : i === 1 ? s * (1 + 0.2 * (1 - pulse)) : s,
      color: i < 2 ? AMBER : TEAL,
    }))

    const globe = createGlobe(canvas, {
      devicePixelRatio: dpr,
      width: size,
      height: size,
      phi: START_PHI,
      theta: START_THETA,
      dark: 1,
      diffuse: 1.25,
      scale: 1,
      mapSamples: 18000,
      mapBrightness: 5.5,
      mapBaseBrightness: 0.02,
      baseColor: [0.16, 0.36, 0.44],
      markerColor: AMBER,
      glowColor: [0.07, 0.42, 0.42],
      markers: markers(0),
      arcs: ARCS,
      arcColor: TEAL,
      arcWidth: 0.5,
      arcHeight: 0.22,
      markerElevation: 0.01,
      opacity: 0.92,
    })

    const ro = new ResizeObserver(() => {
      const w = Math.max(1, host.offsetWidth)
      if (w !== size) { size = w; globe.update({ width: w, height: w }) }
    })
    ro.observe(host)

    let elapsed = 0
    let last = 0
    let raf = 0
    let onScreen = true
    let arrived = false
    let readySent = false

    const frame = (now: number) => {
      raf = 0
      // real time (pauses reset `last`, so no jump after being hidden); capped so one long stall can't skip the intro
      const dt = last ? Math.min(250, now - last) : 16
      last = now
      elapsed += dt
      const t = elapsed
      const spin = clamp01(t / SPIN_MS)
      const drift = t > SPIN_MS ? Math.sin((t - SPIN_MS) / 1800) * 0.03 : 0
      const phi = START_PHI + (TARGET_PHI - START_PHI) * easeOutCubic(spin) + drift
      const theta = START_THETA + (TARGET_THETA - START_THETA) * easeInOutCubic(spin)
      const scale = 1 + (MAX_SCALE - 1) * easeInOutCubic(clamp01((t - ZOOM_FROM) / (ZOOM_TO - ZOOM_FROM)))
      const pulse = (Math.sin(t / 260) + 1) / 2
      globe.update({ phi, theta, scale, markers: markers(pulse) })

      const el = labelRef.current
      if (el) {
        const p = project(ISB[0], ISB[1], phi, theta, scale)
        el.style.transform = `translate3d(${(p.x * size).toFixed(1)}px, ${(p.y * size).toFixed(1)}px, 0) translate(-50%, calc(-100% - 14px))`
        el.style.opacity = p.visible && t > 1400 ? '1' : '0'
      }
      if (!readySent) { readySent = true; cbRef.current.onReady?.() }
      if (!arrived && t >= ARRIVE_MS) { arrived = true; cbRef.current.onArrive?.() }
      if (onScreen && !document.hidden) raf = requestAnimationFrame(frame)
    }
    const resume = () => {
      if (!raf && onScreen && !document.hidden) { last = 0; raf = requestAnimationFrame(frame) }
    }
    const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; resume() }, { threshold: 0 })
    io.observe(host)
    const onVis = () => resume()
    document.addEventListener('visibilitychange', onVis)
    resume()

    return () => {
      if (raf) cancelAnimationFrame(raf)
      io.disconnect()
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVis)
      globe.destroy()
      host.replaceChildren()
    }
  }, [])

  return (
    <>
      <div ref={hostRef} className="absolute inset-0" />
      {label && (
        <div ref={labelRef} className="lp-city-label" style={{ opacity: 0 }} aria-hidden="true">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#030916]/75 px-2.5 py-1 text-xs font-bold text-amber-200 shadow-lg ring-1 ring-amber-300/40">
            <span className="size-1.5 rounded-full bg-amber-300" />
            {label}
          </span>
        </div>
      )}
    </>
  )
}
