/**
 * RolePicker.tsx — Shift Check-In Overlay
 * ========================================
 *
 * PURPOSE:
 * Rendered as a full-screen overlay when no valid shift session exists.
 * Forces clinical staff to identify themselves before accessing the
 * live patient queue. This is step 3 of the auth flow:
 *
 *   Step 1: Select hospital (App.tsx hospital selector or URL bookmark)
 *   Step 2: Entra ID sign-in (production SWA auth — bypass in dev)
 *   Step 3: Role + Name selection (this component)
 *
 * ROLE PERMISSIONS:
 *   CHARGE, PFC, INTAKE → Full access (Arrive + Restore + Comments)
 *   GENERAL-1, GENERAL-2 → Read-only (Comments only, no lifecycle actions)
 *
 * DESIGN INTENT:
 * The overlay is intentionally non-dismissible (no X / Escape) — the user
 * MUST complete identification before seeing patient data. This mirrors
 * the clinical intent: a nurse who walks up to a workstation and sees
 * patient data without logging in is a HIPAA risk.
 *
 * NAME + ROLE ATTRIBUTION:
 * The full name entered here is used in the comment log:
 *   "CHARGE — Jane Doe | 03/07/2026 - 14:30"
 * This creates a lightweight audit trail without requiring a full LDAP
 * lookup or identity system for the portfolio version.
 */

import { useState } from 'react'
import type { HospitalId } from '../../types/fhir'
import type { UserRole } from '../../hooks/useUser'
import { ROLE_COLORS } from '../../hooks/useUser'
import styles from './RolePicker.module.css'

interface RolePickerProps {
  hospitalId: HospitalId
  hospitalLabel: string
  onComplete: (
    role: UserRole,
    firstName: string,
    lastName: string,
    hospitalId: HospitalId,
  ) => void
}

const ROLES: { value: UserRole; label: string; description: string }[] = [
  { value: 'CHARGE', label: 'Charge Nurse', description: 'Full access · Arrive & Restore' },
  { value: 'PFC', label: 'Patient Flow Coordinator', description: 'Full access · Arrive & Restore' },
  { value: 'INTAKE', label: 'Intake Nurse', description: 'Full access · Arrive & Restore' },
  { value: 'GENERAL-1', label: 'General Staff 1', description: 'View + Comment only' },
  { value: 'GENERAL-2', label: 'General Staff 2', description: 'View + Comment only' },
]

export default function RolePicker({ hospitalId, hospitalLabel, onComplete }: RolePickerProps) {
  const [selectedRole, setSelectedRole] = useState<UserRole | null>(null)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')

  const isValid =
    selectedRole !== null &&
    firstName.trim().length > 0 &&
    lastName.trim().length > 0

  const handleStartShift = () => {
    if (!isValid || !selectedRole) return
    onComplete(selectedRole, firstName.trim(), lastName.trim(), hospitalId)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && isValid) {
      handleStartShift()
    }
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.card}>
        {/* ── Header ──────────────────────────────────────────────── */}
        <div className={styles.header}>
          <span className={styles.icon}>🏥</span>
          <div className={styles.headerText}>
            <h2 className={styles.title}>Shift Check-In</h2>
            <p className={styles.subtitle}>{hospitalLabel} · {hospitalId}</p>
          </div>
        </div>

        <div className={styles.body}>
          {/* ── Name Fields ────────────────────────────────────────── */}
          <div className={styles.nameSection}>
            <label className={styles.sectionLabel}>Your Name</label>
            <div className={styles.nameRow}>
              <div className={styles.inputGroup}>
                <label className={styles.inputLabel} htmlFor="firstName">
                  First Name
                </label>
                <input
                  id="firstName"
                  type="text"
                  className={styles.input}
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Jane"
                  autoComplete="given-name"
                  autoFocus
                />
              </div>
              <div className={styles.inputGroup}>
                <label className={styles.inputLabel} htmlFor="lastName">
                  Last Name
                </label>
                <input
                  id="lastName"
                  type="text"
                  className={styles.input}
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Doe"
                  autoComplete="family-name"
                />
              </div>
            </div>
          </div>

          {/* ── Role Selection ─────────────────────────────────────── */}
          <div className={styles.roleSection}>
            <label className={styles.sectionLabel}>Select Your Role</label>
            <div className={styles.roleList}>
              {ROLES.map(({ value, label, description }) => {
                const isSelected = selectedRole === value
                const color = ROLE_COLORS[value]
                return (
                  <button
                    key={value}
                    type="button"
                    className={`${styles.roleOption} ${isSelected ? styles.roleSelected : ''}`}
                    style={isSelected ? { borderColor: color, backgroundColor: `${color}14` } : {}}
                    onClick={() => setSelectedRole(value)}
                  >
                    {/* Role indicator dot */}
                    <span
                      className={styles.roleDot}
                      style={{ backgroundColor: isSelected ? color : 'var(--border)' }}
                    />
                    <span className={styles.roleOptionContent}>
                      <span
                        className={styles.roleOptionTitle}
                        style={isSelected ? { color } : {}}
                      >
                        {value}
                      </span>
                      <span className={styles.roleOptionLabel}>{label}</span>
                      <span className={styles.roleOptionDesc}>{description}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* ── Preview ────────────────────────────────────────────── */}
          {isValid && selectedRole && (
            <div className={styles.preview}>
              <span className={styles.previewLabel}>Signing in as:</span>
              <span
                className={styles.previewRole}
                style={{ color: ROLE_COLORS[selectedRole] }}
              >
                {selectedRole}
              </span>
              <span className={styles.previewName}>
                — {firstName.trim()} {lastName.trim()}
              </span>
            </div>
          )}
        </div>

        {/* ── Footer ──────────────────────────────────────────────── */}
        <div className={styles.footer}>
          <button
            className={styles.btnStart}
            onClick={handleStartShift}
            disabled={!isValid}
            style={
              isValid && selectedRole
                ? { backgroundColor: ROLE_COLORS[selectedRole] }
                : {}
            }
          >
            Start Shift
          </button>
          <p className={styles.disclaimer}>
            This dashboard is for authorized ED staff only.
            Your role and name will be recorded on all activity.
          </p>
        </div>
      </div>
    </div>
  )
}
