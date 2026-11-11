// Lazy chunk: the hero's live Leaflet map of Islamabad/Rawalpindi with real pins popping in one by one.
// Plain Leaflet (no react-leaflet / clustering): a showcase, so it is non-interactive and stays light.
import L from 'leaflet'
import { useEffect, useRef } from 'react'
import { config } from '../../config'
import { URGENCY_META } from '../../lib/categories'
import { pinIcon } from '../leaflet/icons'
import '../leaflet/leaflet.css'
import type { LandingPin } from './shared'

const CENTER: [number, number] = [33.64, 73.06]

export default function LiveMap({ pins, play, onReady }: {
  pins: LandingPin[] | null
  /** start popping pins in */
  play: boolean
  /** first tiles painted (or gave up) */
  onReady?: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const readyRef = useRef(onReady)
  readyRef.current = onReady

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const map = L.map(host, {
      zoomControl: false,
      attributionControl: true,
      dragging: false,
      touchZoom: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      fadeAnimation: false,
      zoomSnap: 0.25,
    }).setView(CENTER, window.innerWidth < 640 ? 11 : 11.75)
    map.attributionControl.setPrefix(false)
    let sent = false
    const ready = () => { if (!sent) { sent = true; readyRef.current?.() } }
    const tiles = L.tileLayer(config.tiles.url, { attribution: config.tiles.attribution, maxZoom: 19, detectRetina: false, keepBuffer: 1 })
    tiles.once('load', ready)
    tiles.addTo(map)
    const timer = window.setTimeout(ready, 3500)
    mapRef.current = map
    const ro = new ResizeObserver(() => map.invalidateSize({ animate: false }))
    ro.observe(host)
    return () => {
      window.clearTimeout(timer)
      ro.disconnect()
      map.remove()
      mapRef.current = null
    }
  }, [])

  // frame the real pins
  useEffect(() => {
    const map = mapRef.current
    if (!map || !pins || pins.length < 2) return
    const b = L.latLngBounds(pins.map((p) => [p.lat, p.lng] as [number, number]))
    map.fitBounds(b, { padding: [36, 36], maxZoom: 13, animate: false })
  }, [pins])

  // pop pins in one by one, rippling out from the centre
  useEffect(() => {
    const map = mapRef.current
    if (!map || !play || !pins?.length) return
    const c = map.getCenter()
    const order = [...pins].sort((a, b) => ((a.lat - c.lat) ** 2 + (a.lng - c.lng) ** 2) - ((b.lat - c.lat) ** 2 + (b.lng - c.lng) ** 2))
    const step = Math.min(160, 2600 / order.length)
    const layer = L.layerGroup().addTo(map)
    const timers = order.map((p, i) => window.setTimeout(() => {
      const icon = pinIcon({
        category: p.category, status: p.status, urgency: p.urgency, count: p.report_count,
        pulse: p.status !== 'resolved' && (p.urgency === 'critical' || p.urgency === 'high'),
      })
      const marker = L.marker([p.lat, p.lng], {
        icon, interactive: false, keyboard: false, zIndexOffset: (URGENCY_META[p.urgency]?.rank ?? 0) * 100,
      }).addTo(layer)
      marker.getElement()?.classList.add('lp-pop')
    }, 250 + i * step))
    return () => { timers.forEach((t) => window.clearTimeout(t)); layer.remove() }
  }, [play, pins])

  return <div ref={hostRef} className="absolute inset-0" />
}
