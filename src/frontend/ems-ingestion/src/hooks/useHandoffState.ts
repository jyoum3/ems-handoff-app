// useHandoffState.ts — EMS Ingestion PWA: Patient Handoff State Machine
// ======================================================================
// Manages the full lifecycle of the current patient encounter:
//   idle → submitted → arrived → idle (reset)
//
// sessionStorage key: "ems_active_handoff"
// Stores only { bundleId, hospitalId } — NEVER the full PHI bundle.
// This is the minimal state needed to restore the session on PWA re-open
// without persisting sensitive patient data to browser storage.
//
// STATE MACHINE:
//   'idle'       → PatientForm visible, no active patient
//   'submitted'  → Live Handoff view (Sprint 3 placeholder in Sprint 2)
//   'arrived'    → Handoff complete screen (Sprint 3 triggers)
//
// On PWA re-open mid-call:
//   useHandoffState reads sessionStorage at mount.
//   If "ems_active_handoff" exists → appState = 'submitted' (restore).
//   Sprint 3 will call GET /api/ems-to-db to restore the full bundle data.

import { useState } from 'react';
import type { FHIRBundle, AppState } from '../types/fhir';

// ---------------------------------------------------------------------------
// sessionStorage key
// ---------------------------------------------------------------------------

const HANDOFF_KEY = 'ems_active_handoff';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * useHandoffState — manages the active patient handoff state machine.
 *
 * Returns:
 *   appState:          'idle' | 'submitted' | 'arrived'
 *   currentBundle:     The active FHIRBundle, or null if idle/arrived.
 *   bundleId:          The current bundle ID (from sessionStorage restore or submit).
 *   hospitalId:        The current hospital ID.
 *   handleFirstSubmit: Called after successful first POST /api/ems-to-db.
 *                      Persists { bundleId, hospitalId } to sessionStorage.
 *   handleEditSubmit:  Called after a successful re-submit (edit). Updates
 *                      currentBundle in state; bundleId stays the same.
 *   handleArrived:     Called when "Start New Patient" is clicked on the
 *                      arrived screen. Clears session and resets to 'idle'.
 *   handleRestored:    Called after Sprint 3 restores an archived patient.
 *                      Sets currentBundle and transitions to 'submitted'.
 *   handleDiverted:    Called after patient is diverted to a new hospital.
 *                      Updates hospitalId in sessionStorage and state.
 */
export function useHandoffState() {
  // ── Initial state from sessionStorage ──────────────────────────────────
  // If "ems_active_handoff" exists in sessionStorage (PWA re-opened mid-call),
  // the app starts in 'submitted' state so the medic sees their active patient.
  // bundleId and hospitalId are restored from storage — the full bundle will
  // be fetched in Sprint 3 (GET /api/ems-to-db or similar restore endpoint).
  const [appState, setAppState] = useState<AppState>(() => {
    try {
      const raw = sessionStorage.getItem(HANDOFF_KEY);
      return raw ? 'submitted' : 'idle';
    } catch {
      return 'idle';
    }
  });

  const [currentBundle, setCurrentBundle] = useState<FHIRBundle | null>(null);

  const [bundleId, setBundleId] = useState<string | null>(() => {
    try {
      const raw = sessionStorage.getItem(HANDOFF_KEY);
      if (!raw) return null;
      const stored = JSON.parse(raw) as { bundleId: string; hospitalId: string };
      return stored.bundleId ?? null;
    } catch {
      return null;
    }
  });

  const [hospitalId, setHospitalId] = useState<string | null>(() => {
    try {
      const raw = sessionStorage.getItem(HANDOFF_KEY);
      if (!raw) return null;
      const stored = JSON.parse(raw) as { bundleId: string; hospitalId: string };
      return stored.hospitalId ?? null;
    } catch {
      return null;
    }
  });

  // ── State Transition Handlers ─────────────────────────────────────────────

  /**
   * handleFirstSubmit — called after first successful POST /api/ems-to-db.
   *
   * Persists { bundleId, hospitalId } to sessionStorage so the session
   * survives a PWA re-open. Sets appState to 'submitted' which transitions
   * App.tsx from PatientForm → Live Handoff view (Sprint 3 placeholder).
   */
  const handleFirstSubmit = (bundle: FHIRBundle): void => {
    sessionStorage.setItem(
      HANDOFF_KEY,
      JSON.stringify({ bundleId: bundle.id, hospitalId: bundle.hospitalId }),
    );
    setBundleId(bundle.id);
    setHospitalId(bundle.hospitalId);
    setCurrentBundle(bundle);
    setAppState('submitted');
  };

  /**
   * handleEditSubmit — called after a successful edit re-submission.
   *
   * Updates the in-memory bundle with the re-submitted version.
   * bundleId and hospitalId stay the same — the document is an upsert,
   * not a new document. sessionStorage is unchanged.
   */
  const handleEditSubmit = (bundle: FHIRBundle): void => {
    setCurrentBundle(bundle);
  };

  /**
   * handleArrived — called immediately when a patient arrival is confirmed
   * (either by medic tapping "Arrive Patient" or hospital triggering arrival).
   *
   * Transitions to 'arrived' state — NOT 'idle'. This intermediate state:
   *   1. Shows the "Patient Arrived" success screen to the medic.
   *   2. Preserves bundleId and hospitalId in state so that the App-level
   *      SignalR listener can subscribe and catch a potential hospital
   *      "Restore" event (recover_handoff_bp broadcasts action='restored'
   *      scoped to userId=bundleId — we must keep bundleId alive to hear it).
   *   3. Clears currentBundle from memory (PHI no longer needed on screen).
   *   4. Removes the sessionStorage record (medic should not auto-restore
   *      to this patient on a PWA re-open after they've already arrived).
   *
   * The true reset to 'idle' happens when the medic taps "Start New Patient"
   * via handleClear() below.
   */
  const handleArrived = (): void => {
    sessionStorage.removeItem(HANDOFF_KEY);
    setCurrentBundle(null);
    // Intentionally do NOT null out bundleId / hospitalId here —
    // App.tsx uses them to maintain an App-level SignalR subscription
    // in the 'arrived' state to catch hospital-triggered restores.
    setAppState('arrived');
  };

  /**
   * handleClear — called when the medic taps "Start New Patient" on the
   * arrived success screen.
   *
   * This is the true reset: clears ALL state to idle so the PatientForm
   * renders fresh for the next patient. After this, the App-level SignalR
   * listener's bundleId becomes null → it disconnects.
   *
   * Two-step design (handleArrived → handleClear) allows the App-level
   * SignalR to remain subscribed during the 'arrived' success screen so
   * a hospital restore signal is never missed.
   */
  const handleClear = (): void => {
    setCurrentBundle(null);
    setBundleId(null);
    setHospitalId(null);
    setAppState('idle');
  };

  /**
   * handleRestored — called when a restore operation completes.
   *
   * Sets the restored bundle as currentBundle and transitions back to
   * 'submitted' state (Live Handoff view). Called when:
   *   - Hospital staff clicks "Restore" → App-level SignalR catches
   *     emsHandoffUpdate { action: 'restored' } → recoverHandoff() → here
   *   - Medic clicks "Restore" in the EMS History Tab → recoverHandoff() → here
   *
   * FIXED: Now syncs bundleId, hospitalId, and sessionStorage in addition to
   * currentBundle. Previously missing these caused LiveHandoffView to receive
   * null bundleId/hospitalId props, breaking SignalR negotiate and all API calls.
   */
  const handleRestored = (bundle: FHIRBundle): void => {
    setCurrentBundle(bundle);
    setAppState('submitted');
    setBundleId(bundle.id);
    setHospitalId(bundle.hospitalId);
    sessionStorage.setItem(
      HANDOFF_KEY,
      JSON.stringify({ bundleId: bundle.id, hospitalId: bundle.hospitalId }),
    );
  };

  /**
   * handleDiverted — called after a successful POST /api/divert-handoff.
   *
   * Fix 10 (Sprint 3.1): Explicitly keep appState='submitted' and sync
   * bundleId so the LiveHandoffView stays mounted. Critical: sessionStorage
   * must use the NEW hospitalId so restore-on-refresh queries the correct
   * Cosmos DB partition.
   *
   * The bundleId stays the same — only hospitalId changes.
   * Chat doc stays in place (partitioned by bundleId, not hospitalId).
   */
  const handleDiverted = (newBundle: FHIRBundle): void => {
    // 1. Explicitly keep patient active at the new hospital
    setAppState('submitted');
    setCurrentBundle(newBundle);
    setHospitalId(newBundle.hospitalId);
    setBundleId(newBundle.id); // bundleId unchanged on divert — explicit for clarity
    // 2. Write NEW hospitalId to sessionStorage — CRITICAL for refresh restore
    sessionStorage.setItem(
      HANDOFF_KEY,
      JSON.stringify({ bundleId: newBundle.id, hospitalId: newBundle.hospitalId }),
    );
  };

  return {
    appState,
    currentBundle,
    bundleId,
    hospitalId,
    handleFirstSubmit,
    handleEditSubmit,
    handleArrived,
    handleClear,
    handleRestored,
    handleDiverted,
  };
}
