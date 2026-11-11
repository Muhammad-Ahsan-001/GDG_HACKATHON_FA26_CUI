import { useEffect, useState } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { supabase } from '../../lib/supabase'
import type { AssignmentStatus } from '../../lib/types'

/**
 * NGO / responder: their organisation's open assignment for a cluster (my_assignments only returns rows of orgs
 * the caller owns), so the pin sheet can offer "Go to dashboard to claim". Null for citizens / no assignment.
 */
export function useFoodAssignment(clusterId: string, enabled: boolean): { id: string; status: AssignmentStatus } | null {
  const { role, user } = useAuth()
  const isOrg = role === 'ngo' || role === 'responder'
  const uid = user?.id
  const [found, setFound] = useState<{ key: string; value: { id: string; status: AssignmentStatus } | null } | null>(null)
  const key = `${uid}|${clusterId}`
  const active = enabled && isOrg && Boolean(uid)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    void supabase
      .from('my_assignments')
      .select('assignment_id, status, alerted_at')
      .eq('cluster_id', clusterId)
      .order('alerted_at', { ascending: false })
      .limit(5)
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) { setFound({ key, value: null }); return }
        const rows = (data ?? []) as { assignment_id: string; status: AssignmentStatus }[]
        // prefer one still waiting to be claimed, then any open one
        const pickRow = rows.find((r) => r.status === 'alerted') ?? rows.find((r) => r.status !== 'resolved') ?? rows[0]
        setFound({ key, value: pickRow ? { id: pickRow.assignment_id, status: pickRow.status } : null })
      })
    return () => { cancelled = true }
  }, [active, clusterId, key])

  return active && found?.key === key ? found.value : null
}
