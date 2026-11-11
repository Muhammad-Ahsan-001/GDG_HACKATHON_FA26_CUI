// SOS (women's safety) shared types — mirrors the `sos` Edge Function (docs/CONTRACT-1B.md §SOS).
export type SosTrigger = 'button' | 'volume' | 'shake' | 'shortcut'
export type SosStatus = 'monitoring' | 'alerted' | 'safe' | 'cancelled' | 'resolved'
export type ThreatLevel = 'none' | 'possible' | 'high'

export interface SosSession {
  id: string
  user_id: string
  trigger: SosTrigger
  status: SosStatus
  started_at: string
  ended_at: string | null
  alerted_at: string | null
  threat_level: ThreatLevel
  threat_reason: string | null
  transcript: string | null
  cluster_id: string | null
  lat: number | null
  lng: number | null
  created_at: string
}

export type SosRequest =
  | { action: 'start'; session_id: string; trigger: SosTrigger; lat?: number; lng?: number; accuracy_m?: number }
  | { action: 'chunk'; session_id: string; seq: number; audio_path: string; lat?: number; lng?: number }
  | { action: 'alert'; session_id: string; lat?: number; lng?: number }
  | { action: 'location'; session_id: string; lat: number; lng: number; accuracy_m?: number }
  | { action: 'end'; session_id: string; outcome: 'safe' | 'cancelled' }
  | { action: 'evidence'; session_id: string }

export interface SosResponse {
  session_id: string
  status: SosStatus
  threat_level: ThreatLevel
  alerted: boolean
  /** police organisations alerted (when alerted) */
  routed?: { org_name: string; org_type: string; distance_m: number }[]
  transcript?: string            // this chunk
  no_speech?: boolean
  reason_en?: string
  reason_ur?: string
  /** action 'evidence' (police only): signed URLs of the recorded chunks */
  evidence?: { seq: number; url: string; transcript: string | null; threat_level: ThreatLevel; created_at: string }[]
}

/** Seconds per self-contained audio chunk while SOS is listening. */
export const SOS_CHUNK_SECONDS = 8
