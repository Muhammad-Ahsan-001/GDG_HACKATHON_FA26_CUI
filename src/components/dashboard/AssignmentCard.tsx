import clsx from 'clsx'
import {
  CheckCheck, Clock, Hand, Hourglass, Loader2, MapPin, Navigation, Play, Building2, TriangleAlert, type LucideIcon,
} from 'lucide-react'
import { memo, type CSSProperties } from 'react'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { ASSIGNMENT_META, STATUS_META } from '../../lib/status'
import type { AssignmentStatus } from '../../lib/types'
import { UserUrgencyBadge } from '../map/UserUrgencyBadge'
import { AttributeChips } from '../report/AttributeChips'
import { AiLabel, CategoryIcon, StatusBadge, UrgencyBadge, useTimeAgo } from '../ui'
import type { AssignmentActionKind, DashAssignment } from './types'
import { directionsUrl, formatCountdown, formatDuration, formatKm, useNow } from './utils'

/** "5 min ago", re-rendered by a shared 30 s ticker. */
export function TimeAgo({ iso, className }: { iso: string | null | undefined; className?: string }) {
  useNow(30_000)
  const ago = useTimeAgo()
  return <span className={className}>{ago(iso)}</span>
}

/** Food: servings + live countdown to safe_until. */
function FoodLine({ a }: { a: DashAssignment }) {
  const { t } = useI18n()
  const until = a.safe_until ? new Date(a.safe_until).getTime() : null
  const now = useNow(1000, until !== null && a.status !== 'resolved')
  const left = until !== null ? until - now : null
  const expired = left !== null && left <= 0
  const color = left === null ? '#475569' : expired || left < 30 * 60_000 ? '#DC2626' : left < 60 * 60_000 ? '#B45309' : '#15803D'
  const FoodIcon = CATEGORY_META.food.icon
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
      {a.food_servings != null && (
        <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold"
          style={{ background: CATEGORY_META.food.soft, color: CATEGORY_META.food.color }}>
          <FoodIcon className="size-4" />
          {t('dashboard.servings', { n: a.food_servings })}
          {a.food_type ? <span className="font-normal">· {a.food_type}</span> : null}
        </span>
      )}
      {left !== null && a.status !== 'resolved' && (
        <span className="inline-flex items-center gap-1 rounded-full border-2 px-2 py-0.5 font-bold" style={{ borderColor: color, color }}
          role="timer" aria-live="off">
          <Hourglass className="size-4" />
          {expired ? t('dashboard.foodExpired') : t('dashboard.safeFor', { time: formatCountdown(left, t) })}
        </span>
      )}
    </div>
  )
}

const NEXT_ACTION: Record<Exclude<AssignmentStatus, 'resolved'>, { action: AssignmentActionKind; icon: LucideIcon; key: string; to: AssignmentStatus }> = {
  alerted: { action: 'claim', icon: Hand, key: 'dashboard.claim', to: 'claimed' },
  claimed: { action: 'start', icon: Play, key: 'dashboard.start', to: 'in_progress' },
  in_progress: { action: 'resolve', icon: CheckCheck, key: 'dashboard.resolve', to: 'resolved' },
}

export interface AssignmentCardProps {
  a: DashAssignment
  selected?: boolean
  highlighted?: boolean
  pending?: boolean
  /** show which organisation the alert went to (admin / multi-org view) */
  showOrg?: boolean
  onSelect: (a: DashAssignment) => void
  onAction: (a: DashAssignment, action: AssignmentActionKind) => void
}

function AssignmentCardImpl({ a, selected, highlighted, pending, showOrg, onSelect, onAction }: AssignmentCardProps) {
  const { t, pick, lang } = useI18n()
  const cat = CATEGORY_META[a.category] ?? CATEGORY_META.other
  const statusMeta = ASSIGNMENT_META[a.status] ?? ASSIGNMENT_META.alerted
  const title = pick(a.title_en, a.title_ur) || (lang === 'ur' ? cat.ur : cat.en)
  const summary = pick(a.summary_en, a.summary_ur)
  const pct = Math.round((a.confidence ?? 0) * 100)
  const km = formatKm(a.distance_m, t)
  const isFood = a.category === 'food' || a.food_servings != null || a.safe_until != null
  const claimedByOther = Boolean(a.claimed_org_id && a.claimed_org_id !== a.org_id && a.claimed_org_name)

  const cardStyle: CSSProperties = { borderInlineStartColor: statusMeta.color }

  return (
    <article
      id={`dash-card-${a.assignment_id}`}
      className={clsx(
        'awaaz-dash-card overflow-hidden rounded-2xl border border-s-[6px] border-slate-200 bg-white shadow-sm transition-shadow',
        selected && 'ring-2 ring-brand-700',
        highlighted && 'awaaz-dash-new',
      )}
      style={cardStyle}
    >
      <button
        type="button"
        onClick={() => onSelect(a)}
        aria-pressed={selected}
        className="flex w-full gap-3 p-3 text-start hover:bg-slate-50/60"
      >
        <CategoryIcon category={a.category} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <span className={clsx('block flex-1 font-bold leading-snug text-ink', !selected && 'line-clamp-2')}>{title}</span>
            <UrgencyBadge urgency={a.urgency} className="mt-0.5 shrink-0" />
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={a.cluster_status} count={a.report_count} />
            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold text-white"
              style={{ background: statusMeta.color }}>
              {lang === 'ur' ? statusMeta.ur : statusMeta.en}
            </span>
            <UserUrgencyBadge value={a.user_urgency} size="sm" />
            {highlighted && (
              <span className="awaaz-dash-blink inline-flex items-center rounded-full bg-red-600 px-2 py-0.5 text-xs font-black text-white">
                {t('dashboard.newBadge')}
              </span>
            )}
          </div>

          {/* what the reporter told the intake AI — danger first */}
          <AttributeChips attributes={a.attributes} compact max={5} className="mt-2" />

          {a.cluster_status === 'unconfirmed' && (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg border-2 border-red-600 bg-red-50 px-2 py-1 text-xs font-extrabold text-red-700">
              <TriangleAlert className="size-4 shrink-0" />
              <span>{t('dashboard.unconfirmedEarly')}</span>
            </div>
          )}

          <div className="mt-2 flex min-w-0 items-center gap-1.5 text-sm text-slate-600">
            <AiLabel className="shrink-0" />
            <span className="font-latin shrink-0 font-semibold text-violet-700">{pct}%</span>
            {a.ai_reason && <span className={clsx('min-w-0', !selected && 'truncate')}>{a.ai_reason}</span>}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
            {km && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-4" /> <span className="font-latin">{km}</span>
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Clock className="size-4" /> <TimeAgo iso={a.alerted_at} />
            </span>
            {showOrg && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <Building2 className="size-4 shrink-0" /> <span className="truncate">{a.org_name}</span>
              </span>
            )}
          </div>

          {isFood && <FoodLine a={a} />}
        </div>

        {a.photo_url && !selected && (
          <img
            src={a.photo_url}
            alt=""
            loading="lazy"
            decoding="async"
            width={76}
            height={76}
            className="size-[76px] shrink-0 rounded-xl bg-slate-100 object-cover"
          />
        )}
      </button>

      {selected && (
        <div className="space-y-2 px-3 pb-1">
          {a.photo_url && (
            <img src={a.photo_url} alt="" loading="lazy" decoding="async"
              className="max-h-64 w-full rounded-xl bg-slate-100 object-cover" />
          )}
          {summary && (
            <p className="text-sm text-slate-700">
              <AiLabel className="me-1.5 align-middle" />
              {summary}
            </p>
          )}
          {a.address_text && (
            <p className="flex items-start gap-1.5 text-sm text-slate-600">
              <MapPin className="mt-0.5 size-4 shrink-0" /> {a.address_text}
            </p>
          )}
        </div>
      )}

      {claimedByOther && a.status !== 'resolved' && (
        <p className="mx-3 mb-1 rounded-lg bg-amber-50 px-2 py-1 text-sm font-semibold text-amber-800">
          {t('dashboard.claimedByOther', { org: a.claimed_org_name ?? '' })}
        </p>
      )}

      <AssignmentActions a={a} pending={pending} onAction={onAction} />
    </article>
  )
}

/** Claim → Start work → Mark resolved (one big button for the next step) + directions. */
export function AssignmentActions({ a, pending, onAction, to }: {
  a: DashAssignment
  pending?: boolean
  onAction: (a: DashAssignment, action: AssignmentActionKind) => void
  /** directions target (SOS: the live location) — defaults to the incident point */
  to?: { lat: number; lng: number } | null
}) {
  const { t } = useI18n()
  const next = a.status === 'resolved' ? null : NEXT_ACTION[a.status]
  const nextColor = next ? ASSIGNMENT_META[next.to].color : undefined
  const resolvedIn = a.status === 'resolved' && a.resolved_at
    ? formatDuration(new Date(a.resolved_at).getTime() - new Date(a.alerted_at).getTime(), t)
    : null
  return (
    <div className="flex items-stretch gap-2 p-3 pt-2">
      {next ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => onAction(a, next.action)}
          className="inline-flex min-h-14 flex-1 items-center justify-center gap-2 rounded-2xl px-4 text-lg font-bold text-white shadow-sm transition active:scale-[0.98] disabled:opacity-60"
          style={{ background: nextColor }}
        >
          {pending ? <Loader2 className="size-6 animate-spin" /> : <next.icon className="size-6" />}
          {t(next.key)}
        </button>
      ) : (
        <div className="inline-flex min-h-14 flex-1 items-center gap-2 rounded-2xl px-3 font-bold"
          style={{ background: STATUS_META.resolved.soft, color: ASSIGNMENT_META.resolved.color }}>
          <CheckCheck className="size-6 shrink-0" />
          <span className="min-w-0">
            {resolvedIn ? t('dashboard.resolvedIn', { time: resolvedIn }) : t('dashboard.resolvedLabel')}
            {a.resolved_at && <TimeAgo iso={a.resolved_at} className="block text-xs font-medium opacity-80" />}
          </span>
        </div>
      )}
      <a
        href={directionsUrl(to?.lat ?? a.lat, to?.lng ?? a.lng)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('dashboard.directions')}
        title={t('dashboard.directions')}
        className="inline-flex size-14 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-white text-brand-700 hover:bg-slate-50"
      >
        <Navigation className="size-6" />
      </a>
    </div>
  )
}

/** One alert card. Memoised — re-renders only when its row or flags change. */
export const AssignmentCard = memo(AssignmentCardImpl)
