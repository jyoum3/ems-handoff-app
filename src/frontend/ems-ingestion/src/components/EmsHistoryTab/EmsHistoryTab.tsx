/**
 * EmsHistoryTab.tsx — Completed Handoffs History
 * ================================================
 * Phase 4 Sprint 3 — Shows arrived patients for this unit/shift.
 *
 * On mount: fetches from /api/fetch-archive for each hospitalId in
 * sessionStorage['ems_hospital_history'], filters by medicUnit.
 *
 * Restore: two-step confirm (with active patient warning if needed).
 */

import { useState, useEffect } from 'react';
import type { FHIRBundle, EmsSession } from '../../types/fhir';
import { getHandoffHistory, recoverHandoff } from '../../services/api';
import styles from './EmsHistoryTab.module.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPatientName(bundle: FHIRBundle): string {
  const patient = bundle.entry
    .map((e) => e.resource)
    .find((r) => r.resourceType === 'Patient') as
    | { resourceType: 'Patient'; name?: { family?: string; given?: string[] }[] }
    | undefined;
  if (!patient?.name?.[0]) return 'Unknown';
  const n = patient.name[0];
  const family = (n.family ?? '').toUpperCase();
  const given = n.given?.[0] ?? '';
  return [family, given].filter(Boolean).join(', ');
}

function getChiefComplaint(bundle: FHIRBundle): string {
  const encounter = bundle.entry
    .map((e) => e.resource)
    .find((r) => r.resourceType === 'Encounter') as
    | { resourceType: 'Encounter'; reasonCode?: { text?: string }[]; priority?: { text?: string } }
    | undefined;
  return encounter?.reasonCode?.[0]?.text ?? '—';
}

function getEsi(bundle: FHIRBundle): string {
  const encounter = bundle.entry
    .map((e) => e.resource)
    .find((r) => r.resourceType === 'Encounter') as
    | { resourceType: 'Encounter'; priority?: { text?: string } }
    | undefined;
  return encounter?.priority?.text ?? '—';
}

function formatArrivedAt(bundle: FHIRBundle): string {
  if (!bundle.arrivedAt) return '—';
  try {
    const d = new Date(bundle.arrivedAt);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${mm}/${dd}/${yyyy} ${hh}:${min}`;
  } catch {
    return '—';
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface EmsHistoryTabProps {
  session: EmsSession;
  currentBundleId: string | null;
  onRestored: (bundle: FHIRBundle) => void;
}

// Per-row restore state
interface RestoreState {
  step: 0 | 1;   // 0 = initial, 1 = confirm
  loading: boolean;
  error: string;
}

// ---------------------------------------------------------------------------
// EmsHistoryTab
// ---------------------------------------------------------------------------

export default function EmsHistoryTab({
  session,
  currentBundleId,
  onRestored,
}: EmsHistoryTabProps) {
  const [bundles, setBundles] = useState<FHIRBundle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [restoreStates, setRestoreStates] = useState<Record<string, RestoreState>>({});

  // ── Load history on mount ────────────────────────────────────────────────
  useEffect(() => {
    async function loadHistory() {
      setIsLoading(true);
      try {
        // Always query ALL hospitals regardless of sessionStorage.
        // Rationale: sessionStorage['ems_hospital_history'] was previously the
        // gate, but it was unreliable because:
        //   1. A divert bug (now fixed) could write undefined into the array,
        //      causing the diverted-to hospital to never be queried.
        //   2. A page refresh can wipe sessionStorage entirely on some browsers.
        //   3. A medic could open History on a fresh browser tab mid-shift.
        // Querying all 3 hospitals is low-cost (3 parallel fetches of ~3KB each)
        // and ensures no arrived patients are ever silently missing from the tab.
        const ALL_HOSPITALS = ['HUP-PAV', 'HUP-PRESBY', 'HUP-CEDAR'];

        // Fetch from all hospitals in parallel — failures are isolated per hospital
        const results = await Promise.allSettled(
          ALL_HOSPITALS.map((hId) => getHandoffHistory(hId)),
        );

        const all: FHIRBundle[] = [];
        for (const r of results) {
          if (r.status === 'fulfilled') all.push(...r.value);
        }

        // Filter strictly by this medic's unit number.
        // String comparison avoids type-mismatch (medicUnit stored as number
        // in Cosmos but compared as string via session.medicUnit).
        // NO fallback to "show all" — if the filter produces zero results, the
        // medic simply has no history yet. Showing other units' patients would
        // be a clinical and HIPAA concern.
        const filtered = all.filter(
          (b) => String(b.medicUnit) === String(session.medicUnit),
        );

        // Sort newest arrivedAt first
        filtered.sort((a, b) => {
          const ta = a.arrivedAt ? new Date(a.arrivedAt).getTime() : 0;
          const tb = b.arrivedAt ? new Date(b.arrivedAt).getTime() : 0;
          return tb - ta;
        });

        setBundles(filtered);
      } catch (err) {
        console.error('[EmsHistoryTab] load error:', err);
      } finally {
        setIsLoading(false);
      }
    }
    loadHistory();
  }, [session.medicUnit]);

  // ── Restore handler ──────────────────────────────────────────────────────
  const handleRestoreClick = async (bundle: FHIRBundle) => {
    const bid = bundle.id;
    const state = restoreStates[bid] ?? { step: 0, loading: false, error: '' };

    // Step 0 → 1: show confirm (or skip to confirm if no active patient)
    if (state.step === 0) {
      setRestoreStates((prev) => ({
        ...prev,
        [bid]: { step: currentBundleId ? 1 : 1, loading: false, error: '' },
      }));
      return;
    }

    // Step 1 → execute restore
    setRestoreStates((prev) => ({
      ...prev,
      [bid]: { ...prev[bid], loading: true, error: '' },
    }));
    try {
      const restored = await recoverHandoff(bid, bundle.hospitalId);
      // Remove from list
      setBundles((prev) => prev.filter((b) => b.id !== bid));
      onRestored(restored);
    } catch {
      setRestoreStates((prev) => ({
        ...prev,
        [bid]: { step: 0, loading: false, error: 'Restore failed — try again' },
      }));
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Loading completed handoffs…</div>
      </div>
    );
  }

  if (bundles.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.empty}>
          No completed handoffs yet for Unit #{session.medicUnit} this shift.<br />
          Arrived patients will appear here.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <h2 className={styles.heading}>
        Completed Handoffs — Unit #{session.medicUnit}
      </h2>

      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Arrived</th>
              <th>Patient</th>
              <th>Hospital</th>
              <th>ESI</th>
              <th>Chief Complaint</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {bundles.map((bundle) => {
              const bid = bundle.id;
              const rs = restoreStates[bid] ?? { step: 0, loading: false, error: '' };

              return (
                <tr key={bid}>
                  <td style={{ whiteSpace: 'nowrap', color: '#94a3b8', fontSize: '12px' }}>
                    {formatArrivedAt(bundle)}
                  </td>
                  <td style={{ fontWeight: 600 }}>{getPatientName(bundle)}</td>
                  <td>
                    <span className={styles.hospitalBadge}>{bundle.hospitalId}</span>
                  </td>
                  <td>
                    <span className={styles.esiBadge}>{getEsi(bundle)}</span>
                  </td>
                  <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {getChiefComplaint(bundle)}
                  </td>
                  <td>
                    <div>
                      <button
                        type="button"
                        className={styles.restoreBtn}
                        onClick={() => handleRestoreClick(bundle)}
                        disabled={rs.loading}
                      >
                        {rs.loading
                          ? '⏳ Restoring…'
                          : rs.step === 1
                          ? '✅ Confirm Restore'
                          : '🔄 Restore'}
                      </button>
                      {rs.step === 1 && currentBundleId && !rs.loading && (
                        <div className={styles.warnText}>
                          ⚠️ You have an active patient. Restoring will replace your current view.
                        </div>
                      )}
                      {rs.error && (
                        <div className={styles.error}>{rs.error}</div>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
