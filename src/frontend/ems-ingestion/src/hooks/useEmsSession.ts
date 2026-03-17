// useEmsSession.ts — EMS Ingestion PWA: Shift Session Management Hook
// =====================================================================
// Phase 4 Sprint 2.5: Added medicUnitType ('ALS' | 'BLS') to EmsSession.
// Updated startSession signature: (unit, unitType, name, phone).
//
// SESSION LIFECYCLE:
//   1. App loads → ShiftCheckIn overlay blocks everything
//   2. Medic enters name, unit, unit type, phone → startSession() stores session
//   3. Session auto-expires after 12 hours (one full shift)
//   4. "Switch Shift" in EmsBanner → clearSession() → ShiftCheckIn reappears

import { useState } from 'react';
import type { EmsSession } from '../types/fhir';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_KEY = 'ems_session';
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000; // 12 hours
const PHONE_PATTERN = /^\d{3}-\d{3}-\d{4}$/;

// ---------------------------------------------------------------------------
// sessionStorage I/O
// ---------------------------------------------------------------------------

function loadSession(): EmsSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;

    const session = JSON.parse(raw) as EmsSession;

    // Guard against missing required fields (including new medicUnitType)
    if (
      !session.medicUnit ||
      !session.medicName ||
      !session.medicPhone ||
      !session.shiftStartedAt
    ) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }

    // Auto-expire after one shift (12 hours)
    const elapsed = Date.now() - new Date(session.shiftStartedAt).getTime();
    if (elapsed > SESSION_DURATION_MS) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }

    return session;
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useEmsSession() {
  const [session, setSession] = useState<EmsSession | null>(loadSession);

  /**
   * Validates phone format, builds a new EmsSession (with unitType), and persists.
   * Called by ShiftCheckIn's "Start Shift" button via the onComplete prop.
   * Phase 4 Sprint 2.5: added unitType parameter.
   */
  const startSession = (
    unit: number,
    unitType: 'ALS' | 'BLS',
    name: string,
    phone: string,
  ): void => {
    if (!PHONE_PATTERN.test(phone)) {
      throw new Error(
        `Phone number "${phone}" does not match required format XXX-XXX-XXXX. Example: 215-555-0199.`,
      );
    }

    const newSession: EmsSession = {
      medicUnit: unit,
      medicUnitType: unitType,
      medicName: name,
      medicPhone: phone,
      shiftStartedAt: new Date().toISOString(),
    };

    sessionStorage.setItem(SESSION_KEY, JSON.stringify(newSession));
    setSession(newSession);
  };

  const clearSession = (): void => {
    sessionStorage.removeItem(SESSION_KEY);
    setSession(null);
  };

  return {
    session,
    isSessionActive: session !== null,
    startSession,
    clearSession,
  };
}
