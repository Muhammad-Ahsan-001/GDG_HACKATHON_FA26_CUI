// Lazy chunk: static light SVG globe centred on Pakistan (reduced motion / low-end / no WebGL). No animation loop.
// Same daytime palette as the cobe globe: mint sphere, teal-slate land, Pakistan in brand teal, amber Islamabad.
import { geoGraticule10, geoOrthographic, geoPath } from 'd3-geo'
import { useEffect, useMemo, useState } from 'react'
import { feature } from 'topojson-client'
import type { GeometryCollection, Topology } from 'topojson-specification'
import countriesUrl from 'world-atlas/countries-110m.json?url'

const SIZE = 400
const PAKISTAN_ID = '586'
const CITIES: [number, number, number][] = [
  [73.0479, 33.6844, 7], [73.0169, 33.5651, 5], [74.3587, 31.5204, 4], [67.0011, 24.8607, 4.5],
  [71.5249, 34.0151, 3.5], [66.975, 30.1798, 3], [71.5249, 30.1575, 3],
]

interface Shape { d: string; pk: boolean }

export default function SvgGlobe({ onReady, label }: { onReady?: () => void; label?: string }) {
  const [shapes, setShapes] = useState<Shape[]>([])

  const projection = useMemo(
    () => geoOrthographic().rotate([-69, -29]).fitExtent([[SIZE * 0.1, SIZE * 0.1], [SIZE * 0.9, SIZE * 0.9]], { type: 'Sphere' }),
    [],
  )
  const path = useMemo(() => geoPath(projection), [projection])
  const sphere = path({ type: 'Sphere' }) ?? ''
  const graticule = path(geoGraticule10()) ?? ''

  useEffect(() => {
    let alive = true
    void fetch(countriesUrl)
      .then((r) => r.json() as Promise<Topology<{ countries: GeometryCollection }>>)
      .then((topo) => {
        if (!alive) return
        const fc = feature(topo, topo.objects.countries)
        setShapes(fc.features.map((f) => ({ d: path(f) ?? '', pk: String(f.id) === PAKISTAN_ID })).filter((s) => s.d))
      })
      .catch(() => { /* sphere + graticule still render */ })
      .finally(() => { if (alive) onReady?.() })
    return () => { alive = false }
  }, [path, onReady])

  const isb = projection([73.0479, 33.6844])

  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="absolute inset-0 size-full" aria-hidden="true">
      <defs>
        <radialGradient id="lp-sg-sphere" cx="40%" cy="34%" r="72%">
          <stop offset="0%" stopColor="#f0fffc" />
          <stop offset="55%" stopColor="#d4f8f2" />
          <stop offset="90%" stopColor="#ade9e0" />
          <stop offset="100%" stopColor="#c6f4ec" />
        </radialGradient>
        <radialGradient id="lp-sg-glow" cx="50%" cy="50%" r="50%">
          <stop offset="70%" stopColor="#2dd4bf" stopOpacity="0" />
          <stop offset="86%" stopColor="#2dd4bf" stopOpacity=".28" />
          <stop offset="100%" stopColor="#99f6e4" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx={SIZE / 2} cy={SIZE / 2} r={SIZE * 0.46} fill="url(#lp-sg-glow)" />
      <path d={sphere} fill="url(#lp-sg-sphere)" stroke="rgba(255,255,255,.95)" strokeWidth="1.5" />
      <path d={graticule} fill="none" stroke="rgba(15,118,110,.10)" strokeWidth=".6" />
      {shapes.map((s, i) => (
        <path key={i} d={s.d}
          fill={s.pk ? 'rgba(20,184,166,.6)' : 'rgba(71,107,103,.26)'}
          stroke={s.pk ? '#0f766e' : 'rgba(71,107,103,.38)'} strokeWidth={s.pk ? 1.2 : 0.5} />
      ))}
      {CITIES.map(([ln, la, r], i) => {
        const p = projection([ln, la])
        if (!p) return null
        return (
          <g key={i}>
            <circle cx={p[0]} cy={p[1]} r={r * 2.2} fill={i < 2 ? 'rgba(245,158,11,.28)' : 'rgba(13,148,136,.2)'} />
            <circle cx={p[0]} cy={p[1]} r={r * 0.8} fill={i < 2 ? '#f59e0b' : '#0d9488'} stroke="#fff" strokeWidth=".8" />
          </g>
        )
      })}
      {label && isb && (
        <g transform={`translate(${isb[0]}, ${isb[1] - 22})`}>
          <rect x={-label.length * 3.6 - 10} y={-12} width={label.length * 7.2 + 20} height={22} rx={11} fill="rgba(255,255,255,.95)" stroke="#fcd34d" />
          <text textAnchor="middle" y={4} fill="#92400e" fontSize="12" fontWeight="700" fontFamily="Inter, sans-serif">{label}</text>
        </g>
      )}
    </svg>
  )
}
