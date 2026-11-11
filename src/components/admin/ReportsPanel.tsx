import clsx from 'clsx'
import { FileText, Lock, Mic, Camera, MessageSquareText, SearchX, ShieldBan } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { adminApi, type AdminReport } from '../../lib/adminApi'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { STATUS_META } from '../../lib/status'
import { CATEGORIES, type ReportStatus } from '../../lib/types'
import { AiLabel, CategoryIcon, StatusBadge, useTimeAgo } from '../ui'
import { useAdmin, useAsync } from './context'
import { Card, Confidence, Empty, ErrorState, Pager, PanelHeader, Select, SkeletonRows, Switch } from './parts'
import { ReportDrawer } from './ReportDrawer'

const STATUSES: ReportStatus[] = ['unconfirmed', 'verified', 'disputed', 'in_progress', 'resolved']
const LIMIT = 25
const MODE_ICON = { voice: Mic, photo: Camera, text: MessageSquareText } as const

export default function ReportsPanel() {
  const { t, pick, lang } = useI18n()
  const { search, setSearch, version, toast, refresh, changed } = useAdmin()
  const ago = useTimeAgo()
  const [status, setStatus] = useState('all')
  const [category, setCategory] = useState('all')
  const [hideSpam, setHideSpam] = useState(false)
  const [offset, setOffset] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => { setOffset(0) }, [search, status, category, hideSpam])

  const { data, setData, error, loading, reload, busy: reloading } = useAsync(
    () => adminApi.listReports({ search, status, category, includeSpam: !hideSpam, limit: LIMIT, offset }),
    [search, status, category, hideSpam, offset, version],
  )
  const rows = data?.rows ?? []
  const open = rows.find((r) => r.id === openId) ?? null

  // a search for one exact report id (from the activity feed) opens it straight away
  const autoOpened = useRef('')
  useEffect(() => {
    if (rows.length === 1 && search && rows[0].id === search && autoOpened.current !== search) {
      autoOpened.current = search
      setOpenId(rows[0].id)
    }
  }, [rows, search])

  const patch = (id: string, p: Partial<AdminReport>) =>
    setData((d) => d && { ...d, rows: d.rows.map((r) => (r.id === id ? { ...r, ...p } : r)) })

  const toggleSpam = async (r: AdminReport, v: boolean) => {
    setBusy(r.id)
    try {
      await adminApi.markSpam(r.id, v)
      patch(r.id, { is_spam: v })
      toast(t(v ? 'admin.spamOnToast' : 'admin.spamOffToast'))
      refresh()
    } catch (e) { toast(`${t('admin.saveFailed')}: ${(e as Error).message}`, 'error') } finally { setBusy(null) }
  }
  const changeStatus = async (r: AdminReport, s: ReportStatus) => {
    if (!r.cluster_id) return
    setBusy(r.id)
    try {
      await adminApi.setClusterStatus(r.cluster_id, s)
      setData((d) => d && { ...d, rows: d.rows.map((x) => (x.cluster_id === r.cluster_id ? { ...x, cluster_status: s, status: s } : x)) })
      toast(t('admin.statusToast', { status: lang === 'ur' ? STATUS_META[s].ur : STATUS_META[s].en }))
      refresh()
    } catch (e) { toast(`${t('admin.saveFailed')}: ${(e as Error).message}`, 'error') } finally { setBusy(null) }
  }

  const reporter = (r: AdminReport) => r.reporter_name || (r.reporter_anonymous ? t('admin.anonReporter') : t('admin.unnamed'))
  const statusSelect = (r: AdminReport) => (
    <Select aria-label={t('admin.col_status')} value={r.cluster_status ?? r.status} disabled={!r.cluster_id || busy === r.id}
      onClick={(e) => e.stopPropagation()} onChange={(e) => { void changeStatus(r, e.target.value as ReportStatus) }}
      className="!min-h-8 max-w-[150px] text-xs" style={{ color: STATUS_META[r.cluster_status ?? r.status].color }}>
      {STATUSES.map((s) => <option key={s} value={s}>{lang === 'ur' ? STATUS_META[s].ur : STATUS_META[s].en}</option>)}
    </Select>
  )

  return (
    <div>
      <PanelHeader title={t('admin.rep_title')} icon={FileText}
        sub={data ? t('admin.rep_sub', { n: data.total }) : undefined}
        actions={
          <>
            <Select aria-label={t('admin.allStatuses')} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">{t('admin.allStatuses')}</option>
              {STATUSES.map((s) => <option key={s} value={s}>{lang === 'ur' ? STATUS_META[s].ur : STATUS_META[s].en}</option>)}
              <option value="spam">{t('admin.spamOnly')}</option>
            </Select>
            <Select aria-label={t('admin.allCategories')} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="all">{t('admin.allCategories')}</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{lang === 'ur' ? CATEGORY_META[c].ur : CATEGORY_META[c].en}</option>)}
            </Select>
            <label className="inline-flex min-h-9 items-center gap-2 rounded-xl bg-white px-3 text-sm font-semibold text-slate-700 ring-1 ring-slate-200">
              <Switch checked={hideSpam} onChange={setHideSpam} label={t('admin.hideSpam')} /> {t('admin.hideSpam')}
            </label>
          </>
        } />

      <Card bodyClass="p-0" className={clsx('overflow-hidden transition-opacity', reloading && !loading && 'opacity-90')}>
        {loading ? <div className="p-4"><SkeletonRows rows={8} /></div> : error ? <ErrorState error={error} onRetry={reload} /> :
          rows.length === 0 ? (
            <Empty icon={SearchX} title={t('admin.rep_empty')} hint={t('admin.rep_emptyHint')}>
              {search && <button type="button" onClick={() => setSearch('')} className="mt-1 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white">{t('admin.clearSearch')}</button>}
            </Empty>
          ) : (
            <>
              {/* desktop table */}
              <div className="adm-scroll hidden overflow-x-auto md:block">
                <table className="w-full min-w-[880px] text-sm">
                  <thead className="bg-slate-50/80 text-xs text-slate-500">
                    <tr>
                      <th className="px-4 py-2.5 text-start font-semibold">{t('admin.col_report')}</th>
                      <th className="px-3 py-2.5 text-start font-semibold">{t('admin.col_reporter')}</th>
                      <th className="px-3 py-2.5 text-start font-semibold">{t('admin.col_status')}</th>
                      <th className="px-3 py-2.5 text-start font-semibold"><span className="inline-flex items-center gap-1.5">{t('admin.col_confidence')} <AiLabel className="!px-1.5 !text-[10px]" /></span></th>
                      <th className="px-3 py-2.5 text-start font-semibold">{t('admin.col_when')}</th>
                      <th className="px-4 py-2.5 text-end font-semibold">{t('admin.col_spam')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} onClick={() => setOpenId(r.id)}
                        className={clsx('cursor-pointer border-t border-slate-100 align-middle transition hover:bg-slate-50/80',
                          r.is_spam && 'bg-slate-50/60 text-slate-400', (changed.has(r.id) || (r.cluster_id && changed.has(r.cluster_id))) && 'adm-flash')}>
                        <td className="max-w-[380px] px-4 py-2.5">
                          <div className="flex items-center gap-3">
                            <CategoryIcon category={r.category} size={34} className={r.is_spam ? 'opacity-40' : undefined} />
                            <div className="min-w-0">
                              <div className={clsx('flex items-center gap-1.5 truncate font-semibold', r.is_spam ? 'text-slate-400 line-through' : 'text-slate-900')}>
                                {r.is_private && <Lock className="size-3.5 shrink-0 text-violet-600" aria-label={t('admin.private')} />}
                                <span className="truncate">{pick(r.title_en, r.title_ur) || t('admin.untitled')}</span>
                              </div>
                              <div className="flex items-center gap-1.5 truncate text-xs text-slate-500">
                                {r.input_modes.map((m) => { const I = MODE_ICON[m as keyof typeof MODE_ICON]; return I ? <I key={m} className="size-3.5 shrink-0" /> : null })}
                                <span dir="auto" className="truncate">{r.address_text || pick(r.summary_en, r.summary_ur)}</span>
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="max-w-[200px] px-3 py-2.5">
                          <div className="truncate font-medium text-slate-800">{reporter(r)}</div>
                          {r.reporter_email && <div dir="ltr" className="font-latin truncate text-start text-xs text-slate-500">{r.reporter_email}</div>}
                        </td>
                        <td className="px-3 py-2.5">{statusSelect(r)}</td>
                        <td className="px-3 py-2.5"><Confidence value={r.confidence} /></td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-xs text-slate-500">{ago(r.created_at)}</td>
                        <td className="px-4 py-2.5 text-end">
                          <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
                            <Switch checked={r.is_spam} onChange={(v) => { void toggleSpam(r, v) }} label={t('admin.markSpam')} disabled={busy === r.id} tone="red" />
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* mobile cards */}
              <ul className="divide-y divide-slate-100 md:hidden">
                {rows.map((r) => (
                  <li key={r.id} className={clsx(changed.has(r.id) && 'adm-flash')}>
                    <button type="button" onClick={() => setOpenId(r.id)} className="flex w-full items-start gap-3 px-4 py-3 text-start">
                      <CategoryIcon category={r.category} size={38} className={r.is_spam ? 'opacity-40' : undefined} />
                      <div className="min-w-0 flex-1">
                        <div className={clsx('font-semibold leading-snug', r.is_spam ? 'text-slate-400 line-through' : 'text-slate-900')}>
                          {r.is_private && <Lock className="me-1 inline size-3.5 text-violet-600" />}
                          {pick(r.title_en, r.title_ur) || t('admin.untitled')}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-slate-500">{reporter(r)} · {ago(r.created_at)}</div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          <StatusBadge status={r.cluster_status ?? r.status} className="!px-2 !py-0.5 !text-xs" />
                          <Confidence value={r.confidence} />
                          {r.is_spam && <span className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-bold text-white"><ShieldBan className="size-3" />{t('admin.spam')}</span>}
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              <Pager offset={offset} limit={LIMIT} total={data?.total ?? 0} onChange={setOffset} />
            </>
          )}
      </Card>

      <ReportDrawer report={open} onClose={() => setOpenId(null)} onChanged={(p) => open && patch(open.id, p)} />
    </div>
  )
}
