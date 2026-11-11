// Live map of EVERY pin (incl. private SOS clusters, resolved on demand). Lazy-loaded: pulls in Leaflet.
import L from 'leaflet'
import { FileText, Lock, Map as MapIcon, ThumbsDown, ThumbsUp, Users, X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useMemo, useState } from 'react'
import { adminApi, type AdminCluster } from '../../lib/adminApi'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { STATUS_META } from '../../lib/status'
import { CATEGORIES, type Category, type ReportStatus } from '../../lib/types'
import { BaseMap, ClusterLayer, FlyTo, InvalidateOnResize, type ClusterItem } from '../leaflet/BaseMap'
import { pinIcon } from '../leaflet/icons'
import { AttributeChips } from '../report/AttributeChips'
import { AiLabel, CategoryIcon, StatusBadge, UrgencyBadge, useTimeAgo } from '../ui'
import { useAdmin, useAsync } from './context'
import { Chip, Confidence, ErrorState, PanelHeader, Select, Skeleton, Switch } from './parts'

const STATUSES: ReportStatus[] = ['unconfirmed', 'verified', 'disputed', 'in_progress', 'resolved']

const sosIconCache = new Map<string, L.DivIcon>()
function adminPinIcon(c: AdminCluster, selected: boolean): L.DivIcon {
  const base = pinIcon({ category: c.category, status: c.status, urgency: c.urgency, count: c.report_count, selected, pulse: c.urgency === 'critical' && c.status !== 'resolved' })
  if (!c.is_private) return base
  const key = `${c.category}|${c.status}|${c.urgency}|${c.report_count}|${selected}`
  let icon = sosIconCache.get(key)
  if (!icon) {
    icon = L.divIcon({ ...base.options, className: 'awz-pin-wrap adm-sos-pin' })
    sosIconCache.set(key, icon)
  }
  return icon
}

function PinCard({ c, onClose }: { c: AdminCluster; onClose: () => void }) {
  const { t, pick, lang } = useI18n()
  const { go, toast, refresh } = useAdmin()
  const ago = useTimeAgo()
  const [busy, setBusy] = useState(false)
  const setStatus = async (s: ReportStatus) => {
    setBusy(true)
    try {
      await adminApi.setClusterStatus(c.id, s)
      toast(t('admin.statusToast', { status: lang === 'ur' ? STATUS_META[s].ur : STATUS_META[s].en }))
      refresh()
    } catch (e) {
      toast(`${t('admin.saveFailed')}: ${(e as Error).message}`, 'error')
    } finally { setBusy(false) }
  }
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200">
      {c.photo_url && <img src={c.photo_url} alt="" className="h-36 w-full object-cover" loading="lazy" />}
      <div className="adm-scroll min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex items-start gap-3">
          <CategoryIcon category={c.category} size={40} />
          <div className="min-w-0 flex-1">
            <div className="font-bold leading-snug text-slate-800">{pick(c.title_en, c.title_ur) || (lang === 'ur' ? CATEGORY_META[c.category].ur : CATEGORY_META[c.category].en)}</div>
            <div className="mt-0.5 text-xs text-slate-500">{ago(c.last_report_at || c.created_at)}</div>
          </div>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="-me-1.5 -mt-1 inline-flex size-9 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100"><X className="size-5" /></button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <StatusBadge status={c.status} className="!py-0.5 !text-xs" />
          <UrgencyBadge urgency={c.urgency} />
          {c.is_private && <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-bold text-violet-700"><Lock className="size-3" />{t('admin.private')}</span>}
        </div>
        {pick(c.summary_en, c.summary_ur) && <p className="mt-3 text-sm leading-relaxed text-slate-700">{pick(c.summary_en, c.summary_ur)}</p>}
        <AttributeChips attributes={c.attributes} compact max={6} className="mt-3" />
        <div className="mt-3 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
          <div className="flex items-center justify-between gap-2"><AiLabel /><Confidence value={c.confidence} /></div>
          {c.ai_reason && <p dir="auto" className="mt-2 text-start text-xs leading-relaxed text-slate-600">{c.ai_reason}</p>}
        </div>
        <div className="font-latin mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
          <span className="inline-flex items-center gap-1"><FileText className="size-3.5" />{c.report_count === 1 ? t('common.report1') : t('common.reports', { n: c.report_count })}</span>
          <span className="inline-flex items-center gap-1"><Users className="size-3.5" />{c.reporter_count}</span>
          <span className="inline-flex items-center gap-1"><ThumbsUp className="size-3.5" />{c.confirm_count}</span>
          <span className="inline-flex items-center gap-1"><ThumbsDown className="size-3.5" />{c.dispute_count}</span>
        </div>
        {c.claimed_org_name && <div className="mt-2 text-xs font-semibold text-brand-700">{t('admin.claimedBy', { org: c.claimed_org_name })}</div>}
        <label className="mt-4 block text-xs font-bold text-slate-500">{t('admin.map_status')}
          <Select className="mt-1 w-full" value={c.status} disabled={busy} onChange={(e) => { void setStatus(e.target.value as ReportStatus) }}>
            {STATUSES.map((s) => <option key={s} value={s}>{lang === 'ur' ? STATUS_META[s].ur : STATUS_META[s].en}</option>)}
          </Select>
        </label>
        <button type="button" onClick={() => go('reports', { search: c.id })}
          className="mt-2 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-xl bg-brand-700 text-sm font-semibold text-white shadow-sm hover:bg-brand-900">
          <FileText className="size-4" /> {t('admin.map_viewReports')}
        </button>
      </div>
    </div>
  )
}

export default function LiveMapPanel() {
  const { t, lang } = useI18n()
  const { version } = useAdmin()
  const reduce = useReducedMotion()
  const [showResolved, setShowResolved] = useState(false)
  const [privateOnly, setPrivateOnly] = useState(false)
  const [cats, setCats] = useState<Set<Category>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const { data, error, loading, reload } = useAsync(() => adminApi.listClusters(true), [version])

  const visible = useMemo(() => (data ?? []).filter((c) =>
    (showResolved || c.status !== 'resolved') && (!privateOnly || c.is_private) && (cats.size === 0 || cats.has(c.category))
    && Number.isFinite(c.lat) && Number.isFinite(c.lng)), [data, showResolved, privateOnly, cats])
  const counts = useMemo(() => {
    const out: Partial<Record<Category, number>> = {}
    for (const c of data ?? []) if (showResolved || c.status !== 'resolved') out[c.category] = (out[c.category] ?? 0) + 1
    return out
  }, [data, showResolved])
  const items = useMemo<ClusterItem[]>(() => visible.map((c) => ({
    id: c.id, lat: c.lat, lng: c.lng, icon: adminPinIcon(c, c.id === selected),
    hot: c.urgency === 'critical' || c.is_private, zIndexOffset: c.id === selected ? 1000 : c.is_private ? 500 : 0,
  })), [visible, selected])
  const sel = (data ?? []).find((c) => c.id === selected) ?? null
  const privateCount = (data ?? []).filter((c) => c.is_private && (showResolved || c.status !== 'resolved')).length

  const toggleCat = (c: Category) => setCats((prev) => {
    const next = new Set(prev)
    if (next.has(c)) next.delete(c)
    else next.add(c)
    return next
  })

  return (
    <div>
      <PanelHeader title={t('admin.map_title')} sub={t('admin.map_sub')} icon={MapIcon}
        actions={
          <>
            <label className="inline-flex min-h-9 items-center gap-2 rounded-full bg-white px-3 text-sm font-semibold text-slate-700 ring-1 ring-slate-200">
              <Switch checked={showResolved} onChange={setShowResolved} label={t('admin.map_resolved')} /> {t('admin.map_resolved')}
            </label>
            <label className="inline-flex min-h-9 items-center gap-2 rounded-full bg-white px-3 text-sm font-semibold text-slate-700 ring-1 ring-slate-200">
              <Switch checked={privateOnly} onChange={setPrivateOnly} label={t('admin.map_private')} tone="red" />
              <Lock className="size-3.5 text-violet-600" /> {t('admin.map_private')}
              <span className="font-latin rounded-full bg-slate-100 px-1.5 text-[11px] tabular-nums text-slate-600">{privateCount}</span>
            </label>
            <span className="font-latin rounded-full bg-brand-50 px-3 py-1.5 text-sm font-bold text-brand-900 ring-1 ring-brand-100">{t('admin.map_count', { n: visible.length })}</span>
          </>
        } />

      <div className="adm-scroll -mx-3 mb-3 flex gap-1.5 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
        <Chip active={cats.size === 0} onClick={() => setCats(new Set())}>{t('admin.map_all')}</Chip>
        {CATEGORIES.map((c) => {
          const m = CATEGORY_META[c]
          return <Chip key={c} active={cats.has(c)} icon={m.icon} color={m.color} count={counts[c] ?? 0} onClick={() => toggleCat(c)}>{lang === 'ur' ? m.ur : m.en}</Chip>
        })}
      </div>

      <div className="relative h-[68dvh] min-h-[420px] overflow-hidden rounded-2xl bg-slate-100 shadow-[0_10px_28px_-18px_rgb(15_118_110/0.25)] ring-1 ring-slate-200 lg:h-[calc(100dvh-15rem)]">
        {loading ? <Skeleton className="absolute inset-0 rounded-none" /> : error ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white"><ErrorState error={error} onRetry={reload} /></div>
        ) : (
          <BaseMap className="absolute inset-0 h-full w-full" zoomControl>
            <InvalidateOnResize />
            <ClusterLayer items={items} onSelect={setSelected} />
            <FlyTo to={sel ? { lat: sel.lat, lng: sel.lng } : null} />
          </BaseMap>
        )}
        {!loading && !error && visible.length === 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-4 z-[5] flex justify-center">
            <span className="rounded-full bg-white/95 px-4 py-2 text-sm font-semibold text-slate-600 shadow ring-1 ring-slate-200/70 backdrop-blur">{t('admin.map_empty')}</span>
          </div>
        )}
        {/* legend */}
        <div className="pointer-events-none absolute bottom-3 start-3 z-[5] hidden flex-wrap gap-1.5 rounded-xl bg-white/95 p-2 text-[11px] font-semibold shadow-md ring-1 ring-slate-200/70 backdrop-blur md:flex">
          {STATUSES.map((s) => {
            const m = STATUS_META[s]
            const Icon = m.icon
            return <span key={s} className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5" style={{ background: m.soft, color: m.color }}><Icon className="size-3" />{lang === 'ur' ? m.ur : m.en}</span>
          })}
          <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-1.5 py-0.5 text-red-700"><Lock className="size-3" />SOS</span>
        </div>
        <AnimatePresence>
          {sel && (
            <motion.div key={sel.id}
              className="absolute inset-x-2 bottom-2 z-[6] flex max-h-[62%] flex-col md:inset-x-auto md:bottom-auto md:end-3 md:top-3 md:max-h-[calc(100%-1.5rem)] md:w-[340px]"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
              transition={{ duration: reduce ? 0 : 0.2 }}>
              <PinCard c={sel} onClose={() => setSelected(null)} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
