// Hand-made SVG bar chart: reports per day (single series, brand teal). Accessible (role=img + label, keyboard-focusable
// bars with tooltip, table view), theme-safe (axis/grid use currentColor), reduced-motion aware.
import clsx from 'clsx'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../../lib/i18n'

export interface DayPoint { day: string; reports: number; spam: number; sos: number }

const H = 220
const M = { top: 22, right: 8, bottom: 26, left: 30 }
const BAR = '#0d9488'      // --color-brand-600
const BAR_HI = '#0f766e'   // --color-brand-700

function niceMax(v: number): { max: number; step: number } {
  if (v <= 4) return { max: 4, step: 1 }
  const raw = v / 4
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow
  return { max: Math.ceil(v / step) * step, step }
}

function barPath(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return ''
  const rr = Math.min(r, w / 2, h)
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`
}

const dayLabel = (iso: string, lang: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(lang === 'ur' ? 'ur-PK' : 'en-GB', { day: 'numeric', month: 'short' })

export function ReportsChart({ data }: { data: DayPoint[] }) {
  const { t, lang } = useI18n()
  const wrap = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(640)
  const [hover, setHover] = useState<number | null>(null)
  const [table, setTable] = useState(false)

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [table])

  const { max, step } = useMemo(() => niceMax(Math.max(0, ...data.map((d) => d.reports))), [data])
  const peak = useMemo(() => data.reduce((best, d, i) => (d.reports > (data[best]?.reports ?? -1) ? i : best), 0), [data])
  const innerW = w - M.left - M.right
  const innerH = H - M.top - M.bottom
  const band = innerW / Math.max(1, data.length)
  const bw = Math.max(6, Math.min(34, band * 0.62))
  const y = (v: number) => M.top + innerH - (v / max) * innerH
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step)
  const every = band < 30 ? 2 : 1
  const total = data.reduce((s, d) => s + d.reports, 0)
  const todayIdx = data.length - 1
  const fmtDay = (iso: string) => dayLabel(iso, lang)
  const hp = hover !== null ? data[hover] : null

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-sm text-slate-500">{t('admin.chart_sub', { n: total })}</div>
        <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs font-semibold" role="group">
          {[false, true].map((v) => (
            <button key={String(v)} type="button" onClick={() => setTable(v)} aria-pressed={table === v}
              className={clsx('min-h-7 rounded-md px-2.5', table === v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500')}>
              {t(v ? 'admin.chart_showTable' : 'admin.chart_showChart')}
            </button>
          ))}
        </div>
      </div>

      {table ? (
        <div className="adm-scroll max-h-[232px] overflow-auto rounded-xl ring-1 ring-slate-200">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 text-start font-semibold">{t('admin.chart_day')}</th>
                <th className="px-3 py-2 text-end font-semibold">{t('admin.chart_reports')}</th>
                <th className="px-3 py-2 text-end font-semibold">{t('admin.chart_spam')}</th>
                <th className="px-3 py-2 text-end font-semibold">{t('admin.chart_sos')}</th>
              </tr>
            </thead>
            <tbody className="font-latin tabular-nums">
              {[...data].reverse().map((d) => (
                <tr key={d.day} className="border-t border-slate-100">
                  <td className="px-3 py-1.5">{fmtDay(d.day)}</td>
                  <td className="px-3 py-1.5 text-end font-semibold">{d.reports}</td>
                  <td className="px-3 py-1.5 text-end text-slate-500">{d.spam}</td>
                  <td className="px-3 py-1.5 text-end text-slate-500">{d.sos}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={wrap} dir="ltr" className="relative w-full select-none text-slate-400" onMouseLeave={() => setHover(null)}>
          <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img"
            aria-label={t('admin.chart_aria', { max: data[peak]?.reports ?? 0, day: data[peak] ? fmtDay(data[peak].day) : '' })}
            className="block overflow-visible">
            {/* grid + y axis */}
            {ticks.map((v) => (
              <g key={v}>
                <line x1={M.left} x2={w - M.right} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity={v === 0 ? 0.35 : 0.14}
                  strokeDasharray={v === 0 ? undefined : '3 4'} />
                <text x={M.left - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize="11" fill="currentColor" className="font-latin tabular-nums">{v}</text>
              </g>
            ))}
            {/* bars */}
            {data.map((d, i) => {
              const cx = M.left + band * i + band / 2
              const top = y(d.reports)
              const dim = hover !== null && hover !== i
              return (
                <g key={d.day}>
                  <path d={barPath(cx - bw / 2, top, bw, M.top + innerH - top, 4)} fill={i === hover || i === todayIdx ? BAR_HI : BAR}
                    opacity={dim ? 0.4 : 1} style={{ transition: 'opacity .15s' }} />
                  {/* hit target larger than the mark, keyboard-focusable */}
                  <rect x={M.left + band * i} y={M.top} width={band} height={innerH} fill="transparent"
                    tabIndex={0} role="presentation" aria-label={`${fmtDay(d.day)}: ${d.reports}`}
                    onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                    className="cursor-default outline-none" />
                  {i % every === (data.length - 1) % every && (
                    <text x={cx} y={H - 8} textAnchor="middle" fontSize="11" fill="currentColor"
                      fontWeight={i === todayIdx ? 700 : 400} className="font-latin">
                      {i === todayIdx ? t('admin.chart_today') : new Date(`${d.day}T00:00:00`).getDate()}
                    </text>
                  )}
                  {/* selective direct label: the peak */}
                  {i === peak && d.reports > 0 && hover === null && (
                    <text x={cx} y={top - 7} textAnchor="middle" fontSize="12" fontWeight={700} className="font-latin fill-slate-700">{d.reports}</text>
                  )}
                </g>
              )
            })}
          </svg>
          {hp && hover !== null && (
            <div
              className="pointer-events-none absolute z-10 min-w-36 -translate-x-1/2 rounded-xl bg-slate-900 px-3 py-2 text-xs text-white shadow-xl"
              style={{
                left: Math.min(w - 76, Math.max(76, M.left + band * hover + band / 2)),
                top: Math.max(0, y(hp.reports) - 86),
              }}
            >
              <div className="mb-1 font-semibold text-white/70">{fmtDay(hp.day)}</div>
              <div className="flex items-center justify-between gap-4"><span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm" style={{ background: BAR }} />{t('admin.chart_reports')}</span><b className="font-latin tabular-nums">{hp.reports}</b></div>
              <div className="flex items-center justify-between gap-4 text-white/70"><span>{t('admin.chart_spam')}</span><span className="font-latin tabular-nums">{hp.spam}</span></div>
              <div className="flex items-center justify-between gap-4 text-white/70"><span>{t('admin.chart_sos')}</span><span className="font-latin tabular-nums">{hp.sos}</span></div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
