import clsx from 'clsx'
import {
  BadgeCheck, CircleDot, Ear, ExternalLink, FileAudio, Lock, MapPin, Play, Shield, ShieldAlert, Siren, Smartphone, Timer, User,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { adminApi, type AdminSos } from '../../lib/adminApi'
import { URGENCY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import type { SosStatus, ThreatLevel } from '../../lib/sos'
import { ASSIGNMENT_META } from '../../lib/status'
import { AiLabel, Spinner, useTimeAgo } from '../ui'
import { fmtDuration, fmtTime, useAdmin, useAsync } from './context'
import { Badge, Block, Card, Drawer, Empty, ErrorState, PanelHeader, SkeletonRows } from './parts'

const THREAT: Record<ThreatLevel, { color: string; soft: string; icon: LucideIcon }> = {
  none: { color: '#475569', soft: '#F1F5F9', icon: Shield },
  possible: { color: URGENCY_META.high.color, soft: '#FFEDD5', icon: ShieldAlert },
  high: { color: URGENCY_META.critical.color, soft: '#FEE2E2', icon: ShieldAlert },
}
const SOS_ST: Record<SosStatus, { color: string; soft: string; icon: LucideIcon }> = {
  monitoring: { color: '#7C3AED', soft: '#EDE9FE', icon: Ear },
  alerted: { color: '#DC2626', soft: '#FEE2E2', icon: Siren },
  safe: { color: '#047857', soft: '#D1FAE5', icon: BadgeCheck },
  cancelled: { color: '#475569', soft: '#F1F5F9', icon: CircleDot },
  resolved: { color: '#047857', soft: '#D1FAE5', icon: BadgeCheck },
}

function useWide() {
  const q = '(min-width: 1024px)'
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches)
  useEffect(() => {
    const m = window.matchMedia(q)
    const on = () => setWide(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return wide
}

function ThreatBadge({ level }: { level: ThreatLevel }) {
  const { t } = useI18n()
  const m = THREAT[level] ?? THREAT.none
  return <Badge color={m.color} soft={m.soft} icon={m.icon}>{t(`admin.threat_${level}`)}</Badge>
}
function StatusPill({ status }: { status: SosStatus }) {
  const { t } = useI18n()
  const m = SOS_ST[status] ?? SOS_ST.cancelled
  return <Badge color={m.color} soft={m.soft} icon={m.icon}>{t(`admin.sosSt_${status}`)}</Badge>
}

function Chunk({ c }: { c: AdminSos['chunks'][number] }) {
  const { t } = useI18n()
  const [url, setUrl] = useState<string | null>(null)
  const [st, setSt] = useState<'idle' | 'loading' | 'error'>('idle')
  const load = async () => {
    if (!c.audio_path) return
    setSt('loading')
    try { setUrl(await adminApi.signedAudio(c.audio_path)); setSt('idle') } catch { setSt('error') }
  }
  return (
    <li className="rounded-xl bg-slate-50 p-2.5 ring-1 ring-slate-100">
      <div className="flex items-center gap-2">
        <span className="font-latin inline-flex size-6 items-center justify-center rounded-md bg-white text-[11px] font-bold text-slate-500 ring-1 ring-slate-200">{c.seq + 1}</span>
        <span className="font-latin text-xs text-slate-500">{fmtTime(c.created_at)}</span>
        {c.threat_level && <ThreatBadge level={c.threat_level} />}
        <span className="flex-1" />
        {c.audio_path && !url && (
          <button type="button" onClick={() => { void load() }} disabled={st === 'loading'} aria-label={t('admin.d_audioLoad', { n: c.seq + 1 })}
            className="inline-flex size-8 items-center justify-center rounded-full bg-slate-900 text-white hover:bg-slate-700">
            {st === 'loading' ? <Spinner className="size-4" /> : <Play className="size-3.5" />}
          </button>
        )}
      </div>
      {url && <audio controls autoPlay src={url} className="mt-2 h-9 w-full" />}
      {st === 'error' && <div className="mt-1 text-xs text-red-600">{t('admin.d_audioErr')}</div>}
      {c.transcript && <p dir="auto" className="mt-1.5 text-sm text-slate-700">{c.transcript}</p>}
    </li>
  )
}

function Detail({ s }: { s: AdminSos }) {
  const { t, lang } = useI18n()
  const steps: { at: string; label: string; icon: LucideIcon; color: string }[] = [
    { at: s.started_at, label: t('admin.tl_started'), icon: Smartphone, color: SOS_ST.monitoring.color },
  ]
  if (s.alerted_at) steps.push({ at: s.alerted_at, label: t('admin.tl_alerted'), icon: Siren, color: SOS_ST.alerted.color })
  for (const p of s.police) {
    if (p.claimed_at) steps.push({ at: p.claimed_at, label: t('admin.tl_claimed', { org: p.org_name }), icon: Shield, color: ASSIGNMENT_META.claimed.color })
    if (p.resolved_at) steps.push({ at: p.resolved_at, label: t('admin.tl_resolved', { org: p.org_name }), icon: BadgeCheck, color: ASSIGNMENT_META.resolved.color })
  }
  if (s.ended_at) steps.push({ at: s.ended_at, label: `${t('admin.tl_ended')} · ${t(`admin.sosSt_${s.status}`)}`, icon: CircleDot, color: SOS_ST[s.status]?.color ?? '#475569' })
  steps.sort((a, b) => a.at.localeCompare(b.at))
  const active = s.status === 'monitoring' || s.status === 'alerted'

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusPill status={s.status} />
        <ThreatBadge level={s.threat_level} />
        {active && <span className="inline-flex items-center gap-1.5 text-xs font-bold text-red-600"><span className="adm-live-dot" />{t('admin.sos_activeNow')}</span>}
        <span className="font-latin ms-auto inline-flex items-center gap-1 text-xs text-slate-500"><Timer className="size-3.5" />{fmtDuration(s.started_at, s.ended_at)}</span>
      </div>

      <Block title={t('admin.d_reporter')} icon={User}>
        <div className="rounded-2xl bg-white p-3 ring-1 ring-slate-200">
          <div className="font-semibold text-slate-900">{s.user_name || (s.user_anonymous ? t('admin.anonymous') : t('admin.unnamed'))}</div>
          <div dir="ltr" className="font-latin text-start text-xs text-slate-500">{[s.user_email, s.user_phone].filter(Boolean).join(' · ') || s.user_id.slice(0, 8)}</div>
          <div className="mt-1 text-xs text-slate-500">{t('admin.trigger', { t: t(`admin.trig_${s.trigger}`) })}</div>
        </div>
      </Block>

      <Block title={t('admin.sos_threat')} icon={ShieldAlert} right={<AiLabel />}>
        <div className="rounded-2xl p-3" style={{ background: THREAT[s.threat_level]?.soft }}>
          <ThreatBadge level={s.threat_level} />
          {s.threat_reason && <p className="mt-2 text-sm leading-relaxed text-slate-800">{s.threat_reason}</p>}
        </div>
      </Block>

      <Block title={t('admin.timeline')} icon={Timer}>
        <ol className="relative ms-3 border-s-2 border-slate-200">
          {steps.map((st, i) => {
            const I = st.icon
            return (
              <li key={i} className="relative pb-4 ps-6 last:pb-0">
                <span className="absolute -start-[13px] top-0 inline-flex size-6 items-center justify-center rounded-full text-white ring-4 ring-white" style={{ background: st.color }}><I className="size-3.5" /></span>
                <div className="text-sm font-semibold text-slate-800">{st.label}</div>
                <div className="font-latin text-xs text-slate-500">{fmtTime(st.at)}</div>
              </li>
            )
          })}
        </ol>
      </Block>

      <Block title={t('admin.sos_police')} icon={Shield}>
        {s.police.length === 0 ? <p className="text-sm text-slate-400">{t('admin.sos_noPolice')}</p> : (
          <ul className="space-y-2">
            {s.police.map((p) => (
              <li key={p.org_id} className="flex items-center gap-3 rounded-xl bg-white p-2.5 ring-1 ring-slate-200">
                <span className="inline-flex size-9 items-center justify-center rounded-lg bg-violet-600 text-white"><Shield className="size-4.5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{p.org_name}</div>
                  <div className="font-latin text-xs text-slate-500">{typeof p.distance_m === 'number' ? `${(p.distance_m / 1000).toFixed(1)} km · ` : ''}{fmtTime(p.alerted_at)}</div>
                </div>
                <Badge color={ASSIGNMENT_META[p.status].color} soft="#F8FAFC">{lang === 'ur' ? ASSIGNMENT_META[p.status].ur : ASSIGNMENT_META[p.status].en}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Block>

      {s.lat !== null && s.lng !== null && (
        <Block title={t('admin.sos_location')} icon={MapPin}>
          <div dir="ltr" className="font-latin flex flex-wrap items-center gap-3 rounded-xl bg-white p-3 text-sm ring-1 ring-slate-200">
            <span>{s.lat.toFixed(5)}, {s.lng.toFixed(5)}</span>
            {s.last_accuracy_m ? <span className="text-xs text-slate-500">±{Math.round(s.last_accuracy_m)} m</span> : null}
            {s.last_location_at && <span className="text-xs text-slate-500">{fmtTime(s.last_location_at)}</span>}
            <a className="ms-auto inline-flex items-center gap-1 text-xs font-semibold text-brand-700 underline" target="_blank" rel="noreferrer"
              href={`https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lng}#map=17/${s.lat}/${s.lng}`}>{t('admin.d_openOsm')} <ExternalLink className="size-3" /></a>
          </div>
        </Block>
      )}

      {s.transcript && (
        <Block title={t('admin.sos_transcript')} icon={FileAudio}>
          <blockquote dir="auto" className="whitespace-pre-wrap rounded-2xl bg-slate-50 p-3 text-sm leading-relaxed text-slate-800 ring-1 ring-slate-100">{s.transcript}</blockquote>
        </Block>
      )}

      {s.chunks.length > 0 && (
        <Block title={t('admin.sos_chunks', { n: s.chunks.length })} icon={Lock}>
          <ol className="space-y-2">{s.chunks.map((c) => <Chunk key={c.seq} c={c} />)}</ol>
        </Block>
      )}
    </div>
  )
}

function HowItWorks() {
  const { t } = useI18n()
  const steps: { icon: LucideIcon; label: string }[] = [
    { icon: Smartphone, label: `${t('admin.trig_button')} · ${t('admin.trig_volume')} · ${t('admin.trig_shake')}` },
    { icon: Ear, label: t('admin.sosSt_monitoring') },
    { icon: ShieldAlert, label: `${t('admin.threat_possible')} / ${t('admin.threat_high')}` },
    { icon: Siren, label: t('admin.sosSt_alerted') },
  ]
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center px-4 py-10 text-center">
      <span className="relative inline-flex size-16 items-center justify-center rounded-3xl bg-violet-50 text-violet-600 ring-1 ring-violet-100">
        <Siren className="size-8" />
      </span>
      <div className="mt-4 text-lg font-bold text-slate-900">{t('admin.sos_empty')}</div>
      <p className="mt-1 text-sm text-slate-500">{t('admin.sos_emptyHint')}</p>
      <ol className="mt-6 grid w-full gap-2 sm:grid-cols-4">
        {steps.map(({ icon: I, label }, i) => (
          <li key={i} className="flex flex-col items-center gap-1.5 rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-100">
            <span className="font-latin text-[11px] font-bold text-slate-400">{i + 1}</span>
            <I className="size-5 text-violet-600" />
            <span className="text-xs font-semibold text-slate-700">{label}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

export default function SosPanel() {
  const { t } = useI18n()
  const { version, changed } = useAdmin()
  const ago = useTimeAgo()
  const wide = useWide()
  const [sel, setSel] = useState<string | null>(null)
  const { data, error, loading, reload } = useAsync(() => adminApi.listSos(100, 0), [version])
  const rows = useMemo(() => data?.rows ?? [], [data])
  useEffect(() => { if (wide && !sel && rows.length) setSel(rows[0].id) }, [wide, sel, rows])
  const current = rows.find((r) => r.id === sel) ?? null

  return (
    <div>
      <PanelHeader title={t('admin.sos_title')} sub={t('admin.sos_sub')} icon={Siren} />
      {loading ? <Card><SkeletonRows rows={5} /></Card> : error ? <Card><ErrorState error={error} onRetry={reload} /></Card> :
        rows.length === 0 ? <Card><HowItWorks /></Card> : (
          <div className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
            <Card bodyClass="p-2">
              <ul className="adm-scroll space-y-1 lg:max-h-[calc(100dvh-13rem)] lg:overflow-y-auto">
                {rows.map((s) => {
                  const active = s.status === 'monitoring' || s.status === 'alerted'
                  return (
                    <li key={s.id}>
                      <button type="button" onClick={() => setSel(s.id)}
                        className={clsx('w-full rounded-xl p-3 text-start transition', sel === s.id ? 'bg-violet-50 ring-2 ring-violet-400' : 'hover:bg-slate-50',
                          changed.has(s.id) && 'adm-flash')}>
                        <div className="flex items-center gap-2">
                          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl"
                            style={{ background: SOS_ST[s.status]?.soft, color: SOS_ST[s.status]?.color }}>
                            {(() => { const I = SOS_ST[s.status]?.icon ?? Siren; return <I className="size-4.5" /> })()}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold text-slate-900">{s.user_name || (s.user_anonymous ? t('admin.anonymous') : t('admin.unnamed'))}</div>
                            <div className="text-xs text-slate-500">{ago(s.started_at)} · <span className="font-latin">{fmtDuration(s.started_at, s.ended_at)}</span></div>
                          </div>
                          {active && <span className="adm-live-dot text-red-500" />}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5"><StatusPill status={s.status} /><ThreatBadge level={s.threat_level} /></div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </Card>
            {wide && (
              <Card bodyClass="p-5">
                {current ? <Detail s={current} /> : <Empty icon={Siren} title={t('admin.sos_select')} />}
              </Card>
            )}
          </div>
        )}
      {!wide && (
        <Drawer open={!!current} onClose={() => setSel(null)} title={current ? (current.user_name || t('admin.anonymous')) : ''}>
          {current && <Detail s={current} />}
        </Drawer>
      )}
    </div>
  )
}
