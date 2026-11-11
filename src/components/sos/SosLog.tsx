import { MapPin, ShieldCheck, Siren } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { useI18n } from '../../lib/i18n'
import type { SosSession } from '../../lib/sos'
import { supabase } from '../../lib/supabase'
import type { AppNotification } from '../../lib/types'
import { AiLabel, Button, Spinner, useTimeAgo } from '../ui'
import { SOS_RED, SOS_STATUS_META, SOS_TRIGGER_ICON, THREAT_COLOR } from './meta'
import { orgNamesFromNotification, readSosOrgs } from './sosClient'

type LogRow = Pick<SosSession,
  'id' | 'trigger' | 'status' | 'started_at' | 'ended_at' | 'alerted_at' | 'threat_level' | 'threat_reason'
  | 'transcript' | 'cluster_id' | 'lat' | 'lng'>

const COLS = 'id, trigger, status, started_at, ended_at, alerted_at, threat_level, threat_reason, transcript, cluster_id, lat, lng'
const COLLAPSED = 3

/** Table/view not deployed yet (pre-migration database): hide the log instead of showing an error. */
function isMissingRelation(e: { code?: string } | null): boolean {
  return Boolean(e && (e.code === 'PGRST205' || e.code === '42P01' || e.code === '42703'))
}

function sortRows(rows: LogRow[]): LogRow[] {
  return [...rows].sort((a, b) => b.started_at.localeCompare(a.started_at))
}

/**
 * "My SOS log": the user's own SOS sessions from `sos_sessions_view` (RLS: owner), live via realtime on
 * `sos_sessions`. Police org names come from this device's cache (written by /sos) or the `sos_logged` notification.
 */
export function SosLog({ uid, notifications }: { uid: string | undefined; notifications: AppNotification[] | null }) {
  const { t } = useI18n()
  const [rows, setRows] = useState<LogRow[] | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'error'>('loading')
  const [showAll, setShowAll] = useState(false)
  const [live, setLive] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errorId, setErrorId] = useState<string | null>(null)
  const missing = state === 'missing'

  useEffect(() => {
    if (!uid) return
    let alive = true
    void (async () => {
      const { data, error } = await supabase.from('sos_sessions_view').select(COLS)
        .eq('user_id', uid).order('started_at', { ascending: false }).limit(30)
      if (!alive) return
      if (error) { setState(isMissingRelation(error) ? 'missing' : 'error'); setRows([]); return }
      setRows((data as unknown as LogRow[] | null) ?? [])
      setState('ok')
    })()
    return () => { alive = false }
  }, [uid])

  useEffect(() => {
    if (!uid || missing) return
    const refetch = async (id: string) => {
      const { data } = await supabase.from('sos_sessions_view').select(COLS).eq('id', id).maybeSingle()
      if (!data) return
      const row = data as unknown as LogRow
      setRows((prev) => sortRows(prev?.some((r) => r.id === id) ? prev.map((r) => (r.id === id ? row : r)) : [row, ...(prev ?? [])]))
    }
    const ch = supabase
      .channel(`me-sos-${uid}-${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sos_sessions', filter: `user_id=eq.${uid}` }, (payload) => {
        if (payload.eventType === 'DELETE') {
          const id = (payload.old as { id?: string }).id
          if (id) setRows((prev) => prev?.filter((r) => r.id !== id) ?? prev)
          return
        }
        const id = (payload.new as { id?: string }).id
        if (id) void refetch(id)
      })
      .subscribe((status) => setLive(status === 'SUBSCRIBED'))
    return () => { void supabase.removeChannel(ch) }
  }, [uid, missing])

  // the `sos_logged` notification of each alerted session (data.sos_session_id, or the SOS cluster id)
  const notifBySession = useMemo(() => {
    const m = new Map<string, AppNotification>()
    for (const n of notifications ?? []) {
      if (n.type !== 'sos_logged') continue
      const d = n.data ?? {}
      const sid = typeof d.sos_session_id === 'string' ? d.sos_session_id : typeof d.session_id === 'string' ? d.session_id : null
      if (sid && !m.has(sid)) m.set(sid, n)
      if (n.cluster_id && !m.has(`c:${n.cluster_id}`)) m.set(`c:${n.cluster_id}`, n)
    }
    return m
  }, [notifications])

  const endSession = useCallback(async (id: string) => {
    setBusyId(id)
    setErrorId(null)
    try {
      const res = await api.sos({ action: 'end', session_id: id, outcome: 'safe' })
      setRows((prev) => prev?.map((r) => (r.id === id ? { ...r, status: res.status ?? 'safe', ended_at: r.ended_at ?? new Date().toISOString() } : r)) ?? prev)
    } catch {
      setErrorId(id)
    } finally {
      setBusyId(null)
    }
  }, [])

  if (missing) return null

  const list = rows ?? []
  const shown = showAll ? list : list.slice(0, COLLAPSED)

  return (
    <div className="border-t border-slate-100 px-4 py-3">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 font-bold">{t('sos.logTitle')}</h3>
        {live && (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-green-700">
            <span className="size-2 rounded-full bg-green-500" /> {t('sos.live')}
          </span>
        )}
      </div>

      {state === 'loading' ? (
        <div className="flex justify-center py-4 text-brand-700"><Spinner /></div>
      ) : state === 'error' ? (
        <p className="py-2 text-sm text-slate-500">{t('sos.logError')}</p>
      ) : list.length === 0 ? (
        <p className="py-2 text-sm text-slate-500">{t('sos.logEmpty')}</p>
      ) : (
        <>
          <ul className="mt-2 space-y-2">
            {shown.map((row) => {
              const notif = notifBySession.get(row.id) ?? (row.cluster_id ? notifBySession.get(`c:${row.cluster_id}`) : undefined) ?? null
              const orgs = readSosOrgs(row.id) ?? (notif ? orgNamesFromNotification(notif) : null)
              return (
                <SosLogItem
                  key={row.id} row={row} orgs={orgs} notif={notif} busy={busyId === row.id} failed={errorId === row.id}
                  onEnd={() => { void endSession(row.id) }}
                />
              )
            })}
          </ul>
          {list.length > COLLAPSED && (
            <button type="button" onClick={() => setShowAll((v) => !v)}
              className="mt-2 min-h-11 w-full rounded-2xl text-sm font-bold text-brand-700 hover:bg-slate-50">
              {showAll ? t('sos.logLess') : t('sos.logMore', { n: list.length })}
            </button>
          )}
        </>
      )}
    </div>
  )
}

function SosLogItem({ row, orgs, notif, busy, failed, onEnd }: {
  row: LogRow
  orgs: string[] | null
  /** the server's `sos_logged` note for this session (names the police when this device has no cache) */
  notif: AppNotification | null
  busy: boolean
  failed: boolean
  onEnd: () => void
}) {
  const { t, lang, pick } = useI18n()
  const ago = useTimeAgo()
  const meta = SOS_STATUS_META[row.status] ?? SOS_STATUS_META.cancelled
  const Icon = meta.icon
  const TriggerIcon = SOS_TRIGGER_ICON[row.trigger] ?? SOS_TRIGGER_ICON.button
  const when = new Date(row.started_at).toLocaleString(lang === 'ur' ? 'ur-PK' : 'en-PK', {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  })
  let duration = ''
  if (row.ended_at) {
    const secs = Math.max(0, Math.round((new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 1000))
    duration = secs < 60 ? t('sos.durationSec', { n: secs }) : t('sos.durationMin', { n: Math.round(secs / 60) })
  }
  const wasAlerted = row.status === 'alerted' || Boolean(row.alerted_at)
  const open = row.status === 'monitoring' || row.status === 'alerted'

  return (
    <li className="rounded-2xl bg-white p-3 ring-1 ring-slate-200">
      <div className="flex items-start gap-3">
        <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl text-white" style={{ background: meta.color }}>
          <Icon className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-bold" style={{ background: meta.soft, color: meta.color }}>
              {t(`sos.status_${row.status}`)}
            </span>
            {row.threat_level !== 'none' && THREAT_COLOR[row.threat_level] && (
              <span className="rounded-full px-2 py-0.5 text-xs font-bold text-white" style={{ background: THREAT_COLOR[row.threat_level] }}>
                {t(`sos.threat_${row.threat_level}`)}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
            <span>{ago(row.started_at)}</span>
            <span>{when}</span>
            {duration && <span>· {duration}</span>}
            <span className="inline-flex items-center gap-1"><TriggerIcon className="size-3.5" /> {t(`sos.trigger_${row.trigger}`)}</span>
            {row.lat != null && row.lng != null && (
              <span className="inline-flex items-center gap-1"><MapPin className="size-3.5" /> {t('sos.sharedLocation')}</span>
            )}
          </div>
        </div>
      </div>

      {wasAlerted && (orgs && orgs.length > 0 ? (
        <div className="mt-2 flex items-center gap-1.5 text-sm font-semibold" style={{ color: SOS_RED }}>
          <Siren className="size-4 shrink-0" /> {t('sos.policeOrgs', { orgs: orgs.join(lang === 'ur' ? '، ' : ', ') })}
        </div>
      ) : notif && pick(notif.body_en, notif.body_ur) ? (
        <div className="mt-2 flex items-start gap-1.5 text-sm font-semibold" style={{ color: SOS_RED }}>
          <Siren className="mt-0.5 size-4 shrink-0" /> <span>{pick(notif.body_en, notif.body_ur)}</span>
        </div>
      ) : null)}

      {row.threat_reason && (
        <div className="mt-2 flex items-start gap-2 text-sm text-slate-700">
          <p className="min-w-0 flex-1">{row.threat_reason}</p>
          <AiLabel className="shrink-0" />
        </div>
      )}

      {row.transcript && (
        <details className="mt-2 text-sm">
          <summary className="flex min-h-10 cursor-pointer items-center gap-2 font-semibold text-slate-600">
            {t('sos.heard')} <AiLabel />
          </summary>
          <p className="mt-1 whitespace-pre-wrap rounded-xl bg-slate-50 p-2 text-slate-700" dir="auto">{row.transcript}</p>
        </details>
      )}

      {open && (
        <Button variant="success" icon={ShieldCheck} loading={busy} onClick={onEnd} className="mt-3 w-full">
          {t('sos.markSafe')}
        </Button>
      )}
      {failed && <p role="alert" className="mt-1 text-sm font-semibold text-red-700">{t('sos.markSafeError')}</p>}
    </li>
  )
}
