import clsx from 'clsx'
import { Clock, Hand, LayoutDashboard, Package, User, Users, Utensils } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { AttributeMap, ReportAttribute } from '../../lib/attributes'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import type { AssignmentStatus } from '../../lib/types'
import { AiLabel } from '../ui'
import { FoodCountdown } from './FoodCountdown'

const FOOD = CATEGORY_META.food
const MAX_PEOPLE_ICONS = 10

/** First attribute whose key matches (AI keys vary: pickup_window / pickup_time, packaging / packaging_available). */
function findAttr(attrs: AttributeMap | null | undefined, re: RegExp): ReportAttribute | null {
  if (!attrs) return null
  for (const [key, a] of Object.entries(attrs)) if (a && a.value_en && re.test(key)) return a
  return null
}

export interface FoodPanelProps {
  servings: number | null | undefined
  foodType: string | null | undefined
  safeUntil: string | null | undefined
  /** cluster created_at — used for the shrinking time-left bar */
  createdAt?: string | null
  /** intake attributes (pickup window / packaging are shown when present) */
  attributes?: AttributeMap | null
  /** NGO / responder: their organisation's assignment for this food, if any → "Go to dashboard to claim" */
  assignment?: { id: string; status: AssignmentStatus } | null
  className?: string
}

/**
 * Food rescue panel (pin sheet): big servings number with people icons, food type, live safe-to-eat countdown,
 * pickup window / packaging from the intake attributes, and a dashboard CTA for organisations alerted about it.
 */
export function FoodPanel({ servings, foodType, safeUntil, createdAt, attributes, assignment, className }: FoodPanelProps) {
  const { t, pick } = useI18n()
  const nav = useNavigate()

  const typeAttr = foodType ? null : findAttr(attributes, /^food_?type$/i)
  const servingsAttr = servings == null ? findAttr(attributes, /serving|people_fed|portions/i) : null
  const pickup = findAttr(attributes, /pick_?up/i)
  const packaging = findAttr(attributes, /packag/i)
  const type = foodType || (typeAttr ? pick(typeAttr.value_en, typeAttr.value_ur) : '')
  const n = servings != null && servings > 0 ? Math.round(servings) : null
  const showCta = Boolean(assignment && assignment.status !== 'resolved')

  if (n == null && !servingsAttr && !type && !safeUntil && !pickup && !packaging && !showCta) return null

  return (
    <section
      aria-label={t('alerts.food_title')}
      className={clsx('flex flex-col gap-3 rounded-3xl border-2 bg-white p-3', className)}
      style={{ borderColor: FOOD.soft }}
    >
      <div className="flex items-center gap-2">
        <Utensils className="size-5 shrink-0" style={{ color: FOOD.color }} aria-hidden />
        <h3 className="text-base font-bold text-ink">{t('alerts.food_title')}</h3>
        {/* servings / food type / safe time are estimated by the AI from the report (and photo) */}
        <AiLabel className="ms-auto" />
      </div>

      {(n != null || servingsAttr || type) && (
        <div className="flex items-center gap-3 rounded-2xl p-3" style={{ background: FOOD.soft }}>
          <span className="inline-flex size-14 shrink-0 items-center justify-center rounded-full text-white" style={{ background: FOOD.color }} aria-hidden>
            <Users className="size-8" />
          </span>
          <div className="min-w-0 flex-1">
            {n != null ? (
              <div className="flex flex-wrap items-baseline gap-x-2" aria-label={t('alerts.food_servingsAria', { n })}>
                <span className="font-latin text-5xl leading-none font-black tabular-nums" style={{ color: FOOD.color }}>{n}</span>
                <span className="text-base font-bold text-slate-700">{t('alerts.food_peopleCanEat')}</span>
              </div>
            ) : servingsAttr ? (
              <div className="text-xl font-black" style={{ color: FOOD.color }}>{pick(servingsAttr.value_en, servingsAttr.value_ur)}</div>
            ) : null}
            {n != null && (
              <div className="mt-1.5 flex flex-wrap items-center gap-0.5" style={{ color: FOOD.color }} aria-hidden>
                {Array.from({ length: Math.min(n, MAX_PEOPLE_ICONS) }, (_, i) => <User key={i} className="size-4" strokeWidth={2.6} />)}
                {n > MAX_PEOPLE_ICONS && <span className="font-latin ms-0.5 text-xs font-black">+</span>}
              </div>
            )}
            {type && (
              <div className="mt-1.5 inline-flex max-w-full items-center gap-1 rounded-full bg-white px-2.5 py-0.5 text-sm font-semibold text-ink">
                <Utensils className="size-4 shrink-0" style={{ color: FOOD.color }} aria-hidden />
                <span className="truncate">{type}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {safeUntil && <FoodCountdown until={safeUntil} from={createdAt} />}

      {(pickup || packaging) && (
        <ul className="flex flex-col gap-1.5">
          {pickup && (
            <DetailRow icon={Clock} label={t('alerts.food_pickup')} value={pick(pickup.value_en, pickup.value_ur)} />
          )}
          {packaging && (
            <DetailRow icon={Package} label={t('alerts.food_packaging')} value={pick(packaging.value_en, packaging.value_ur)} />
          )}
        </ul>
      )}

      {showCta && assignment && (
        <button
          type="button"
          onClick={() => nav('/dashboard', { state: { assignmentId: assignment.id } })}
          className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl px-4 text-lg font-bold text-white shadow-sm transition active:scale-[0.98]"
          style={{ background: FOOD.color }}
        >
          {assignment.status === 'alerted' ? <Hand className="size-6" /> : <LayoutDashboard className="size-6" />}
          {assignment.status === 'alerted' ? t('alerts.food_claimCta') : t('alerts.food_openCta')}
        </button>
      )}
    </section>
  )
}

function DetailRow({ icon: Icon, label, value }: { icon: typeof Clock; label: string; value: string }) {
  return (
    <li className="flex items-center gap-2 rounded-xl bg-slate-50 px-2.5 py-2 text-sm">
      <Icon className="size-5 shrink-0" style={{ color: FOOD.color }} aria-hidden />
      <span className="font-semibold text-slate-600">{label}</span>
      <span className="min-w-0 flex-1 font-bold text-ink">{value}</span>
    </li>
  )
}

/** One-line food summary for cards (dashboard AssignmentCard, alerts): servings pill + type + countdown pill. */
export function FoodLine({ servings, foodType, safeUntil, showCountdown = true, className }: {
  servings: number | null | undefined
  foodType: string | null | undefined
  safeUntil: string | null | undefined
  /** false once the food was handed over (resolved) */
  showCountdown?: boolean
  className?: string
}) {
  const { t } = useI18n()
  const n = servings != null && servings > 0 ? Math.round(servings) : null
  if (n == null && !foodType && !(showCountdown && safeUntil)) return null
  return (
    <div className={clsx('flex flex-wrap items-center gap-1.5 text-sm', className)}>
      {(n != null || foodType) && (
        <span className="inline-flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 font-semibold" style={{ background: FOOD.soft, color: FOOD.color }}>
          <Users className="size-4 shrink-0" aria-hidden />
          {n != null && (
            <span aria-label={t('alerts.food_servingsAria', { n })}>
              <span className="font-latin font-black">{n}</span> {t('alerts.food_people')}
            </span>
          )}
          {foodType && <span className="truncate font-normal text-slate-700">{n != null ? '· ' : ''}{foodType}</span>}
        </span>
      )}
      {showCountdown && safeUntil && <FoodCountdown until={safeUntil} variant="pill" />}
    </div>
  )
}
