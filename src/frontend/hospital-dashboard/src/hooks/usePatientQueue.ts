/**
 * usePatientQueue.ts — Patient Queue State Management
 * ====================================================
 *
 * PURPOSE:
 * Manages all dashboard application state using useReducer for predictable,
 * auditable lifecycle transitions. This hook is the single source of truth
 * for the live patient queue and history — all state changes flow through
 * the reducer, making them traceable and testable.
 *
 * WHY useReducer (NOT useState):
 * useState would require multiple interdependent state updates for a single
 * event (e.g., an 'arrived' handoff must remove from liveQueue AND add to
 * history AND remove from flashIds — three separate setState calls that
 * could produce intermediate renders). useReducer handles complex multi-field
 * transitions atomically in a single dispatch. The reducer is a pure function:
 * given the same state and action, it always produces the same next state.
 * This makes behavior predictable and unit testable without a browser.
 *
 * NO localStorage FOR PHI:
 * Patient data is never persisted to browser storage. localStorage is
 * shared across browser sessions on the same workstation — in a hospital
 * with shared workstations, PHI from one nurse's session would be readable
 * by the next user. All state is ephemeral (in-memory, session-scoped).
 * The canonical source of truth is always the backend (Cosmos DB + SignalR).
 *
 * STATE HYDRATION (Dual-Channel, Sprint 3):
 * On mount, the hook fires TWO parallel hydration calls:
 *   1. GET /api/active-handoffs  → populates liveQueue (Cosmos DB snapshot)
 *   2. GET /api/fetch-archive    → populates history   (hot-tier Blob snapshot)
 *
 * Both use upsert/merge semantics, so the order of completion doesn't matter.
 * SignalR events that arrive during hydration are also safely merged.
 *
 * liveQueue DATA STRUCTURE — Record<string, FHIRBundle>:
 * Keyed by bundle.id for O(1) upserts. When a SignalR 'inbound' update
 * arrives for an existing patient (vital sign change, ETA update), finding
 * and replacing in an array requires O(n) scan. In a Record, it's
 * O(1): liveQueue[bundle.id] = bundle. The sorted display array is derived
 * via useMemo in the Dashboard component, keeping the reducer pure.
 *
 * Sprint 3 Changes:
 * - HYDRATE_HISTORY action: loads hot-tier archive blobs into history[] on mount.
 * - HANDOFF_UPDATE now handles recovery: when handoffStatus='inbound' arrives
 *   via SignalR, also remove the patient from history[] (covers the case where
 *   a patient was previously arrived on THIS session's browser and is now
 *   restored). This is the cross-tab sync for the "Restore" action.
 * - setHistoryHydrationStatus: separate from liveQueue hydration status.
 */

import { useReducer, useCallback, useEffect, useRef } from 'react'
import type { FHIRBundle, HospitalId, CommentMap, HospitalComment, ChatMessage, ChatMap } from '../types/fhir'
import { fetchActiveHandoffs, fetchHotTierArchive, getComments } from '../services/api'
import { playChatPing, playHandoffChime } from '../utils/audioNotifications'
import type { SignalRStatus } from './useSignalR'

// =============================================================================
// State Shape
// =============================================================================

export interface QueueState {
  /**
   * Active inbound patients, keyed by bundle.id for O(1) upserts.
   *
   * WHY Record<string, FHIRBundle> OVER FHIRBundle[]:
   * HANDOFF_UPDATE events for existing patients (e.g., vital sign updates
   * from a medic re-submitting the handoff) need to replace the existing
   * entry. Searching an array for bundle.id is O(n). Updating a Record key
   * is O(1). At 18 workstations receiving concurrent updates, this matters.
   *
   * For rendering: Dashboard derives sortedQueue = Object.values(liveQueue)
   * .sort() via useMemo — sorted by ESI then ETA, recalculated only when
   * liveQueue reference changes.
   */
  liveQueue: Record<string, FHIRBundle>

  /**
   * Arrived patients, newest first (prepend on arrival).
   * Hydrated on mount from hot-tier archive blobs (Sprint 3).
   * Array (not Record) because history is append-only from the reducer's
   * perspective — we never update history entries (only prepend or remove).
   */
  history: FHIRBundle[]

  /**
   * Bundle IDs currently playing the flash-to-fade animation.
   *
   * WHY Set<string> OVER a CSS class toggle:
   * Directly manipulating element.classList in a SignalR callback fights
   * React's reconciler — stale closures and race conditions emerge when
   * multiple patients arrive simultaneously. By storing flash state in
   * React-managed state, each PatientRow component re-renders with the
   * correct class based on current state, and React handles the DOM update.
   *
   * IMMUTABILITY: We create new Set instances on each action (new Set([...]))
   * rather than mutating the existing Set. React compares state by reference;
   * a new Set instance correctly signals a change and triggers re-render.
   */
  flashIds: Set<string>

  /**
   * Tracks whether the initial Cosmos DB hydration (liveQueue) has completed.
   * 'loading'  → GET /api/active-handoffs in flight (show skeleton/spinner)
   * 'hydrated' → Cosmos snapshot loaded (or empty — show empty state)
   * 'error'    → Hydration failed (show retry prompt)
   */
  hydrationStatus: 'idle' | 'loading' | 'hydrated' | 'error'

  /**
   * Tracks whether the hot-tier archive hydration (history) has completed.
   * Separate from hydrationStatus — the two hydrations run in parallel
   * and each can fail independently without blocking the other.
   * 'idle'     → Not yet started
   * 'loading'  → GET /api/fetch-archive in flight
   * 'hydrated' → Blob archive list loaded (or empty)
   * 'error'    → Archive listing failed (History Tab shows empty state)
   */
  historyHydrationStatus: 'idle' | 'loading' | 'hydrated' | 'error'

  /**
   * Tracks the WebSocket connection state for the HospitalBanner indicator.
   * Updated by callbacks from useSignalR via setSignalRStatus().
   */
  signalRStatus: SignalRStatus

  /**
   * Sprint 5: CommentMap — keyed by bundleId, loaded from handoff-comments
   * Cosmos container. Not PHI — hospital operational metadata.
   * Hydrated on mount via GET /api/get-comments, updated in real-time
   * via 'commentUpdate' SignalR events.
   */
  comments: CommentMap

  /**
   * Sprint 4.1: Chat state — keyed by bundleId.
   * Loaded lazily when the Details modal opens, updated in real-time via
   * 'chatUpdate' SignalR events. Never persisted to localStorage (PHI safety).
   */
  chatMap: ChatMap

  /**
   * Sprint 4.1: Bundle IDs with unread EMS chat messages.
   * Added when a 'chatUpdate' SignalR event arrives.
   * Cleared when the Details modal is opened for that patient.
   */
  unreadChatIds: Set<string>

  /**
   * Sprint 4.1: Bundle IDs with unread PHI edits (vitalHistory, assessmentHistory,
   * demographics change) since the modal was last opened.
   * Detected by comparing editCount in HANDOFF_UPDATE against previous state.
   * Cleared when the Details modal is opened for that patient.
   */
  unreadEditIds: Set<string>

  /**
   * Sprint 4.1: Timestamp of the most recent SignalR event received.
   * Used by HospitalBanner to show "Last Sync: HH:MM:SS" and detect stale data
   * (no event for >30s while technically connected → show stale warning).
   * Updated on every HANDOFF_UPDATE, COMMENT_UPDATE, and CHAT_UPDATE.
   */
  lastSyncAt: Date | null
}

// =============================================================================
// Action Types (Discriminated Union)
// =============================================================================

type QueueAction =
  | { type: 'HYDRATE_COMMENTS'; bundleComments: CommentMap }
  | { type: 'COMMENT_UPDATE'; bundleId: string; allComments: HospitalComment[] }
  /**
   * HYDRATE: Merges the Cosmos DB snapshot into the live queue.
   *
   * Uses UPSERT semantics (not replace) to handle the race condition
   * where a SignalR HANDOFF_UPDATE arrives before the Cosmos query returns:
   *
   *   T=0ms   SignalR connects, HANDOFF_UPDATE for bundle X arrives
   *           → X added to liveQueue via HANDOFF_UPDATE
   *   T=200ms Cosmos query returns with bundles [A, B, C, X]
   *           → HYDRATE merges: A, B, C added fresh; X overwritten with DB data
   *           → Result: all 4 patients in liveQueue, X has authoritative DB copy
   *
   * If HYDRATE used full-replace semantics, bundle X (delivered by SignalR
   * before hydration) would be wiped and then immediately re-added by Cosmos —
   * causing a visual flash. The merge approach is seamless.
   */
  | { type: 'HYDRATE'; bundles: FHIRBundle[] }

  /**
   * HYDRATE_HISTORY: Populates the History Tab from hot-tier Blob archive.
   *
   * Sprint 3 addition — runs once on mount alongside HYDRATE.
   * Replaces (not merges) history because:
   *   - History entries are immutable (no updates, only appends or removes)
   *   - This call runs ONCE at startup from authoritative Blob Storage
   *   - Any subsequent changes are delivered via SignalR HANDOFF_UPDATE
   *
   * The backend pre-sorts by arrivedAt descending, so the ordering is
   * already correct when this action fires. The reducer preserves order.
   *
   * Recovered patients (handoffStatus="inbound" in blob) are already
   * filtered out by the backend before this payload arrives here.
   */
  | { type: 'HYDRATE_HISTORY'; bundles: FHIRBundle[] }

  /**
   * HANDOFF_UPDATE: Handles every incoming SignalR 'handoffUpdate' event.
   *
   * Four paths (Phase 4 Sprint 1 adds diverted path):
   *
   *   handoffStatus='inbound' (NEW patient OR RECOVERED patient):
   *     → Upsert into liveQueue
   *     → Add to flashIds (entry animation)
   *     → Remove from history[] if present (handles recovery broadcast:
   *       patient was in history, "Restore" was clicked → arrives via SignalR
   *       → must disappear from history on ALL connected tabs simultaneously)
   *
   *   handoffStatus='arrived':
   *     → Remove from liveQueue
   *     → Prepend to history[] (appears at top of History Tab)
   *     → Remove from flashIds if still animating
   *
   *   handoffStatus='diverted' (Phase 4 Sprint 1):
   *     → Remove from liveQueue (patient re-routed to a different hospital)
   *     → Remove from flashIds if still animating
   *     → Do NOT add to history — patient has not arrived here; they are going
   *       elsewhere. divert_handoff_bp.py sends this sentinel specifically to
   *       the OLD hospital's userId as a removal signal only.
   *
   * This is the real-time synchronization heart of the dashboard. A single
   * event simultaneously updates the correct tab on EVERY connected instance.
   */
  | { type: 'HANDOFF_UPDATE'; bundle: FHIRBundle }

  /**
   * FLASH_CLEAR: Removes a bundle ID from the flash animation set.
   * Dispatched by a setTimeout in handleHandoffUpdate after 2500ms.
   */
  | { type: 'FLASH_CLEAR'; bundleId: string }

  /** SET_HYDRATION_STATUS: Tracks the liveQueue Cosmos query lifecycle. */
  | { type: 'SET_HYDRATION_STATUS'; status: QueueState['hydrationStatus'] }

  /** SET_HISTORY_HYDRATION_STATUS: Tracks the history Blob query lifecycle. */
  | { type: 'SET_HISTORY_HYDRATION_STATUS'; status: QueueState['historyHydrationStatus'] }

  /** SET_SIGNALR_STATUS: Tracks WebSocket connection state for HospitalBanner. */
  | { type: 'SET_SIGNALR_STATUS'; status: SignalRStatus }

  // Sprint 4.1: Chat + unread tracking actions
  | { type: 'CHAT_UPDATE'; bundleId: string; allMessages: ChatMessage[] }
  | { type: 'SET_CHAT'; bundleId: string; messages: ChatMessage[] }
  | { type: 'MARK_CHAT_READ'; bundleId: string }
  | { type: 'MARK_EDIT_READ'; bundleId: string }

// =============================================================================
// Initial State
// =============================================================================

const initialState: QueueState = {
  liveQueue: {},
  history: [],
  flashIds: new Set(),
  hydrationStatus: 'idle',
  historyHydrationStatus: 'idle',
  signalRStatus: 'disconnected',
  comments: {},
  chatMap: {},
  unreadChatIds: new Set<string>(),
  unreadEditIds: new Set<string>(),
  lastSyncAt: null,
}

// =============================================================================
// Reducer (Pure Function)
// =============================================================================

function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'HYDRATE': {
      // Merge Cosmos snapshot into existing state.
      // Starting from state.liveQueue (not {}) preserves any SignalR-delivered
      // records that arrived before this hydration completed.
      //
      // DEFENSIVE GUARD: The API may return null/undefined when there are no
      // active handoffs (empty Cosmos partition) or when the backend is not
      // yet running in local dev. Array.isArray() prevents a TypeError crash
      // if the response is not iterable.
      const safeBundles = Array.isArray(action.bundles) ? action.bundles : []
      const merged: Record<string, FHIRBundle> = { ...state.liveQueue }
      for (const bundle of safeBundles) {
        merged[bundle.id] = bundle
      }
      return {
        ...state,
        liveQueue: merged,
        hydrationStatus: 'hydrated',
      }
    }

    case 'HYDRATE_HISTORY': {
      // Replace history with the authoritative blob archive snapshot.
      // The backend pre-sorts by arrivedAt descending (newest first).
      // Already filtered: only handoffStatus='arrived' records arrive here.
      //
      // DEFENSIVE GUARD: Same rationale as HYDRATE above — null/undefined
      // when blob container is empty or backend is offline in local dev.
      return {
        ...state,
        history: Array.isArray(action.bundles) ? action.bundles : [],
        historyHydrationStatus: 'hydrated',
      }
    }

    case 'HANDOFF_UPDATE': {
      const { bundle } = action

      if (bundle.handoffStatus === 'inbound') {
        // ── Recovery-Aware Upsert ──────────────────────────────────────────
        // Scenario A — NEW patient: bundle.id not in history.
        //   → add to liveQueue + flashIds. History and comments unchanged.
        //
        // Scenario B — RECOVERED patient:
        //   bundle.id IS in history. Nurse clicked "Restore".
        //   → add to liveQueue + flashIds + REMOVE from history.
        //   → ALSO clear comments[bundleId]: the comment doc was deleted at
        //     arrival time (arrival_bp.py Step 7). If the patient is restored,
        //     they start fresh with no comments. Clearing here ensures the
        //     CommentCell shows "No comment yet." rather than stale log data
        //     from the previous visit that was already cleaned up in Cosmos.
        const wasInHistory = state.history.some((b) => b.id === bundle.id)
        let nextComments = state.comments
        if (wasInHistory) {
          // Shallow-clone and delete the stale comment entry
          nextComments = { ...state.comments }
          delete nextComments[bundle.id]
        }

        // Sprint 4.1: Edit detection — compare editCount to detect PHI updates
        const prevBundle = state.liveQueue[bundle.id]
        const isNewEdit =
          bundle.isEdited === true &&
          (bundle.editCount ?? 0) > (prevBundle?.editCount ?? 0)

        return {
          ...state,
          liveQueue: { ...state.liveQueue, [bundle.id]: bundle },
          flashIds: new Set([...state.flashIds, bundle.id]),
          history: state.history.filter((b) => b.id !== bundle.id),
          comments: nextComments,
          unreadEditIds: isNewEdit
            ? new Set([...state.unreadEditIds, bundle.id])
            : state.unreadEditIds,
          lastSyncAt: new Date(),
        }
      }

      if (bundle.handoffStatus === 'diverted') {
        // ── Phase 4 Sprint 1: Diversion — Remove from this hospital's queue ──
        // The patient has been re-routed to a different hospital mid-transport.
        // divert_handoff_bp.py sends handoffStatus='diverted' to the OLD
        // hospital's userId as a removal sentinel only. The patient is NOT
        // arriving here — they should not appear in history. Simply remove
        // from liveQueue (and flashIds if still animating).
        //
        // The NEW hospital simultaneously receives a full updated document
        // with handoffStatus='inbound', which is handled by the 'inbound'
        // path above on the new hospital's dashboard instance.
        const { [bundle.id]: _diverted, ...remainingQueueAfterDivert } = state.liveQueue
        const nextFlashAfterDivert = new Set(state.flashIds)
        nextFlashAfterDivert.delete(bundle.id)
        return {
          ...state,
          liveQueue: remainingQueueAfterDivert,
          flashIds: nextFlashAfterDivert,
        }
      }

      if (bundle.handoffStatus === 'arrived') {
        // ── Sprint 4: In-History Update Detection ──────────────────────────
        //
        // Check if this bundle is ALREADY in history before triggering the
        // liveQueue removal path. This handles comment updates on archived
        // patients: when comment_bp.py broadcasts an updated bundle for an
        // archived patient (handoffStatus='arrived'), that bundle is NOT in
        // liveQueue — it's already in history[]. Attempting to destructure
        // a non-existent liveQueue key is a no-op, but we still want the
        // history[] update to happen in-place (not prepend, which creates
        // duplicates).
        //
        // Two cases for arriving 'arrived' bundles:
        //   A) New arrival: bundle.id is in liveQueue, NOT in history
        //      → normal flow: remove from liveQueue, prepend to history
        //   B) Comment update on archived patient: bundle.id is in history, NOT in liveQueue
        //      → in-place update: replace history entry, leave liveQueue unchanged
        //
        const existingInHistory = state.history.some((b) => b.id === bundle.id)

        if (existingInHistory) {
          // Case B: In-place update (comment added to archived patient)
          return {
            ...state,
            history: state.history.map((b) => (b.id === bundle.id ? bundle : b)),
          }
        }

        // Case A: Normal arrival flow
        // Object destructuring removes the arrived patient's key from liveQueue.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [bundle.id]: _removed, ...remainingQueue } = state.liveQueue

        // Remove from flashIds if still animating (patient arrived very quickly)
        const nextFlash = new Set(state.flashIds)
        nextFlash.delete(bundle.id)

        return {
          ...state,
          liveQueue: remainingQueue,
          // Prepend to history: most recently arrived patient appears at top.
          // Guard against duplicate: if this tab was the one that sent the
          // arrival signal AND HYDRATE_HISTORY already ran with this bundle,
          // filter first to prevent duplicates before prepending.
          history: [bundle, ...state.history.filter((b) => b.id !== bundle.id)],
          flashIds: nextFlash,
        }
      }

      return state
    }

    case 'FLASH_CLEAR': {
      // Remove the bundle from flashIds — triggers re-render that removes
      // the CSS animation class from the PatientRow, stopping the animation.
      const next = new Set(state.flashIds)
      next.delete(action.bundleId)
      return { ...state, flashIds: next }
    }

    case 'SET_HYDRATION_STATUS':
      return { ...state, hydrationStatus: action.status }

    case 'SET_HISTORY_HYDRATION_STATUS':
      return { ...state, historyHydrationStatus: action.status }

    case 'SET_SIGNALR_STATUS':
      return { ...state, signalRStatus: action.status }

    case 'HYDRATE_COMMENTS':
      return { ...state, comments: action.bundleComments }

    case 'COMMENT_UPDATE':
      return {
        ...state,
        comments: {
          ...state.comments,
          [action.bundleId]: action.allComments,
        },
        lastSyncAt: new Date(),
      }

    // ── Sprint 4.1: Chat + Unread Tracking ───────────────────────────────────

    case 'CHAT_UPDATE':
      // Real-time SignalR push — adds to unread set (nurse not actively viewing)
      return {
        ...state,
        chatMap: { ...state.chatMap, [action.bundleId]: action.allMessages },
        unreadChatIds: new Set([...state.unreadChatIds, action.bundleId]),
        lastSyncAt: new Date(),
      }

    case 'SET_CHAT':
      // Lazy-load on modal open — does NOT add to unread (nurse is actively viewing)
      return {
        ...state,
        chatMap: { ...state.chatMap, [action.bundleId]: action.messages },
      }

    case 'MARK_CHAT_READ': {
      const next = new Set(state.unreadChatIds)
      next.delete(action.bundleId)
      return { ...state, unreadChatIds: next }
    }

    case 'MARK_EDIT_READ': {
      const next = new Set(state.unreadEditIds)
      next.delete(action.bundleId)
      return { ...state, unreadEditIds: next }
    }

    default:
      return state
  }
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Manages the patient queue state for a hospital dashboard.
 *
 * Returns:
 *   state              — Full QueueState (liveQueue, history, flashIds, statuses)
 *   handleHandoffUpdate — Stable callback for useSignalR to call on each event
 *   setSignalRStatus   — Stable callback for useSignalR to update connection status
 *
 * Sprint 3: Now fires TWO parallel hydration calls on mount:
 *   1. fetchActiveHandoffs → HYDRATE (liveQueue from Cosmos)
 *   2. fetchHotTierArchive → HYDRATE_HISTORY (history from hot-tier Blob archive)
 */
export function usePatientQueue(hospitalId: HospitalId) {
  const [state, dispatch] = useReducer(queueReducer, initialState)

  // ── liveQueueRef — always-current liveQueue for stable sound callbacks ─────
  //
  // WHY useRef instead of reading state directly in handleHandoffUpdate:
  //   handleHandoffUpdate is a useCallback with [] deps — it captures the
  //   initial (empty) liveQueue at mount. Reading state.liveQueue from inside
  //   the callback would always see {} because of the stale closure.
  //   useRef is NOT subject to stale closure — .current always reflects the
  //   latest value set by the useEffect below.
  //
  // This ref is ONLY used for the sound trigger decision (is this a new patient?
  // is this a PHI edit?). The reducer still computes the next state correctly
  // from its own current state — this ref does not influence state transitions.
  const liveQueueRef = useRef<Record<string, FHIRBundle>>({})
  useEffect(() => {
    liveQueueRef.current = state.liveQueue
  }, [state.liveQueue])

  // ── Live Queue Hydration (Cosmos DB) ───────────────────────────────────────
  //
  // Runs ONCE on mount. Fires GET /api/active-handoffs to populate liveQueue
  // with the current Cosmos DB snapshot. Runs IN PARALLEL with the history
  // hydration effect below and with useSignalR's connection setup.
  //
  // No coordination needed: HYDRATE uses {...state.liveQueue} as base,
  // so any SignalR events that arrived before this completes are preserved.
  useEffect(() => {
    dispatch({ type: 'SET_HYDRATION_STATUS', status: 'loading' })

    fetchActiveHandoffs(hospitalId)
      .then((bundles) => {
        dispatch({ type: 'HYDRATE', bundles })
      })
      .catch((err) => {
        console.error('[usePatientQueue] Live queue hydration failed:', err)
        dispatch({ type: 'SET_HYDRATION_STATUS', status: 'error' })
      })
  }, [hospitalId])

  // ── History Hydration (Hot-Tier Blob Archive) — Sprint 3 ──────────────────
  //
  // Runs ONCE on mount IN PARALLEL with the live queue hydration above.
  // Fires GET /api/fetch-archive (list mode) to populate history[] with
  // hot-tier arrived bundles from Blob Storage.
  //
  // WHY THIS IS SEPARATE FROM LIVE QUEUE HYDRATION:
  // These are two different data sources:
  //   - Live queue: Cosmos DB (hot, real-time, mutable)
  //   - History:    Blob Storage (warm archive, append-only, immutable)
  // Keeping them separate allows each to fail independently and each to
  // show its own loading state in the UI (HistoryTab can show a spinner
  // while the live queue is already populated and interactive).
  //
  // WHY THIS IS NEEDED (The Page-Refresh Problem):
  // SignalR 'arrived' events are ephemeral — they exist only in the current
  // browser session's memory. Refreshing the page clears history[]. Without
  // this hydration, nurses would lose all arrived patient records on every
  // page refresh. This call makes History persistent across refreshes.
  useEffect(() => {
    dispatch({ type: 'SET_HISTORY_HYDRATION_STATUS', status: 'loading' })

    fetchHotTierArchive(hospitalId)
      .then((bundles) => {
        dispatch({ type: 'HYDRATE_HISTORY', bundles })
      })
      .catch((err) => {
        console.error('[usePatientQueue] History hydration failed:', err)
        dispatch({ type: 'SET_HISTORY_HYDRATION_STATUS', status: 'error' })
      })
  }, [hospitalId])

  // ── SignalR Message Handler ────────────────────────────────────────────────
  //
  // Passed to useSignalR as the onMessage callback. Called on every
  // 'handoffUpdate' SignalR event. Must be stable (useCallback) to prevent
  // useSignalR's effect from re-running on every render of Dashboard.
  //
  // Sprint 3: HANDOFF_UPDATE now handles recovery (inbound + remove from history).
  // The callback itself is unchanged — the reducer handles the new logic.
  //
  // WHY useCallback + setTimeout INSTEAD OF useEffect on flashIds:
  // A useEffect on flashIds would re-run on EVERY flash change, creating
  // O(n) scheduled effects as patients are added. This approach creates
  // exactly ONE setTimeout per incoming HANDOFF_UPDATE event, regardless
  // of how many patients are currently flashing. O(1) per event.
  const handleHandoffUpdate = useCallback((bundle: FHIRBundle) => {
    // ── Sound notification (before dispatch — liveQueueRef reflects prev state) ──
    if (bundle.handoffStatus === 'inbound') {
      const prev = liveQueueRef.current[bundle.id]
      const isNewPatient = !prev
      const isPhiEdit =
        bundle.isEdited === true &&
        (bundle.editCount ?? 0) > (prev?.editCount ?? 0)

      // Play chime for: brand-new patient admission OR PHI edit received
      if (isNewPatient || isPhiEdit) {
        playHandoffChime()
      }
    }

    dispatch({ type: 'HANDOFF_UPDATE', bundle })

    // Schedule flash animation cleanup. The 2500ms matches the CSS animation
    // duration in LiveQueue.module.css (@keyframes flashFade: 2.5s ease-out).
    if (bundle.handoffStatus === 'inbound') {
      setTimeout(() => {
        dispatch({ type: 'FLASH_CLEAR', bundleId: bundle.id })
      }, 2500)
    }
  }, []) // No dependencies — dispatch + liveQueueRef.current never stale in closures

  // ── SignalR Status Updater ─────────────────────────────────────────────────
  //
  // Passed to useSignalR as the onStatusChange callback. Allows the connection
  // hook to update the indicator in HospitalBanner without owning any state.
  // ── Comment Hydration (handoff-comments container) — Sprint 5 ─────────────
  useEffect(() => {
    getComments(hospitalId)
      .then((bundleComments) => {
        dispatch({ type: 'HYDRATE_COMMENTS', bundleComments })
      })
      .catch((err) => {
        console.error('[usePatientQueue] Comment hydration failed:', err)
      })
  }, [hospitalId])

  // ── SignalR Status Updater ─────────────────────────────────────────────────
  const setSignalRStatus = useCallback((status: SignalRStatus) => {
    dispatch({ type: 'SET_SIGNALR_STATUS', status })
  }, [])

  // ── Comment Update Handler (from SignalR commentUpdate event) ─────────────
  const handleCommentUpdate = useCallback(
    (data: { bundleId: string; hospitalId: string; allComments: HospitalComment[] }) => {
      dispatch({ type: 'COMMENT_UPDATE', bundleId: data.bundleId, allComments: data.allComments })
    },
    [],
  )

  // ── Chat Update Handler (from SignalR chatUpdate event) ───────────────────
  const handleChatUpdate = useCallback(
    (data: { bundleId: string; hospitalId: string; allMessages: ChatMessage[] }) => {
      // 🔵 Double-ping for new EMS chat message (fires only if unmuted)
      playChatPing()
      dispatch({ type: 'CHAT_UPDATE', bundleId: data.bundleId, allMessages: data.allMessages })
    },
    [],
  )

  // ── Chat/Edit Read Markers ────────────────────────────────────────────────
  const markChatRead = useCallback(
    (bundleId: string) => dispatch({ type: 'MARK_CHAT_READ', bundleId }),
    [],
  )

  const markEditRead = useCallback(
    (bundleId: string) => dispatch({ type: 'MARK_EDIT_READ', bundleId }),
    [],
  )

  // ── Lazy Chat Loader (called by ChatPanel on mount) ───────────────────────
  const setChat = useCallback(
    (bundleId: string, messages: ChatMessage[]) =>
      dispatch({ type: 'SET_CHAT', bundleId, messages }),
    [],
  )

  return {
    state,
    handleHandoffUpdate,
    handleCommentUpdate,
    handleChatUpdate,
    setSignalRStatus,
    markChatRead,
    markEditRead,
    setChat,
  }
}
