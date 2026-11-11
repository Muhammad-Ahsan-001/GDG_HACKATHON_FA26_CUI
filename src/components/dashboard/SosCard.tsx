import clsx from 'clsx'
import { Building2, Crosshair, Headphones, MapPin, ShieldCheck, Siren, TriangleAlert, X } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import { USER_URGENCY_META, type AttributeMap } from '../../lib/attributes'
import { useI18n } from '../../lib/i18n'
import type { SosStatus } from '../../lib/sos'
import { STATUS_META } from '../../lib/status'
import { AttributeChips } from '../report/AttributeChips'
import { AiLabel, useTimeAgo } from '../ui'
import { AssignmentActions } from './AssignmentCard'
import { SosEvidence } from './SosEvidence'
import type { AssignmentActionKind, DashAssignment } from './types'
import { isLocationFresh, type SosLive } from './useSosLive'
import { formatDuration, formatKm, useNow } from './utils'

/** SOS red = the shared "emergency" colour. */
export const SOS_RED = USER_URGENCY_META.emergency.color

const LRI = String.fromCharCode(0x2066)
const PDI = String.fromCharCode(0x2069)

const SESSION_CHIP: Record<SosStatus, { bg: string; fg: string; key: string; live?: boolean }> = {
  monitoring: { bg: '#fff', fg: SOS_RED, key: 'dashboard.sosStatus_monitoring', live: true },
  alerted: { bg: '#fff', fg: SOS_RED, key: 'dashboard.sosStatus_alerted', live: true },
  safe: { bg: STATUS_META.verified.soft, fg: STATUS_META.verified.color, key: 'dashboard.sosStatus_safe' },
  cancelled: { bg: STATUS_META.disputed.soft, fg: STATUS_META.disputed.color, key: 'dashboard.sosStatus_cancelled' },
  resolved: { bg: STATUS_META.resolved.soft, fg: STATUS_META.resolved.color, key: 'dashboard.sosStatus_resolved' },
}

/** Ticking "Alert sent 03:12 ago" (mm:ss for the first hour). */
function Elapsed({ since, running }: { since: string; running: boolean }) {
  const { t } = useI18n()
  const now = useNow(1000, running)
  const ms = Math.max(0, now - new Date(since).getTime())
  const s = Math.floor(ms / 1000)
  const time = ms < 3600_000
    ? `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : formatDuration(ms, t)
  return (
    <p className="flex items-center gap-2 text-base font-extrabold" style={{ color: SOS_RED }} role="timer" aria-live="off">
      <TriangleAlert className="size-5 shrink-0" />
      <span>{t('dashboard.sosSince', { time: LRI + time + PDI })}</span>
    </p>
  )
}

/** "12 s ago" for live positions (seconds matter here). */
function FreshAgo({ iso }: { iso: string }) {
  const { t } = useI18n()
  const timeAgo = useTimeAgo()
  const now = useNow(5000)
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  return <span>{s < 60 ? t('dashboard.secondsAgo', { n: s }) : timeAgo(iso)}</span>
}

function LiveLocation({ a, live }: { a: DashAssignment; live: SosLive | undefined }) {
  const { t } = useI18n()
  const now = useNow(5000)
  const fresh = isLocationFresh(live, now)
  const km = formatKm(a.distance_m, t)
  if (!live || live.lat == null || !live.last_location_at) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-amber-50 p-2 text-sm font-semibold text-amber-900">
        <MapPin className="size-5 shrink-0" />
        <span className="min-w-0">{t('dashboard.sosNoLocation')}</span>
      </div>
    )
  }
  const acc = live.last_accuracy_m != null ? Math.round(live.last_accuracy_m) : null
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-slate-50 p-2 text-sm text-slate-700">
      <span className="relative inline-flex size-3 shrink-0">
        {fresh && <span className="absolute inset-0 animate-ping rounded-full bg-green-500 opacity-70" />}
        <span className={clsx('relative inline-flex size-3 rounded-full', fresh ? 'bg-green-600' : 'bg-slate-400')} />
      </span>
      <span className="font-bold text-ink">{fresh ? t('dashboard.sosLive') : t('dashboard.sosLastKnown')}</span>
      <span>· <FreshAgo iso={live.last_location_at} /></span>
      {acc != null && <span className="font-latin">· {t('dashboard.sosAccuracy', { m: acc })}</span>}
      {km && <span className="inline-flex items-center gap-1">· <MapPin className="size-4" /> <span className="font-latin">{km}</span></span>}
    </div>
  )
}

export interface SosCardProps {
  a: DashAssignment
  live: SosLive | undefined
  selected?: boolean
  highlighted?: boolean
  pending?: boolean
  following?: boolean
  showOrg?: boolean
  onSelect: (a: DashAssignment) => void
  onAction: (a: DashAssignment, action: AssignmentActionKind) => void
  onFollow: (a: DashAssignment) => void
  /** any touch on the card silences the repeating SOS alarm */
  onAck?: (a: DashAssignment) => void
}

/**
 * Women's-safety SOS alert for police: red, pinned at the top of the list. Live location (Realtime),
 * time since the alert, AI threat reason + heard phrases, follow-on-map, police-only audio evidence,
 * and the normal claim / start / resolve flow.
 */
function SosCardImpl({ a, live, selected, highlighted, pending, following, showOrg, onSelect, onAction, onFollow, onAck }: SosCardProps) {
  const { t, pick } = useI18n()
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const done = a.status === 'resolved'
  const status: SosStatus = live?.status ?? (done ? 'resolved' : 'alerted')
  const chip = SESSION_CHIP[done ? 'resolved' : status] ?? SESSION_CHIP.alerted
  const sessionEnded = status === 'safe' || status === 'cancelled'
  const title = pick(a.title_en, a.title_ur) || t('dashboard.sosTitle')
  const reason = pick(a.summary_en, a.summary_ur) || live?.threat_reason || a.ai_reason
  const alertedAt = live?.alerted_at ?? a.alerted_at
  const livePoint = live && live.lat != null && live.lng != null ? { lat: live.lat, lng: live.lng } : null
  const claimedByOther = Boolean(a.claimed_org_id && a.claimed_org_id !== a.org_id && a.claimed_org_name)

  // the static "live_location" attribute is a snapshot from the moment of escalation — the live row replaces it
  const attrs = useMemo<AttributeMap | null>(() => (a.attributes
    ? Object.fromEntries(Object.entries(a.attributes).filter(([k]) => k !== 'live_location'))
    : null), [a.attributes])

  return (
    <article
      id={`dash-card-${a.assignment_id}`}
      onPointerDown={() => onAck?.(a)}
      className={clsx(
        'awaaz-dash-card overflow-hidden rounded-2xl border-2 bg-white shadow-md',
        selected && 'ring-4 ring-red-200',
        highlighted && 'awaaz-dash-new',
        done && 'opacity-90',
      )}
      style={{ borderColor: done ? STATUS_META.resolved.color : SOS_RED }}
    >
      <button
        type="button"
        onClick={() => onSelect(a)}
        aria-pressed={selected}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-start text-white"
        style={{ background: done ? STATUS_META.resolved.color : SOS_RED }}
      >
        <span className="relative inline-flex size-12 shrink-0 items-center justify-center rounded-full bg-white"
          style={{ color: done ? STATUS_META.resolved.color : SOS_RED }}>
          {!done && !sessionEnded && <span aria-hidden className="awaaz-dash-ping absolute inset-0 rounded-full bg-white/70" />}
          {done ? <ShieldCheck className="relative size-7" /> : <Siren className="relative size-7" strokeWidth={2.4} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-latin text-2xl leading-none font-black tracking-wider">{t('dashboard.sosLabel')}</span>
            {highlighted && (
              <span className="awaaz-dash-blink rounded-full bg-white px-2 py-0.5 text-xs font-black" style={{ color: SOS_RED }}>
                {t('dashboard.newBadge')}
              </span>
            )}
          </span>
          <span className={clsx('mt-0.5 block text-sm font-bold opacity-95', !selected && 'truncate')}>{title}</span>
        </span>
        <span
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-black"
          style={{ background: chip.bg, color: chip.fg }}
        >
          {chip.live && !done && <span aria-hidden className="awaaz-dash-blink size-2 rounded-full" style={{ background: chip.fg }} />}
          {t(chip.key)}
        </span>
      </button>

      <div className="space-y-2 p-3">
        {!done && <Elapsed since={alertedAt} running={!sessionEnded} />}

        {reason && (
          <p className={clsx('text-sm text-slate-800', !selected && 'line-clamp-3')}>
            <AiLabel className="me-1.5 align-middle" />
            {reason}
          </p>
        )}

        <AttributeChips attributes={attrs} compact max={5} />

        {!done && <LiveLocation a={a} live={live} />}

        {sessionEnded && !done && (
          <p className="flex items-center gap-2 rounded-xl p-2 text-sm font-bold"
            style={{ background: chip.bg, color: chip.fg }}>
            {status === 'safe' ? <ShieldCheck className="size-5 shrink-0" /> : <X className="size-5 shrink-0" />}
            {status === 'safe' ? t('dashboard.sosEndedSafe') : t('dashboard.sosEndedCancelled')}
          </p>
        )}

        {showOrg && (
          <p className="flex min-w-0 items-center gap-1 text-sm text-slate-500">
            <Building2 className="size-4 shrink-0" /> <span className="truncate">{a.org_name}</span>
          </p>
        )}

        {a.sos_session_id && (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              aria-pressed={following}
              onClick={() => onFollow(a)}
              className={clsx(
                'inline-flex min-h-12 items-center justify-center gap-1.5 rounded-2xl border-2 px-2 text-sm font-bold transition active:scale-[0.98]',
                following ? 'border-transparent text-white' : 'bg-white text-ink',
              )}
              style={following ? { background: SOS_RED } : { borderColor: `${SOS_RED}55` }}
            >
              <Crosshair className="size-5 shrink-0" />
              <span className="truncate">{following ? t('dashboard.sosFollowing') : t('dashboard.sosFollow')}</span>
            </button>
            <button
              type="button"
              aria-expanded={evidenceOpen}
              onClick={() => setEvidenceOpen((o) => !o)}
              className={clsx(
                'inline-flex min-h-12 items-center justify-center gap-1.5 rounded-2xl px-2 text-sm font-bold transition active:scale-[0.98]',
                evidenceOpen ? 'bg-slate-200 text-ink' : 'bg-ink text-white',
              )}
            >
              <Headphones className="size-5 shrink-0" />
              <span className="truncate">{evidenceOpen ? t('dashboard.sosEvidenceHide') : t('dashboard.sosEvidence')}</span>
            </button>
          </div>
        )}
      </div>

      {evidenceOpen && a.sos_session_id && (
        <SosEvidence sessionId={a.sos_session_id} refreshKey={`${live?.threat_level ?? ''}|${live?.threat_reason ?? ''}|${status}`} />
      )}

      {claimedByOther && !done && (
        <p className="mx-3 mb-1 rounded-lg bg-amber-50 px-2 py-1 text-sm font-semibold text-amber-800">
          {t('dashboard.claimedByOther', { org: a.claimed_org_name ?? '' })}
        </p>
      )}

      <AssignmentActions a={a} pending={pending} onAction={onAction} to={livePoint} />
    </article>
  )
}

export const SosCard = memo(SosCardImpl)
