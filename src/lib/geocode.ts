// Client-side place search via OpenStreetMap Nominatim (usage policy: on explicit submit only, no autocomplete,
// max ~1 request/second, attribution). Biased to Islamabad / Rawalpindi.
export interface Place { lat: number; lng: number; label: string }

let lastCall = 0

export async function searchPlace(query: string, lang: 'ur' | 'en' = 'en'): Promise<Place | null> {
  const q = query.trim()
  if (!q) return null
  const wait = 1100 - (Date.now() - lastCall)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastCall = Date.now()
  const params = new URLSearchParams({
    q, format: 'jsonv2', limit: '1', countrycodes: 'pk',
    viewbox: '72.80,33.85,73.30,33.45', bounded: '0', 'accept-language': lang === 'ur' ? 'ur,en' : 'en',
  })
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { Accept: 'application/json' } })
    if (!r.ok) return null
    const rows = (await r.json()) as { lat: string; lon: string; display_name: string }[]
    if (!rows.length) return null
    return { lat: Number(rows[0].lat), lng: Number(rows[0].lon), label: rows[0].display_name }
  } catch {
    return null
  }
}
