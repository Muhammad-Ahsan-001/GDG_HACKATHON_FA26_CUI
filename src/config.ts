// Frontend config. Only PUBLIC values (VITE_*) — server secrets live in Supabase Edge Function secrets.
const env = import.meta.env

export const config = {
  supabaseUrl: env.VITE_SUPABASE_URL as string,
  supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY as string,
  /** Map tiles: Leaflet + OpenStreetMap (no key). Swap VITE_MAP_TILE_URL for another provider if traffic grows. */
  tiles: {
    url: (env.VITE_MAP_TILE_URL as string) || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: (env.VITE_MAP_TILE_ATTRIBUTION as string) ||
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  },
  firebase: {
    apiKey: env.VITE_FIREBASE_API_KEY as string,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN as string,
    projectId: env.VITE_FIREBASE_PROJECT_ID as string,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET as string,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID as string,
    appId: env.VITE_FIREBASE_APP_ID as string,
  },
  vapidKey: (env.VITE_FIREBASE_VAPID_KEY as string) || '',
  /** Default map centre: Islamabad */
  defaultCenter: { lat: 33.6844, lng: 73.0479 },
  defaultZoom: 12,
} as const

export const firebaseEnabled = Boolean(config.firebase.apiKey && config.firebase.projectId && config.vapidKey)
