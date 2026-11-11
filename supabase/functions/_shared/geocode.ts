// Geocoding + small geo helpers for the report pipeline.
// geocode(): Google Geocoding REST when GOOGLE_GEOCODING_SERVER_KEY is set, else OpenStreetMap Nominatim.
// Results are biased to (and sanity-checked against) Islamabad / Rawalpindi.
import { GEO_BIAS } from './config.ts'

export interface GeoPoint { lat: number; lng: number }
export interface GeocodeResult extends GeoPoint { label: string; source: 'google' | 'nominatim'; query: string }

/** Reject geocoder answers further than this from the twin-cities centre (bounded=0 can return Lahore). */
const MAX_DISTANCE_FROM_BIAS_M = 60_000
const REQUEST_TIMEOUT_MS = 6000
const USER_AGENT = 'Awaaz-hackathon-prototype/1.0'

// ---------------------------------------------------------------------------------------------
// Geo helpers
// ---------------------------------------------------------------------------------------------

/** EWKT literal accepted by PostGIS geography columns through PostgREST. */
export function pointWkt(lat: number, lng: number): string {
  return `SRID=4326;POINT(${lng} ${lat})`
}

export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0)
}

/** Great-circle distance in metres. */
export function distanceM(a: GeoPoint, b: GeoPoint): number {
  const R = 6371008.8
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

/**
 * Parse a PostGIS point as PostgREST returns it: hex (E)WKB string (default), GeoJSON object/string,
 * or (E)WKT text. Returns null when it cannot be parsed.
 */
export function parsePoint(value: unknown): GeoPoint | null {
  if (value == null) return null
  if (typeof value === 'object') {
    const coords = (value as { coordinates?: unknown }).coordinates
    if (Array.isArray(coords) && coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      return { lng: coords[0], lat: coords[1] }
    }
    return null
  }
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (s.startsWith('{')) {
    try {
      return parsePoint(JSON.parse(s))
    } catch {
      return null
    }
  }
  const wkt = /POINT\s*\(\s*(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s*\)/i.exec(s)
  if (wkt) return { lng: Number(wkt[1]), lat: Number(wkt[2]) }
  if (/^[0-9a-fA-F]+$/.test(s) && s.length >= 42) return parseWkbPoint(s)
  return null
}

function parseWkbPoint(hex: string): GeoPoint | null {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  const view = new DataView(bytes.buffer)
  const little = view.getUint8(0) === 1
  const type = view.getUint32(1, little)
  const hasSrid = (type & 0x20000000) !== 0
  if ((type & 0xff) !== 1) return null // not a Point
  const offset = 5 + (hasSrid ? 4 : 0)
  if (bytes.length < offset + 16) return null
  const lng = view.getFloat64(offset, little)
  const lat = view.getFloat64(offset + 8, little)
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null
}

// ---------------------------------------------------------------------------------------------
// Geocoding
// ---------------------------------------------------------------------------------------------

function nearBias(p: GeoPoint): boolean {
  return distanceM(p, { lat: GEO_BIAS.lat, lng: GEO_BIAS.lng }) <= MAX_DISTANCE_FROM_BIAS_M
}

async function googleGeocode(query: string, key: string): Promise<GeocodeResult | null> {
  // GEO_BIAS.viewbox = minLng,maxLat,maxLng,minLat ; Google bounds = swLat,swLng|neLat,neLng
  const [minLng, maxLat, maxLng, minLat] = GEO_BIAS.viewbox.split(',').map(Number)
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
  url.searchParams.set('address', query)
  url.searchParams.set('region', 'pk')
  url.searchParams.set('components', 'country:PK')
  url.searchParams.set('bounds', `${minLat},${minLng}|${maxLat},${maxLng}`)
  url.searchParams.set('key', key)
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!res.ok) {
    console.warn('[geocode] google http', res.status)
    return null
  }
  const body = await res.json() as {
    status: string
    results?: { formatted_address: string; geometry: { location: { lat: number; lng: number } } }[]
  }
  if (body.status !== 'OK' || !body.results?.length) return null
  for (const r of body.results) {
    const p = { lat: r.geometry.location.lat, lng: r.geometry.location.lng }
    if (nearBias(p)) return { ...p, label: r.formatted_address, source: 'google', query }
  }
  return null
}

// Nominatim usage policy: max 1 request per second per client.
let lastNominatimAt = 0

async function nominatimGeocode(query: string): Promise<GeocodeResult | null> {
  const wait = lastNominatimAt + 1050 - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastNominatimAt = Date.now()
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('format', 'json')
  url.searchParams.set('limit', '1')
  url.searchParams.set('countrycodes', 'pk')
  url.searchParams.set('viewbox', GEO_BIAS.viewbox)
  url.searchParams.set('bounded', '0')
  url.searchParams.set('q', query)
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) {
    console.warn('[geocode] nominatim http', res.status)
    return null
  }
  const rows = await res.json() as { lat: string; lon: string; display_name: string }[]
  const r = rows?.[0]
  if (!r) return null
  const p = { lat: Number(r.lat), lng: Number(r.lon) }
  if (!isValidLatLng(p.lat, p.lng) || !nearBias(p)) return null
  return { ...p, label: r.display_name, source: 'nominatim', query }
}

/** Geocode one free-text query (English or Urdu). Never throws. */
export async function geocode(query: string): Promise<GeocodeResult | null> {
  const q = query.trim()
  if (!q) return null
  const key = Deno.env.get('GOOGLE_GEOCODING_SERVER_KEY')?.trim()
  try {
    if (key) {
      const g = await googleGeocode(q, key)
      if (g) return g
    }
    return await nominatimGeocode(q)
  } catch (e) {
    console.warn('[geocode] failed for query', q, e instanceof Error ? e.message : e)
    return null
  }
}

const GENERIC_HINTS = /^(islamabad|rawalpindi|pindi|pakistan|isb|rwp|city|area|street|road|near|here|my area|mohalla)$/i
const CITY_IN_TEXT = /(islamabad|rawalpindi|pindi|اسلام آباد|راولپنڈی|پنڈی)/i
const RAWALPINDI = /(rawalpindi|pindi|راولپنڈی|پنڈی)/i
/** Islamabad sector codes, e.g. G-9, G-9/4, F-7/2, I-8 */
const SECTOR = /\b([D-I])(?:\s*-\s*)?(\d{1,2})(?:\s*\/\s*(\d))?\b/i

function withCity(q: string, context: string): string {
  if (CITY_IN_TEXT.test(q)) return q
  return `${q}, ${RAWALPINDI.test(context) ? 'Rawalpindi' : 'Islamabad'}`
}

/** Candidate queries from the reporter's address text + AI location hints, most specific first. */
export function geocodeQueries(addressText: string | undefined | null, hints: string[] | undefined | null): string[] {
  const address = (addressText ?? '').trim().replace(/^(near|opposite|behind|next to|in front of|outside|at)\s+/i, '')
  const cleanHints = (hints ?? []).map((h) => String(h).trim()).filter((h) => h.length > 1)
  const specific = cleanHints.filter((h) => !GENERIC_HINTS.test(h))
  const context = [address, ...cleanHints].join(' ')
  const out: string[] = []
  const push = (q: string) => {
    const v = q.replace(/\s+/g, ' ').trim()
    if (v && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v)
  }
  if (address) push(withCity(address, context))
  if (specific.length) push(withCity(specific.join(', '), context))
  if (specific.length > 2) push(withCity(specific.slice(-2).join(', '), context))
  const sectorSrc = [address, ...specific].find((h) => SECTOR.test(h))
  if (sectorSrc) {
    const m = SECTOR.exec(sectorSrc)!
    push(`${m[1].toUpperCase()}-${m[2]}${m[3] ? '/' + m[3] : ''}, Islamabad`)
  }
  for (const h of specific) push(withCity(h, context))
  return out
}

/** Try the candidate queries in order; first hit near Islamabad/Rawalpindi wins. Never throws. */
export async function geocodeReport(
  addressText: string | undefined | null,
  hints: string[] | undefined | null,
): Promise<GeocodeResult | null> {
  const hasGoogle = Boolean(Deno.env.get('GOOGLE_GEOCODING_SERVER_KEY')?.trim())
  let queries = geocodeQueries(addressText, hints)
  if (!hasGoogle) {
    // Nominatim is poor at long combined strings but reliable for sector codes: try the sector early
    const sector = queries.find((q) => /^[D-I]-\d{1,2}(\/\d)?, Islamabad$/.test(q))
    if (sector) queries = [...queries.slice(0, 1).filter((q) => q !== sector), sector, ...queries.slice(1).filter((q) => q !== sector)]
  }
  queries = queries.slice(0, hasGoogle ? 5 : 3)
  for (const q of queries) {
    const r = await geocode(q)
    if (r) return r
  }
  return null
}
