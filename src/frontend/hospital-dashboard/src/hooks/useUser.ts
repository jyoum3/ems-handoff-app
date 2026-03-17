/**
 * useUser.ts — Shift Session Management Hook
 * ===========================================
 *
 * ARCHITECTURE:
 * Manages the clinical staff shift session. Stores role + name in
 * sessionStorage so the session persists across page refreshes within
 * the same browser tab but clears when the tab is closed (shift end).
 *
 * SESSION LIFECYCLE:
 *   1. User arrives at the dashboard URL (hospitalId already in URL)
 *   2. If no valid session → Dashboard renders RolePicker overlay
 *   3. User selects role + enters name → startShift() stores session
 *   4. Session auto-expires after 12 hours (one full shift)
 *   5. On tab close or expiry → session cleared automatically
 *
 * ROLE MODEL:
 *   CHARGE, PFC, INTAKE → Privileged (can Arrive and Restore patients)
 *   GENERAL-1, GENERAL-2 → Read-only (cannot trigger lifecycle actions)
 *
 * PRODUCTION AUTH INTEGRATION (Sprint 5):
 *   In production with Entra ID:
 *   - SWA handles OAuth before React loads (/.auth/login/aad)
 *   - /.auth/me endpoint returns the authenticated user's hospital
 *   - This hook is updated to read hospitalId from /.auth/me claims
 *     rather than trusting the URL parameter alone
 *   - Role selection still happens via this hook (Entra ID only
 *     controls WHICH hospital the user can access, not their role
 *     within the ED shift)
 *
 * ROLE COLOR CODING:
 *   CHARGE:    #C084FC  (violet — highest clinical authority)
 *   PFC:       #60A5FA  (cornflower blue — patient flow coordinator)
 *   INTAKE:    #34D399  (emerald — actively processing patients)
 *   GENERAL-1: #94A3B8  (slate — read-only access)
 *   GENERAL-2: #94A3B8  (slate — read-only access)
 *
 * These colors are distinct from the ESI emergency scale colors
 * (red/orange/yellow/green/blue) and the vitals alert red (#ef4444)
 * to avoid visual confusion at a glance.
 */

import { useState, useCallback } from 'react'
import type { HospitalId } from '../types/fhir'

// =============================================================================
// Types
// =============================================================================

export type UserRole = 'CHARGE' | 'PFC' | 'INTAKE' | 'GENERAL-1' | 'GENERAL-2'

export interface UserSession {
  /** Clinical role (determines action permissions) */
  role: UserRole
  firstName: string
  lastName: string
  /**
   * Formatted for the comment attribution log:
   * "CHARGE — Jane Doe"
   */
  displayLabel: string
  /** The hospital this session was started for */
  hospitalId: HospitalId
  /** CHARGE/PFC/INTAKE: can click Arrive to complete a handoff */
  canArrivePatients: boolean
  /** CHARGE/PFC/INTAKE: can Restore an archived patient to the live queue */
  canRestorePatients: boolean
  /** ISO 8601 timestamp — session expires 12h after this */
  sessionStart: string
}

// =============================================================================
// Constants
// =============================================================================

const SESSION_KEY = 'ems-shift-session'
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000 // 12 hours = one full shift

/** Roles that can trigger patient lifecycle actions (Arrive / Restore) */
const PRIVILEGED_ROLES: UserRole[] = ['CHARGE', 'PFC', 'INTAKE']

/** CSS color token for each role — used in HospitalBanner and CommentCell */
export const ROLE_COLORS: Record<UserRole, string> = {
  'CHARGE':    '#C084FC', // violet     — highest authority
  'PFC':       '#60A5FA', // cornflower — patient flow
  'INTAKE':    '#34D399', // emerald    — processing
  'GENERAL-1': '#94A3B8', // slate      — read-only
  'GENERAL-2': '#94A3B8', // slate      — read-only
}

// =============================================================================
// Session Factory
// =============================================================================

/**
 * Builds a validated UserSession from the role picker inputs.
 * Exported so RolePicker can validate in isolation before calling startShift.
 */
export function buildSession(
  role: UserRole,
  firstName: string,
  lastName: string,
  hospitalId: HospitalId,
): UserSession {
  const name = `${firstName.trim()} ${lastName.trim()}`
  return {
    role,
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    displayLabel: `${role} — ${name}`,
    hospitalId,
    canArrivePatients: PRIVILEGED_ROLES.includes(role),
    canRestorePatients: PRIVILEGED_ROLES.includes(role),
    sessionStart: new Date().toISOString(),
  }
}

// =============================================================================
// sessionStorage I/O
// =============================================================================

/**
 * Reads and validates the stored session from sessionStorage.
 * Returns null if absent, malformed, or expired (> 12 hours old).
 *
 * WHY sessionStorage OVER localStorage:
 * sessionStorage is scoped to the browser TAB (not just the browser).
 * When a nurse closes the tab at the end of shift, the session clears
 * automatically — no explicit logout required. localStorage would persist
 * across restarts and potentially leak one nurse's role into the next
 * nurse's session on a shared workstation.
 */
function loadSession(): UserSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null

    const session = JSON.parse(raw) as UserSession

    // Guard against missing required fields (e.g., stale format from old sprint)
    if (!session.role || !session.hospitalId || !session.sessionStart) {
      sessionStorage.removeItem(SESSION_KEY)
      return null
    }

    // Auto-expire after one shift (12 hours)
    const elapsed = Date.now() - new Date(session.sessionStart).getTime()
    if (elapsed > SESSION_DURATION_MS) {
      sessionStorage.removeItem(SESSION_KEY)
      return null
    }

    return session
  } catch {
    // Corrupted JSON or other parse error — clear and start fresh
    sessionStorage.removeItem(SESSION_KEY)
    return null
  }
}

// =============================================================================
// Hook
// =============================================================================

/**
 * useUser — Manages the current staff shift session.
 *
 * Returns:
 *   session:    The active UserSession, or null if no valid session exists.
 *   startShift: Call after the RolePicker is completed to persist + activate
 *               the session.
 *   endShift:   Call to log out / end the current shift (clears sessionStorage).
 *
 * Usage in Dashboard:
 *   const { session, startShift, endShift } = useUser()
 *   if (!session) return <RolePicker hospitalId={hospitalId} onComplete={startShift} />
 *   return <DashboardContent canArrivePatients={session.canArrivePatients} />
 */
export function useUser() {
  // useState initializer runs once at mount — reads existing session from
  // sessionStorage. If the tab was refreshed mid-shift, the session is
  // restored and the RolePicker is skipped.
  const [session, setSessionState] = useState<UserSession | null>(loadSession)

  /**
   * Persists the session to sessionStorage and updates local React state.
   * Called by RolePicker's "Start Shift" button via onComplete callback.
   */
  const startShift = useCallback(
    (
      role: UserRole,
      firstName: string,
      lastName: string,
      hospitalId: HospitalId,
    ) => {
      const newSession = buildSession(role, firstName, lastName, hospitalId)
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(newSession))
      setSessionState(newSession)
    },
    [],
  )

  /**
   * Clears the session — used by the "Switch Role" button in HospitalBanner.
   * Removes sessionStorage entry and sets React state to null, which causes
   * Dashboard to re-render with the RolePicker overlay.
   */
  const endShift = useCallback(() => {
    sessionStorage.removeItem(SESSION_KEY)
    setSessionState(null)
  }, [])

  return { session, startShift, endShift }
}
