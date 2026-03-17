// LiveQueue.tsx — Sprint 5: Sugar column, Required Resources header,
//                 userSession/comments props

import type { CommentMap, FHIRBundle, HospitalId } from '../../types/fhir'
import PatientRow from './PatientRow'
import styles from './LiveQueue.module.css'

interface UserSessionLike {
  role: string
  firstName: string
  lastName: string
  displayLabel?: string
  canArrivePatients?: boolean
}

interface LiveQueueProps {
  bundles: FHIRBundle[]
  flashIds: Set<string>
  hydrationStatus: 'idle' | 'loading' | 'hydrated' | 'error'
  hospitalId: HospitalId
  now: Date
  onViewDetails: (bundle: FHIRBundle) => void
  onArrived: (bundle: FHIRBundle) => void
  canArrivePatients: boolean
  authorLabel: string | null
  userSession?: UserSessionLike | null
  comments?: CommentMap
  // Sprint 4.1: Notification tracking
  unreadChatIds?: Set<string>
  unreadEditIds?: Set<string>
  markChatRead?: (bundleId: string) => void
  markEditRead?: (bundleId: string) => void
}

export default function LiveQueue({
  bundles,
  flashIds,
  hydrationStatus,
  hospitalId,
  now,
  onViewDetails,
  onArrived,
  canArrivePatients,
  authorLabel,
  userSession,
  comments = {},
  unreadChatIds,
  unreadEditIds,
  markChatRead,
  markEditRead,
}: LiveQueueProps) {
  if (hydrationStatus === 'loading') {
    return (
      <div className={styles.emptyState}>
        <div className={styles.spinner} />
        <p className={styles.emptyText}>Loading active patients…</p>
      </div>
    )
  }

  if (hydrationStatus === 'error') {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyIcon}>⚠️</span>
        <p className={styles.emptyText}>Failed to load patient queue.</p>
        <p className={styles.emptySubtext}>SignalR is still active — new arrivals will appear automatically.</p>
      </div>
    )
  }

  if (bundles.length === 0) {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyIcon}>🟢</span>
        <p className={styles.emptyText}>No active inbound patients</p>
        <p className={styles.emptySubtext}>New EMS handoffs will appear here in real time.</p>
      </div>
    )
  }

  return (
    <div>
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr className={styles.headerRow}>
              <th style={{ width: '20px', padding: '0 2px' }}>{/* notify */}</th>
              <th className={styles.th}>ETA</th>
              <th className={styles.th}>Unit</th>
              <th className={styles.th}>Status</th>
              <th className={styles.th}>Patient</th>
              <th className={styles.th}>Alert Badges</th>
              <th className={styles.th}>ESI</th>
              <th className={styles.th}>Chief Complaint</th>
              <th className={styles.th}>HR</th>
              <th className={styles.th}>BP</th>
              <th className={styles.th}>RR</th>
              <th className={styles.th}>SpO₂</th>
              <th className={styles.th}>Temp</th>
              <th className={styles.th}>Sugar</th>
              <th className={styles.th}>Required Resources</th>
              <th className={styles.th}>Comments</th>
              <th className={styles.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {bundles.map((bundle) => (
              <PatientRow
                key={bundle.id}
                bundle={bundle}
                isFlashing={flashIds.has(bundle.id)}
                hospitalId={hospitalId}
                now={now}
                onViewDetails={onViewDetails}
                onArrived={onArrived}
                canArrivePatients={canArrivePatients}
                authorLabel={authorLabel}
                userSession={userSession ?? null}
                comments={comments[bundle.id] ?? []}
                unreadChatIds={unreadChatIds}
                unreadEditIds={unreadEditIds}
                markChatRead={markChatRead}
                markEditRead={markEditRead}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
