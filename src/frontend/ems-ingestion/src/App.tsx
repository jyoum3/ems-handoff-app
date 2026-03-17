/**
 * App.tsx — EMS Ingestion PWA: Root State Machine (Sprint 3)
 * ===========================================================
 *
 * THREE-STATE MACHINE:
 *   'idle'      → New Patient tab active. PatientForm visible.
 *                 On submit → POST /api/ems-to-db → 'submitted'.
 *   'submitted' → Active Patient tab shows LiveHandoffView (Sprint 3).
 *                 New Patient tab always accessible (amber warning banner).
 *                 History tab always accessible.
 *   'arrived'   → Success screen shown under tab bar.
 *                 "Start New Patient" → back to 'idle'.
 *
 * TAB STRUCTURE (Sprint 3):
 *   [ Active Patient ]  — only when appState === 'submitted'
 *   [ New Patient ]     — always
 *   [ History ]         — always
 *
 * SESSION RESTORE (PWA re-open):
 *   useEmsSession reads sessionStorage — if valid and non-expired (< 12h),
 *   ShiftCheckIn is skipped automatically.
 *   useHandoffState reads "ems_active_handoff" — if present, appState
 *   starts as 'submitted' so medic sees their active patient immediately.
 *
 * HOSPITAL HISTORY TRACKING:
 *   On every successful first submit, the hospitalId is appended to
 *   sessionStorage['ems_hospital_history'] (JSON array of strings).
 *   EmsHistoryTab uses this to know which hospital archives to query.
 */

import { useState, useEffect, useCallback } from 'react';
import { useEmsSession } from './hooks/useEmsSession';
import { useHandoffState } from './hooks/useHandoffState';
import { fetchActiveBundle, recoverHandoff } from './services/api';
import { useEmsSignalR } from './hooks/useEmsSignalR';
import type { SignalRConnectionState } from './hooks/useEmsSignalR';
import ShiftCheckIn from './components/ShiftCheckIn/ShiftCheckIn';
import EmsBanner from './components/EmsBanner/EmsBanner';
import PatientForm from './components/PatientForm/PatientForm';
import LiveHandoffView from './components/LiveHandoffView/LiveHandoffView';
import EmsHistoryTab from './components/EmsHistoryTab/EmsHistoryTab';
import type { FHIRBundle } from './types/fhir';
import styles from './App.module.css';

// ---------------------------------------------------------------------------
// Tab types
// ---------------------------------------------------------------------------

type TabId = 'patient' | 'new' | 'history';

// ---------------------------------------------------------------------------
// Hospital history sessionStorage helpers
// ---------------------------------------------------------------------------

function getHospitalHistory(): string[] {
  try {
    const raw = sessionStorage.getItem('ems_hospital_history');
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function addHospitalToHistory(hospitalId: string): void {
  const existing = getHospitalHistory();
  if (!existing.includes(hospitalId)) {
    sessionStorage.setItem('ems_hospital_history', JSON.stringify([...existing, hospitalId]));
  }
}

// ---------------------------------------------------------------------------
// Tab CSS — inline to avoid dependency on App.module.css tab classes
// ---------------------------------------------------------------------------

const TAB_BAR: React.CSSProperties = {
  display: 'flex',
  gap: 0,
  borderBottom: '1px solid #334155',
  background: '#0f172a',
  flexShrink: 0,
};

function tabStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: '12px',
    background: 'none',
    border: 'none',
    borderBottom: active ? '2px solid #F97316' : '2px solid transparent',
    color: active ? '#F97316' : '#64748b',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '14px',
    transition: 'color 0.15s, border-color 0.15s',
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const { session, isSessionActive, startSession, clearSession } = useEmsSession();
  const handoffState = useHandoffState();

  // Default tab: 'patient' when submitted, 'new' when idle
  const [activeTab, setActiveTab] = useState<TabId>(
    handoffState.appState === 'submitted' ? 'patient' : 'new',
  );

  // Real-time SignalR connection state — bubbled up from LiveHandoffView
  const [emsConnectionState, setEmsConnectionState] = useState<SignalRConnectionState>('disconnected');
  // Sprint 4.1: Last sync timestamp — bubbled up from LiveHandoffView for stale data guard
  const [emsLastSyncAt, setEmsLastSyncAt] = useState<Date | null>(null);

  // ── Auto-restore bundle after refresh / post-divert edge case ─────────
  // When appState='submitted' but currentBundle=null (e.g. page refresh),
  // fetch the active bundle from Cosmos using the stored bundleId+hospitalId.
  const [isFetchingBundle, setIsFetchingBundle] = useState(false);
  useEffect(() => {
    if (
      handoffState.appState !== 'submitted' ||
      handoffState.currentBundle !== null ||
      !handoffState.bundleId ||
      !handoffState.hospitalId ||
      isFetchingBundle
    ) return;
    setIsFetchingBundle(true);
    fetchActiveBundle(handoffState.bundleId, handoffState.hospitalId)
      .then((found) => {
        if (found) handoffState.handleEditSubmit(found);
      })
      .catch(() => { /* silent — user sees "not found" message below */ })
      .finally(() => setIsFetchingBundle(false));
  // Intentionally omit handoffState.hospitalId from deps — divert changes hospitalId but keeps
  // bundleId the same. Re-running the fetch on every hospitalId change creates a race condition
  // where the bundle may not yet be visible at the new hospital partition (Cosmos replication lag).
  // The bundleId changing (page refresh restore) is the only trigger we need.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoffState.appState, handoffState.currentBundle, handoffState.bundleId]);

  // ── App-level SignalR: restore listener for the 'arrived' state ───────
  // WHY THIS EXISTS:
  //   When a patient arrives (medic or hospital triggered), LiveHandoffView
  //   unmounts because appState transitions away from 'submitted'. Its
  //   internal useEmsSignalR connection drops. If the hospital then clicks
  //   "Restore" (recover_handoff_bp broadcasts action='restored' scoped to
  //   userId=bundleId), there is no listener active — the event fires into void.
  //
  // HOW IT WORKS:
  //   appLevelSignalRBundleId is only non-null when appState === 'arrived'.
  //   useHandoffState.handleArrived() now preserves bundleId/hospitalId (does
  //   NOT null them out) specifically to enable this subscription.
  //   When action='restored' arrives, recoverHandoff() fetches the full bundle
  //   → handleRestored() → appState becomes 'submitted' → LiveHandoffView
  //   remounts with its own connection → appLevelSignalRBundleId becomes null
  //   → this App-level connection drops. Only ONE active connection at a time.
  //
  // STATE MACHINE FOR THIS CONNECTION:
  //   submitted → null  (LiveHandoffView owns the connection)
  //   arrived   → bundleId  (this listener is active)
  //   idle      → null  (bundleId was cleared by handleClear)
  const appLevelSignalRBundleId = handoffState.appState === 'arrived'
    ? handoffState.bundleId
    : null;

  useEmsSignalR(
    appLevelSignalRBundleId,
    useCallback(
      (data: { action: string; bundleId: string; hospitalId: string }) => {
        if (data.action !== 'restored') return;
        // Hospital restored the patient while medic was on the arrived screen.
        // Fetch the full bundle from Cosmos and re-enter live transport mode.
        recoverHandoff(data.bundleId, data.hospitalId)
          .then((restoredBundle) => {
            addHospitalToHistory(restoredBundle.hospitalId);
            handoffState.handleRestored(restoredBundle);
            setActiveTab('patient');
          })
          .catch(() => {
            // Restore fetch failed — medic can use the History tab to retry.
            // Not surfacing an error here to avoid confusion on the success screen.
          });
      },
      // recoverHandoff, addHospitalToHistory, setActiveTab are module-level / useState setter (stable).
      // handoffState.handleRestored is a closure over stable useState setters — safe to omit.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    ),
    useCallback(() => {}, []), // No chat listener needed at App level
  );

  // ── Gate 0: No active shift → ShiftCheckIn blocks everything ──────────
  if (!isSessionActive) {
    return <ShiftCheckIn onComplete={startSession} />;
  }

  // ── Handler: first submission → switch to Active Patient tab ───────────
  const handleFirstSubmit = (bundle: FHIRBundle) => {
    addHospitalToHistory(bundle.hospitalId);
    handoffState.handleFirstSubmit(bundle);
    setActiveTab('patient');
  };

  // ── Handler: arrival confirmed → transition to 'arrived' state ─────────
  // NOTE: handoffState.handleArrived() now goes to appState='arrived' (NOT
  // 'idle') and preserves bundleId/hospitalId so the App-level SignalR above
  // can stay subscribed during the success screen to catch hospital restores.
  const handleArrived = () => {
    handoffState.handleArrived();
    setActiveTab('new');
  };

  // ── Handler: "Start New Patient" — true reset to idle ──────────────────
  // Called from the 'arrived' success screen. Clears bundleId/hospitalId
  // which causes appLevelSignalRBundleId → null → App-level SignalR drops.
  const handleClear = () => {
    handoffState.handleClear();
    setActiveTab('new');
  };

  // ── Handler: restored → switch to Active Patient tab ──────────────────
  const handleRestored = (bundle: FHIRBundle) => {
    handoffState.handleRestored(bundle);
    setActiveTab('patient');
  };

  // ── Handler: diverted → stays on Active Patient tab ───────────────────
  const handleDiverted = (newBundle: FHIRBundle) => {
    addHospitalToHistory(newBundle.hospitalId);
    handoffState.handleDiverted(newBundle);
    // Explicitly snap to the Active Patient tab after divert — prevents blank
    // screen if a tab switch occurred while the divert modal was open.
    setActiveTab('patient');
  };

  return (
    <div className={styles.app}>
      {/* EmsBanner persists across all post-login states */}
      <EmsBanner
        session={session!}
        onSwitchShift={clearSession}
        connectionState={handoffState.appState === 'submitted' ? emsConnectionState : undefined}
        lastSyncAt={handoffState.appState === 'submitted' ? emsLastSyncAt : undefined}
      />

      {/* ── Tab Bar ────────────────────────────────────────────────── */}
      <div style={TAB_BAR}>
        {/* Active Patient — only visible when submitted */}
        {handoffState.appState === 'submitted' && (
          <button
            type="button"
            style={tabStyle(activeTab === 'patient')}
            onClick={() => setActiveTab('patient')}
          >
            🚑 Active Patient
          </button>
        )}
        {/* New Patient — always */}
        <button
          type="button"
          style={tabStyle(activeTab === 'new')}
          onClick={() => setActiveTab('new')}
        >
          ➕ New Patient
        </button>
        {/* History — always */}
        <button
          type="button"
          style={tabStyle(activeTab === 'history')}
          onClick={() => setActiveTab('history')}
        >
          📋 History
        </button>
      </div>

      {/* ── 'arrived' success screen (under tab bar, above content) ── */}
      {/* NOTE: appState='arrived' preserves bundleId so the App-level SignalR  */}
      {/* above can catch a hospital restore. "Start New Patient" calls           */}
      {/* handleClear (not handleArrived) — that is the true idle reset that     */}
      {/* nulls bundleId and disconnects the App-level SignalR listener.          */}
      {handoffState.appState === 'arrived' && (
        <div style={{
          padding: '2rem', textAlign: 'center',
          background: 'rgba(34,197,94,0.06)', borderBottom: '1px solid #22c55e',
        }}>
          <div style={{ fontSize: '36px', marginBottom: '8px' }}>✅</div>
          <h2 style={{ color: '#4ade80', fontSize: '20px', fontWeight: 700, marginBottom: '8px' }}>
            Patient Arrived
          </h2>
          <p style={{ color: '#94a3b8', marginBottom: '20px', fontSize: '14px' }}>
            Handoff complete. The patient has been transferred to the ED team.
          </p>
          <button
            type="button"
            onClick={handleClear}
            style={{
              padding: '12px 28px', background: '#F97316', border: 'none',
              borderRadius: '8px', color: '#fff', fontSize: '14px',
              fontWeight: 700, cursor: 'pointer',
            }}
          >
            🚑 Start New Patient
          </button>
        </div>
      )}

      {/* ── Tab Content ────────────────────────────────────────────── */}

      {/* Tab 1 — Active Patient */}
      {handoffState.appState === 'submitted' && activeTab === 'patient' && (
        handoffState.currentBundle
          ? (
            <LiveHandoffView
              bundle={handoffState.currentBundle}
              bundleId={handoffState.bundleId!}
              hospitalId={handoffState.hospitalId!}
              session={session!}
              onVitalsUpdated={handoffState.handleEditSubmit}
              onArrived={handleArrived}
              onDiverted={handleDiverted}
              onConnectionStateChange={setEmsConnectionState}
              onLastSyncChange={setEmsLastSyncAt}
            />
          )
          : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '40px 20px', color: '#94a3b8' }}>
              {isFetchingBundle ? (
                <>
                  <div style={{ fontSize: '28px' }}>⏳</div>
                  <div style={{ fontSize: '15px', fontWeight: 600, color: '#e2e8f0' }}>Restoring your active patient…</div>
                  <div style={{ fontSize: '13px', color: '#64748b' }}>Fetching handoff from {handoffState.hospitalId}</div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: '28px' }}>⚠️</div>
                  <div style={{ fontSize: '15px', fontWeight: 600, color: '#fbbf24' }}>Patient not found in active queue</div>
                  <div style={{ fontSize: '13px', color: '#64748b', textAlign: 'center' }}>
                    The patient may have already arrived or been diverted.<br />Check the History tab.
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveTab('history')}
                    style={{ marginTop: '8px', padding: '10px 20px', background: 'rgba(249,115,22,0.12)', border: '1px solid #F97316', borderRadius: '8px', color: '#fb923c', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
                  >
                    📋 Open History Tab
                  </button>
                </>
              )}
            </div>
          )
      )}

      {/* Tab 2 — New Patient (always rendered, PatientForm always mounted) */}
      {activeTab === 'new' && (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {/* Amber warning banner when active patient exists */}
          {handoffState.appState === 'submitted' && (
            <div style={{
              margin: '10px 12px 0',
              padding: '10px 14px',
              background: 'rgba(251,191,36,0.08)',
              border: '1px solid #fbbf24',
              borderRadius: '8px',
              fontSize: '13px',
              color: '#fde68a',
            }}>
              ⚠️ You have an active patient. Submitting a new form will not affect the current handoff.
            </div>
          )}
          <PatientForm
            session={session!}
            onSubmitted={handleFirstSubmit}
          />
        </div>
      )}

      {/* Tab 3 — History */}
      {activeTab === 'history' && (
        <EmsHistoryTab
          session={session!}
          currentBundleId={handoffState.bundleId}
          onRestored={handleRestored}
        />
      )}
    </div>
  );
}
