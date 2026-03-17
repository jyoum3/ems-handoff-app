import { useMemo } from 'react'
import type { HospitalId } from './types/fhir'
import Dashboard from './components/Dashboard/Dashboard'
import styles from './App.module.css'

// =============================================================================
// Hospital Configuration
// =============================================================================

const VALID_HOSPITALS: HospitalId[] = ['HUP-PAV', 'HUP-PRESBY', 'HUP-CEDAR']

const HOSPITAL_LABELS: Record<HospitalId, { name: string; shortName: string }> = {
  'HUP-PAV': { name: 'HUP Pavilion', shortName: 'Pavilion' },
  'HUP-PRESBY': { name: 'HUP Presbyterian', shortName: 'Presbyterian' },
  'HUP-CEDAR': { name: 'HUP Cedar', shortName: 'Cedar' },
}

// =============================================================================
// App — Hospital Bootstrap & Selector
// =============================================================================

/**
 * App.tsx — Root component that bootstraps the hospital context.
 *
 * RESPONSIBILITY:
 * Reads the ?hospitalId= URL query parameter and validates it against the
 * allowlist. This single value drives the ENTIRE data isolation chain:
 *
 *   ?hospitalId=HUP-PAV
 *     → passed to usePatientQueue → GET /api/active-handoffs?hospitalId=HUP-PAV
 *     → passed to useSignalR → GET /api/negotiate?hospitalId=HUP-PAV
 *     → SignalR JWT scoped to userId=HUP-PAV
 *     → Only HUP-PAV broadcasts received via WebSocket
 *
 * If no valid hospitalId is in the URL, the hospital selector screen is
 * shown instead of the dashboard. This is the intended default state for
 * a fresh browser tab or a new workstation being configured.
 *
 * WORKSTATION SETUP:
 * Bookmark the URL with the hospitalId for each ward workstation:
 *   Resus Bay tablet:  http://{swa-url}/?hospitalId=HUP-PAV
 *   Fast Track tablet: http://{swa-url}/?hospitalId=HUP-PRESBY
 * The nurse never touches the URL — they open the bookmark and see their
 * hospital's queue immediately.
 */
export default function App() {
  const hospitalId = useMemo<HospitalId | null>(() => {
    const params = new URLSearchParams(window.location.search)
    const raw = params.get('hospitalId')
    if (raw && (VALID_HOSPITALS as string[]).includes(raw)) {
      return raw as HospitalId
    }
    return null
  }, [])

  // ── Hospital Selector Screen ───────────────────────────────────────────────
  // Shown when no valid hospitalId is in the URL.
  // Each button navigates to /?hospitalId=X, which causes a page reload and
  // re-reads the URL parameter above, mounting the correct Dashboard.
  if (!hospitalId) {
    return (
      <div className={styles.selectorScreen}>
        <div className={styles.selectorCard}>
          <div className={styles.selectorIcon}>🚑</div>
          <h1 className={styles.selectorTitle}>EMS Handoff Dashboard</h1>
          <p className={styles.selectorSubtitle}>
            Select your emergency department to begin
          </p>
          <div className={styles.selectorButtons}>
            {VALID_HOSPITALS.map((id) => (
              <button
                key={id}
                className={styles.selectorButton}
                onClick={() => {
                  window.location.href = `/?hospitalId=${id}`
                }}
              >
                <span className={styles.selectorHospitalName}>
                  {HOSPITAL_LABELS[id].name}
                </span>
                <span className={styles.selectorHospitalId}>{id}</span>
              </button>
            ))}
          </div>
          <p className={styles.selectorNote}>
            This dashboard is for authorized ED staff only.
          </p>
        </div>
      </div>
    )
  }

  return (
    <Dashboard
      hospitalId={hospitalId}
      hospitalLabel={HOSPITAL_LABELS[hospitalId].name}
    />
  )
}
