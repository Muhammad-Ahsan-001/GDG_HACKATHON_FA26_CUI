// Frontend config. Only PUBLIC values (VITE_*) — server secrets live in Supabase Edge Function secrets.
const env = import.meta.env

export const config = {
  supabaseUrl: env.VITE_SUPABASE_URL as string,
  supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY as string,
  mapsApiKey: (env.VITE_GOOGLE_MAPS_API_KEY as string) || '',
  mapId: (env.VITE_GOOGLE_MAP_ID as string) || 'DEMO_MAP_ID',
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
