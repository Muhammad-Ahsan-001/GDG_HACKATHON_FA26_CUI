// All tunable thresholds in one place (model IDs live in ./models.ts).

/** Duplicate matching: same category, within this radius and time window... */
export const DUP_RADIUS_M = 300
export const DUP_WINDOW_HOURS = 6
/** ...attach when embedding cosine similarity >= this */
export const DUP_SIM_THRESHOLD = 0.85
/** gray zone [DUP_GRAY_ZONE_MIN, DUP_SIM_THRESHOLD): ask the LLM "same incident?" */
export const DUP_GRAY_ZONE_MIN = 0.72

/** cluster becomes 'verified' at/above this confidence */
export const VERIFY_THRESHOLD = 0.7
/** final confidence = AI score clamped to heuristic ± this */
export const VERIFY_AI_CLAMP = 0.15

/** nearby-citizen alerts radius */
export const NEARBY_RADIUS_M = 1000
/** max organisations alerted per cluster */
export const ROUTE_MAX_ORGS = 3
/** food rescue default shelf life when AI gives none */
export const FOOD_DEFAULT_SAFE_HOURS = 4

/** AI call timeouts (ms) before falling back to the secondary model */
export const AI_TIMEOUT_MS = { transcribe: 45000, extract: 30000, vision: 30000, embed: 15000, verify: 20000, tts: 30000, digest: 25000 }

/** Geocoding bias: Islamabad / Rawalpindi */
export const GEO_BIAS = { lat: 33.6844, lng: 73.0479, viewbox: '72.80,33.85,73.30,33.45' /* minLng,maxLat,maxLng,minLat */ }

export const APP_URL = Deno.env.get('APP_URL') ?? 'http://localhost:5173'
