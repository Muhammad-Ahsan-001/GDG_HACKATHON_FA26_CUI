import clsx from 'clsx'
import {
  Bot, Camera, Check, Copy, ExternalLink, FileAudio, Image as ImageIcon, Lock, MapPin, MessageSquareText, Play, ShieldBan,
  Sparkles, User, Utensils,
} from 'lucide-react'
import { useState } from 'react'
import { adminApi, type AdminReport } from '../../lib/adminApi'
import { CATEGORY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import { STATUS_META } from '../../lib/status'
import type { ReportStatus } from '../../lib/types'
import { ROLE_META } from '../auth/meta'
import { AttributeChips } from '../report/AttributeChips'
import { AiLabel, CategoryIcon, Spinner, StatusBadge, UrgencyBadge, useTimeAgo } from '../ui'
import { fmtDateTime, useAdmin } from './context'
import { Block, Confidence, Drawer, Select, Switch } from './parts'

const STATUSES: ReportStatus[] = ['unconfirmed', 'verified', 'disputed', 'in_progress', 'resolved']

function AudioClip({ path, n }: { path: string; n: number }) {
  const { t } = useI18n()
  const [url, setUrl] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const load = async () => {
    setState('loading')
    try { setUrl(await adminApi.signedAudio(path)); setState('idle') } catch { setState('error') }
  }
  if (url) return <audio controls autoPlay src={url} className="h-10 w-full" preload="none" />
  return (
    <button type="button" onClick={() => { void load() }} disabled={state === 'loading'}
      className="flex min-h-11 w-full items-center gap-3 rounded-xl bg-slate-50 px-3 text-start text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100">
      {state === 'loading' ? <Spinner className="size-4" /> : <span className="inline-flex size-7 items-center justify-center rounded-full bg-brand-700 text-white"><Play className="size-3.5" /></span>}
      <span className="flex-1">{state === 'error' ? t('admin.d_audioErr') : t('admin.d_audioLoad', { n })}</span>
      <FileAudio className="size-4 text-slate-400" />
    </button>
  )
}

export function ReportDrawer({ report: r, onClose, onChanged }: {
  report: AdminReport | null; onClose: () => void; onChanged: (patch: Partial<AdminReport>) => void
}) {
  const { t, pick, lang } = useI18n()
  const { toast, refresh } = useAdmin()
  const ago = useTimeAgo()
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const setSpam = async (v: boolean) => {
    if (!r) return
    setBusy(true)
    try {
      await adminApi.markSpam(r.id, v)
      onChanged({ is_spam: v })
      toast(t(v ? 'admin.spamOnToast' : 'admin.spamOffToast'))
      refresh()
    } catch (e) { toast(`${t('admin.saveFailed')}: ${(e as Error).message}`, 'error') } finally { setBusy(false) }
  }
  const setStatus = async (s: ReportStatus) => {
    if (!r?.cluster_id) return
    setBusy(true)
    try {
      await adminApi.setClusterStatus(r.cluster_id, s)
      onChanged({ cluster_status: s, status: s })
      toast(t('admin.statusToast', { status: lang === 'ur' ? STATUS_META[s].ur : STATUS_META[s].en }))
      refresh()
    } catch (e) { toast(`${t('admin.saveFailed')}: ${(e as Error).message}`, 'error') } finally { setBusy(false) }
  }

  const images = r?.media.filter((m) => m.type === 'image' && m.url) ?? []
  const audio = r?.media.filter((m) => m.type === 'audio') ?? []
  const convo = Array.isArray(r?.conversation) ? r.conversation : []
  const role = r?.reporter_role ? ROLE_META[r.reporter_role] : null
  const modes = (r?.input_modes ?? []).map((m) => t(`admin.input_${m}`)).join(' + ')

  return (
    <Drawer open={!!r} onClose={onClose} header={r && (
      <div className="flex items-start gap-3">
        <CategoryIcon category={r.category} size={44} />
        <div className="min-w-0">
          <div className="text-lg font-bold leading-snug text-slate-900">{pick(r.title_en, r.title_ur) || t('admin.untitled')}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={r.cluster_status ?? r.status} className="!py-0.5 !text-xs" />
            <UrgencyBadge urgency={r.urgency} />
            {r.is_spam && <span className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-2 py-0.5 text-xs font-bold text-white"><ShieldBan className="size-3" />{t('admin.spam')}</span>}
            {r.is_private && <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-bold text-violet-700"><Lock className="size-3" />{t('admin.private')}</span>}
            <span className="text-xs text-slate-500">{ago(r.created_at)} · {fmtDateTime(r.created_at)}</span>
          </div>
        </div>
      </div>
    )}>
      {r && (
        <div>
          {r.is_private && <div className="mb-4 flex items-center gap-2 rounded-xl bg-violet-50 p-3 text-sm font-semibold text-violet-800 ring-1 ring-violet-100"><Lock className="size-4" />{t('admin.d_privateNote')}</div>}

          {/* moderation */}
          <div className="mb-5 grid gap-2 rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-100 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
              <span className="text-sm font-semibold text-slate-700">{t('admin.markSpam')}</span>
              <Switch checked={r.is_spam} onChange={(v) => { void setSpam(v) }} label={t('admin.markSpam')} disabled={busy} tone="red" />
            </label>
            <label className="flex items-center gap-2 rounded-xl bg-white px-3 py-1.5 ring-1 ring-slate-200">
              <span className="shrink-0 text-sm font-semibold text-slate-700">{t('admin.map_status')}</span>
              <Select className="min-w-0 flex-1 !ring-0" value={r.cluster_status ?? r.status} disabled={busy || !r.cluster_id}
                onChange={(e) => { void setStatus(e.target.value as ReportStatus) }}>
                {STATUSES.map((s) => <option key={s} value={s}>{lang === 'ur' ? STATUS_META[s].ur : STATUS_META[s].en}</option>)}
              </Select>
            </label>
          </div>

          <Block title={t('admin.d_ai')} icon={Sparkles} right={<AiLabel />}>
            <div className="rounded-2xl bg-violet-50/50 p-3 ring-1 ring-violet-100">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Confidence value={r.confidence} />
                {r.ai_provider && <span className="font-latin text-xs text-slate-500">{t('admin.d_model', { p: r.ai_provider })}</span>}
              </div>
              {r.ai_reason && <p className="mt-2 text-sm leading-relaxed text-slate-700"><b className="text-slate-900">{t('admin.d_reason')}: </b><bdi>{r.ai_reason}</bdi></p>}
              {r.is_spam && r.spam_reason && <p className="mt-2 text-sm text-slate-700">{t('admin.d_spamReason', { r: r.spam_reason })}</p>}
              {r.photo_check && typeof r.photo_check.matches_claim === 'boolean' && (
                <p className={clsx('mt-2 inline-flex items-center gap-1.5 text-sm font-semibold', r.photo_check.matches_claim ? 'text-green-700' : 'text-amber-700')}>
                  <Camera className="size-4" /> {t(r.photo_check.matches_claim ? 'admin.d_photoMatch' : 'admin.d_photoNoMatch')}
                </p>
              )}
            </div>
          </Block>

          {pick(r.summary_en, r.summary_ur) && (
            <Block title={t('admin.d_summary')} icon={MessageSquareText} right={<AiLabel />}>
              <p className="text-[15px] leading-relaxed text-slate-800">{pick(r.summary_en, r.summary_ur)}</p>
              {lang === 'ur' && r.summary_en && r.summary_ur && <p dir="ltr" className="font-latin mt-2 text-start text-sm text-slate-500">{r.summary_en}</p>}
              {r.food_servings ? (
                <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-green-50 px-2.5 py-1 text-sm font-semibold text-green-800">
                  <Utensils className="size-4" /> {t('admin.d_food', { n: r.food_servings })}{r.food_type ? ` · ${r.food_type}` : ''}
                  {r.safe_until ? ` · ${t('admin.d_safeUntil', { t: fmtDateTime(r.safe_until) })}` : ''}
                </p>
              ) : null}
            </Block>
          )}

          {r.attributes && Object.keys(r.attributes).length > 0 && (
            <Block title={t('admin.d_attributes')} icon={Bot}>
              <AttributeChips attributes={r.attributes} />
            </Block>
          )}

          <Block title={t('admin.d_transcript')} icon={FileAudio} right={modes ? <span className="text-xs text-slate-400">{t('admin.d_via', { modes })}</span> : undefined}>
            {r.transcript ? (
              <blockquote dir="auto" className="whitespace-pre-wrap rounded-2xl bg-slate-50 p-3 text-[15px] leading-relaxed text-slate-800 ring-1 ring-slate-100">{r.transcript}</blockquote>
            ) : <p className="text-sm text-slate-400">{t('admin.d_noTranscript')}</p>}
          </Block>

          {images.length > 0 && (
            <Block title={t('admin.d_photos')} icon={ImageIcon}>
              <div className="grid grid-cols-2 gap-2">
                {images.map((m) => (
                  <a key={m.path} href={m.url!} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl ring-1 ring-slate-200">
                    <img src={m.url!} alt="" loading="lazy" className="aspect-[4/3] w-full object-cover transition hover:scale-[1.02]" />
                  </a>
                ))}
              </div>
            </Block>
          )}

          {audio.length > 0 && (
            <Block title={t('admin.d_audio')} icon={FileAudio}>
              <div className="space-y-2">{audio.map((m, i) => <AudioClip key={m.path} path={m.path} n={i + 1} />)}</div>
            </Block>
          )}

          {convo.length > 0 && (
            <Block title={t('admin.d_conversation')} icon={MessageSquareText}>
              <ol className="space-y-2">
                {convo.map((c, i) => (
                  <li key={i} className={clsx('flex', c.role === 'user' ? 'justify-end' : 'justify-start')}>
                    <div className={clsx('max-w-[85%] rounded-2xl px-3 py-2 text-sm',
                      c.role === 'user' ? 'rounded-ee-md bg-brand-700 text-white' : 'rounded-es-md bg-slate-100 text-slate-800')}>
                      <div className={clsx('mb-0.5 text-[11px] font-bold', c.role === 'user' ? 'text-white/70' : 'text-slate-500')}>
                        {c.role === 'user' ? t('admin.d_turnUser') : t('admin.d_turnAi')}
                      </div>
                      <div dir="auto">{c.text}</div>
                      {c.role === 'user' && c.audio_path && <div className="mt-1.5"><AudioClip path={c.audio_path} n={i + 1} /></div>}
                    </div>
                  </li>
                ))}
              </ol>
            </Block>
          )}

          <Block title={t('admin.d_reporter')} icon={User}>
            <div className="flex items-center gap-3 rounded-2xl bg-white p-3 ring-1 ring-slate-200">
              <span className="inline-flex size-10 items-center justify-center rounded-full" style={{ background: role?.soft ?? '#F1F5F9', color: role?.color ?? '#475569' }}>
                {role ? <role.icon className="size-5" /> : <User className="size-5" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-slate-900">{r.reporter_name || (r.reporter_anonymous ? t('admin.anonReporter') : t('admin.unnamed'))}</div>
                {r.reporter_email && <div className="font-latin truncate text-sm text-slate-500" dir="ltr">{r.reporter_email}</div>}
              </div>
              {typeof r.reporter_trust === 'number' && (
                <span className="font-latin rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700">{t('admin.d_trust', { n: Math.round(r.reporter_trust * 100) })}</span>
              )}
            </div>
          </Block>

          <Block title={t('admin.d_location')} icon={MapPin}>
            <div className="rounded-2xl bg-white p-3 text-sm ring-1 ring-slate-200">
              {r.address_text && <div dir="auto" className="font-semibold text-slate-800">{r.address_text}</div>}
              {r.lat !== null && r.lng !== null && (
                <div className="font-latin mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500" dir="ltr">
                  <span>{r.lat.toFixed(5)}, {r.lng.toFixed(5)}</span>
                  {r.location_source && <span className="rounded bg-slate-100 px-1.5 py-0.5">{r.location_source}</span>}
                  <a className="inline-flex items-center gap-1 font-semibold text-brand-700 underline" target="_blank" rel="noreferrer"
                    href={`https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lng}#map=17/${r.lat}/${r.lng}`}>
                    {t('admin.d_openOsm')} <ExternalLink className="size-3" />
                  </a>
                </div>
              )}
            </div>
          </Block>

          <Block title={t('admin.d_cluster')} icon={MapPin}>
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
              {r.cluster_id ? (
                <>
                  <span>{t('admin.d_inCluster', { n: r.cluster_report_count ?? 0 })}</span>
                  <code dir="ltr" className="font-latin rounded bg-slate-100 px-1.5 py-0.5 text-xs">{r.cluster_id.slice(0, 8)}</code>
                </>
              ) : <span>{t('admin.noCluster')}</span>}
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(r.id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}
                className="ms-auto inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50">
                {copied ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5" />} {copied ? t('admin.copied') : t('admin.d_copyId')}
              </button>
            </div>
            <div className="mt-2 text-xs text-slate-400">{lang === 'ur' ? CATEGORY_META[r.category].ur : CATEGORY_META[r.category].en}</div>
          </Block>
        </div>
      )}
    </Drawer>
  )
}
