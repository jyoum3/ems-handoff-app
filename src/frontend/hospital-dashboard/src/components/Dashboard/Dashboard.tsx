/**
 * Dashboard.tsx — Main Layout, Tab Controller, and Clock Provider
 * ================================================================
 *
 * ARCHITECTURE:
 * This component is the integration point for all four layers:
 *   1. useUser       → owns shift session state (role, name, permissions)
 *   2. usePatientQueue → owns all patient state (liveQueue, history, flashIds)
 *   3. useSignalR → manages WebSocket lifecycle, calls back into usePatientQueue
 *   4. Components → render the state, dispatch actions via callbacks
 *
 * DATA FLOW:
 *   SignalR event → useSignalR.onMessage → handleHandoffUpdate (usePatientQueue)
 *     → queueReducer dispatches HANDOFF_UPDATE → state updates → re-render
 *
 * SPRINT 4 ADDITIONS:
 * ────────────────────
 * 1. useUser() — Shift Session Auth:
 *    Reads sessionStorage for an active UserSession. If session === null
 *    (first load, tab close, or 12h expiry), the RolePicker overlay is
 *    rendered on top of the dashboard. Once the nurse completes check-in,
 *    startShift() stores the session and the overlay disappears.
 *
 *    WHY useUser IS IN DASHBOARD (not App.tsx):
 *    Dashboard is the component that needs session data — it passes
 *    canArrivePatients to LiveQueue/PatientRow and session info to
 *    HospitalBanner. Hoisting to App.tsx would require threading session
 *    through without any gain. Co-location is clearer.
 *
 * 2. handleArrivedOptimistic — P0 Bug Fix:
 *    Called by PatientRow immediately after arrivePatient() returns 200.
 *    Dispatches HANDOFF_UPDATE for instant removal from liveQueue on the
 *    calling browser WITHOUT waiting for the SignalR round-trip (~100-500ms).
 *    The direct SignalR broadcast in arrival_bp.py handles all OTHER
 *    connected browser instances. This is idempotent — if the SignalR event
 *    also arrives, the reducer no-ops on an already-absent key.
 *
 * THE `now` CLOCK — Single Source of Time for All Rows:
 * ──────────────────────────────────────────────────────
 * Dashboard owns ONE setInterval that ticks every 60 seconds. All rows
 * compute their ETA from the SAME `now` in the SAME render cycle.
 * One clock = all rows tick in perfect unison.
 *
 * SORTED QUEUE — ESI-Primary, ETA-Secondary:
 * ────────────────────────────────────────────
 * An ESI-1 STEMI arriving in 30 minutes is more critical than an ESI-4
 * sprained ankle arriving in 2 minutes. Sorting by ESI first ensures the
 * most critical patients are ALWAYS at the top, regardless of ETA.
 */

import { useState, useMemo, useEffect, useCallback } from 'react'
import type { HospitalId, FHIRBundle } from '../../types/fhir'
import { usePatientQueue } from '../../hooks/usePatientQueue'
import { useSignalR } from '../../hooks/useSignalR'
import { useUser } from '../../hooks/useUser'
import { getEncounter, getESILevel } from '../../utils/fhirHelpers'
import HospitalBanner from '../HospitalBanner/HospitalBanner'
import LiveQueue from '../LiveQueue/LiveQueue'
import HistoryTab from '../HistoryTab/HistoryTab'
import PatientDetailModal from '../PatientDetailModal/PatientDetailModal'
import RolePicker from '../RolePicker/RolePicker'
import styles from './Dashboard.module.css'

interface DashboardProps {
  hospitalId: HospitalId
  hospitalLabel: string
}

type ActiveTab = 'live' | 'history'

export default function Dashboard({ hospitalId, hospitalLabel }: DashboardProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('live')
  // Fix 6B: Track by ID not snapshot — ensures modal always reads latest liveQueue data
  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(null)
  const [modalMode, setModalMode] = useState<'live' | 'archive'>('live')

  // ── Shift Session (Sprint 4 — Role Picker Auth) ───────────────────────────
  //
  // useUser reads from sessionStorage on mount. If no valid session exists
  // (first load, tab close, or 12h expiry), session === null and we render
  // the RolePicker overlay on top of the dashboard.
  const { session, startShift, endShift } = useUser()

  // ── State Management ───────────────────────────────────────────────────────
  const { state, handleHandoffUpdate, handleCommentUpdate, handleChatUpdate, setSignalRStatus, markChatRead, markEditRead, setChat } =
    usePatientQueue(hospitalId)

  // ── Optimistic Arrival Handler (P0 Bug Fix — Sprint 4) ────────────────────
  const handleArrivedOptimistic = useCallback((bundle: FHIRBundle) => {
    handleHandoffUpdate({
      ...bundle,
      handoffStatus: 'arrived',
      arrivedAt: bundle.arrivedAt ?? new Date().toISOString(),
    })
  }, [handleHandoffUpdate])

  // ── SignalR Connection ─────────────────────────────────────────────────────
  useSignalR({
    hospitalId,
    onMessage: handleHandoffUpdate,
    onStatusChange: setSignalRStatus,
    onCommentUpdate: handleCommentUpdate,
    onChatUpdate: handleChatUpdate,  // Sprint 4.1: bidirectional chat
  })

  // ── Reactive Clock (Single 60-Second Tick for ALL Patient Rows) ────────────
  const [now, setNow] = useState<Date>(() => new Date())

  useEffect(() => {
    const intervalId = setInterval(() => {
      setNow(new Date())
    }, 60_000)
    return () => clearInterval(intervalId)
  }, [])

  // ── Sorted Live Queue ──────────────────────────────────────────────────────
  const sortedQueue = useMemo(() => {
    const esiNum = (esiText: string): number => {
      const m = esiText.match(/\d+/)
      return m ? parseInt(m[0], 10) : 99
    }
    return Object.values(state.liveQueue).sort((a, b) => {
      const esiA = esiNum(getESILevel(getEncounter(a)))
      const esiB = esiNum(getESILevel(getEncounter(b)))
      if (esiA !== esiB) return esiA - esiB
      const etaA = getEncounter(a)?.period?.end ?? ''
      const etaB = getEncounter(b)?.period?.end ?? ''
      return etaA.localeCompare(etaB)
    })
  }, [state.liveQueue])

  // Fix 6B: Derive live bundle on every render — stale snapshot problem eliminated.
  // liveQueue lookup first; fall back to history for archive mode.
  const selectedBundle = selectedBundleId
    ? (state.liveQueue[selectedBundleId] ?? state.history.find(b => b.id === selectedBundleId) ?? null)
    : null

  // ── Modal Handlers ─────────────────────────────────────────────────────────
  const handleViewLiveDetails = (bundle: FHIRBundle) => {
    markChatRead(bundle.id)
    markEditRead(bundle.id)
    setSelectedBundleId(bundle.id)
    setModalMode('live')
  }

  const handleViewArchiveDetails = (bundle: FHIRBundle) => {
    setSelectedBundleId(bundle.id)
    setModalMode('archive')
  }

  const handleCloseModal = () => {
    setSelectedBundleId(null)
  }

  return (
    <>
      {/* ── RolePicker Overlay (Sprint 4 — Shift Check-In) ────────────────
          Rendered when no valid shift session exists. Non-dismissible:
          the nurse MUST identify themselves before seeing patient data.
          Once startShift() is called by RolePicker, session becomes
          non-null and this overlay disappears. */}
      {!session && (
        <RolePicker
          hospitalId={hospitalId}
          hospitalLabel={hospitalLabel}
          onComplete={startShift}
        />
      )}

      <div className={styles.root}>
        {/* ── Top Banner ─────────────────────────────────────────────── */}
        <HospitalBanner
          hospitalId={hospitalId}
          hospitalLabel={hospitalLabel}
          signalRStatus={state.signalRStatus}
          liveCount={sortedQueue.length}
          userDisplayLabel={session?.displayLabel}
          userRole={session?.role}
          onEndShift={endShift}
          lastSyncAt={state.lastSyncAt}
        />

        {/* ── Tab Bar ────────────────────────────────────────────────── */}
        <div className={styles.tabBar}>
          <button
            className={`${styles.tab} ${activeTab === 'live' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('live')}
          >
            Live Queue
            {sortedQueue.length > 0 && (
              <span className={styles.tabBadge}>{sortedQueue.length}</span>
            )}
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'history' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('history')}
          >
            History
            {state.history.length > 0 && (
              <span className={`${styles.tabBadge} ${styles.tabBadgeGray}`}>
                {state.history.length}
              </span>
            )}
          </button>
        </div>

        {/* ── Tab Content ────────────────────────────────────────────── */}
        <div className={styles.content}>
          {activeTab === 'live' && (
            <LiveQueue
              bundles={sortedQueue}
              flashIds={state.flashIds}
              hydrationStatus={state.hydrationStatus}
              hospitalId={hospitalId}
              now={now}
              onViewDetails={handleViewLiveDetails}
              onArrived={handleArrivedOptimistic}
              canArrivePatients={session?.canArrivePatients ?? false}
              authorLabel={session?.displayLabel ?? null}
              userSession={session}
              comments={state.comments}
              unreadChatIds={state.unreadChatIds}
              unreadEditIds={state.unreadEditIds}
              markChatRead={markChatRead}
              markEditRead={markEditRead}
            />
          )}
          {activeTab === 'history' && (
            <HistoryTab
              bundles={state.history}
              hospitalId={hospitalId}
              hydrationStatus={state.historyHydrationStatus}
              onViewDetails={handleViewArchiveDetails}
              canRestorePatients={session?.canRestorePatients ?? false}
              authorLabel={session?.displayLabel ?? null}
              userSession={session}
              comments={state.comments}
            />
          )}
        </div>

        {/* ── Patient Detail Modal (Sprint 4.2: two-pane layout) ────── */}
        {selectedBundle && (
          <PatientDetailModal
            bundle={selectedBundle}
            hospitalId={hospitalId}
            mode={modalMode}
            onClose={handleCloseModal}
            userSession={session!}
            chatMessages={state.chatMap[selectedBundle.id] ?? []}
            onMessagesLoaded={(msgs) => setChat(selectedBundle.id, msgs)}
            onNewMessage={(msgs) => setChat(selectedBundle.id, msgs)}
            onArrived={handleArrivedOptimistic}
            canArrivePatients={session?.canArrivePatients ?? false}
          />
        )}
      </div>
    </>
  )
}
