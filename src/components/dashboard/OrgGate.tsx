import { Building2, Clock, Plus, RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useI18n } from '../../lib/i18n'
import { Button } from '../ui'
import type { DashOrg } from './types'
import { OrgTypeIcon, useOrgTypeLabel } from './orgTypes'

/** No organisation yet -> register CTA. */
export function NoOrgCta() {
  const { t } = useI18n()
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 p-6 pt-12 text-center">
      <span className="inline-flex size-24 items-center justify-center rounded-full bg-brand-100 text-brand-700">
        <Building2 className="size-12" />
      </span>
      <h1 className="text-2xl font-extrabold">{t('dashboard.noOrgTitle')}</h1>
      <p className="text-slate-600">{t('dashboard.noOrgBody')}</p>
      <Link
        to="/org/register"
        className="inline-flex min-h-14 items-center justify-center gap-2 rounded-2xl bg-brand-700 px-6 text-lg font-bold text-white hover:bg-brand-900 active:scale-[0.98]"
      >
        <Plus className="size-6" /> {t('dashboard.registerOrg')}
      </Link>
    </div>
  )
}

/** Organisation registered but not yet approved by an admin. */
export function PendingApproval({ orgs, onRecheck, checking }: { orgs: DashOrg[]; onRecheck: () => void; checking: boolean }) {
  const { t } = useI18n()
  const typeLabel = useOrgTypeLabel()
  return (
    <div className="mx-auto max-w-lg p-4 pt-8">
      <div role="status" className="flex flex-col items-center gap-3 rounded-3xl border-2 border-amber-300 bg-amber-50 p-6 text-center">
        <span className="inline-flex size-20 items-center justify-center rounded-full bg-amber-200 text-amber-800">
          <Clock className="size-10" />
        </span>
        <h1 className="text-xl font-extrabold text-amber-900">{t('dashboard.pendingTitle')}</h1>
        <ul className="w-full space-y-2">
          {orgs.map((o) => (
            <li key={o.id} className="flex items-center gap-3 rounded-2xl bg-white p-3 text-start">
              <OrgTypeIcon type={o.org_type} />
              <span className="min-w-0">
                <span className="block truncate font-bold">{o.name}</span>
                <span className="block text-sm text-slate-500">{typeLabel(o.org_type)}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="text-amber-900">{t('dashboard.pendingBody')}</p>
        <Button variant="secondary" size="lg" icon={RefreshCw} loading={checking} onClick={onRecheck}>
          {t('dashboard.checkAgain')}
        </Button>
      </div>
    </div>
  )
}
