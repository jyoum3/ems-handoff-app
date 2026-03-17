// PatientRow.tsx — Sprint 5 Full Update
// Items: Sugar vital, abnormal flagging, confirm modal, new ETA format,
//        "Required Resources" label, comments column, userSession prop

import { useState } from 'react'
import type { FHIRBundle, HospitalId, HospitalComment } from '../../types/fhir'
import {
  getPatient,
  getEncounter,
  formatPatientName,
  formatAge,
  formatGender,
  formatETAFull,
  getESILevel,
  getESIColor,
  isVitalAbnormal,
  getMedicUnitType,
  getAlertBadges,
  getLatestVitalValue,
} from '../../utils/fhirHelpers'
import { arrivePatient } from '../../services/api'
import CommentCell from '../CommentCell/CommentCell'
import styles from './LiveQueue.module.css'

interface UserSessionLike {
  role: string
  firstName: string
  lastName: string
  displayLabel?: string
}

interface PatientRowProps {
  bundle: FHIRBundle
  isFlashing: boolean
  hospitalId: HospitalId
  now: Date
  onViewDetails: (bundle: FHIRBundle) => void
  onArrived: (bundle: FHIRBundle) => void
  canArrivePatients: boolean
  authorLabel?: string | null
  userSession?: UserSessionLike | null
  comments?: HospitalComment[]
  // Sprint 4.1: Notification tracking
  unreadChatIds?: Set<string>
  unreadEditIds?: Set<string>
  markChatRead?: (bundleId: string) => void
  markEditRead?: (bundleId: string) => void
}

// Abnormal vital styling
function vitalClass(abnormal: boolean) {
  return abnormal ? styles.vitalAbnormal : styles.vital
}

export default function PatientRow({
  bundle,
  isFlashing,
  hospitalId,
  now,
  onViewDetails,
  onArrived,
  canArrivePatients,
  userSession = null,
  comments = [],
  unreadChatIds = new Set(),
  unreadEditIds = new Set(),
  markChatRead,
  markEditRead,
}: PatientRowProps) {
  const [arriving, setArriving] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [arriveError, setArriveError] = useState<string | null>(null)

  const patient = getPatient(bundle)
  const encounter = getEncounter(bundle)

  const esiLevel = getESILevel(encounter)
  const esiColor = getESIColor(esiLevel)
  const name = formatPatientName(patient)
  const age = formatAge(patient)
  const gender = formatGender(patient)
  const cc = encounter?.reasonCode?.[0]?.text ?? '—'
  const requirements = encounter?.resourceRequirements ?? []
  const medicUnit = bundle.medicUnit ?? null
  const unitType = getMedicUnitType(bundle)   // Phase 4 Sprint 2.5: ALS/BLS

  // ETA — new single-arg signature
  const etaResult = formatETAFull(encounter?.period?.end)
  void now // used by parent clock to trigger re-render

  // Sprint 4.1: Read from vitalHistory[-1] when available (most recent EMS submission)
  const hr    = getLatestVitalValue(bundle, 'HR')
  const bp    = getLatestVitalValue(bundle, 'BP')
  const rr    = getLatestVitalValue(bundle, 'RR')
  const spo2  = getLatestVitalValue(bundle, 'SpO2')
  const temp  = getLatestVitalValue(bundle, 'Temp')
  const sugar = getLatestVitalValue(bundle, 'Sugar')

  const hrAbnormal    = isVitalAbnormal('HR',    hr)
  const bpAbnormal    = isVitalAbnormal('BP',    bp)
  const rrAbnormal    = isVitalAbnormal('RR',    rr)
  const spo2Abnormal  = isVitalAbnormal('SpO2',  spo2)
  const tempAbnormal  = isVitalAbnormal('Temp',  temp)
  const sugarAbnormal = isVitalAbnormal('Sugar', sugar)

  // Sprint 4.1: Alert badges + notification state
  const alertBadges    = getAlertBadges(bundle)
  const hasUnreadChat  = unreadChatIds.has(bundle.id)
  const hasUnreadEdit  = unreadEditIds.has(bundle.id)

  // Sprint 4.1: Clear unread dots before opening Details
  const handleOpenDetails = (b: FHIRBundle) => {
    markChatRead?.(b.id)
    markEditRead?.(b.id)
    onViewDetails(b)
  }

  const handleConfirmArrive = async () => {
    setShowConfirm(false)
    setArriving(true)
    setArriveError(null)
    try {
      await arrivePatient(bundle.id, hospitalId)
      onArrived(bundle)
    } catch (err) {
      setArriveError(err instanceof Error ? err.message : 'Arrival failed')
      setArriving(false)
    }
  }

  const patientLastFirst = `${patient?.name?.[0]?.family ?? 'Unknown'}, ${patient?.name?.[0]?.given?.[0] ?? 'Unknown'}`

  const rowClass = [
    styles.row,
    isFlashing ? styles.rowFlash : '',
    etaResult.isOverdue ? styles.rowOverdue : '',
  ].filter(Boolean).join(' ')

  return (
    <>
      <tr className={rowClass}>
        {/* ── Notification Indicator Column — leftmost, sticky ── */}
        <td className={styles.tdNotify}>
          <div className={styles.notifyDots}>
            {hasUnreadChat && (
              <span
                className={styles.dotBlue}
                title="New EMS message"
                aria-label="Unread chat message"
              />
            )}
            {hasUnreadEdit && (
              <span
                className={styles.dotAmber}
                title="PHI updated by EMS"
                aria-label="Patient info updated"
              />
            )}
          </div>
        </td>

        {/* ETA */}
        <td className={`${styles.td} ${styles.tdEta}`}>
          <span className={etaResult.isOverdue ? styles.etaOverdue : styles.etaTime}>
            {etaResult.display}
          </span>
        </td>

        {/* Unit — with ALS/BLS pill badge (Sprint 2.5) */}
        <td className={`${styles.td} ${styles.tdUnit}`}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
            {medicUnit !== null ? <span className={styles.unitBadge}>#{medicUnit}</span> : <span className={styles.missing}>—</span>}
            {unitType && (
              <span style={{
                fontSize: '10px',
                fontWeight: 700,
                padding: '1px 6px',
                borderRadius: '10px',
                background: unitType === 'ALS' ? '#F97316' : '#3B82F6',
                color: '#fff',
                letterSpacing: '0.05em',
              }}>
                {unitType}
              </span>
            )}
          </div>
        </td>

        {/* Status */}
        <td className={styles.td}>
          <span className={styles.statusBadge}>🔴 Inbound</span>
        </td>

        {/* Patient */}
        <td className={`${styles.td} ${styles.tdPatient}`}>
          <span className={styles.patientName}>{name}</span>
          <span className={styles.patientDemo}>{age} · {gender}</span>
        </td>

        {/* Alert Badges — Sprint 4.1: between Patient Name and ESI */}
        <td className={`${styles.td} ${styles.tdAlertBadges}`}>
          {alertBadges.length > 0 ? (
            <div className={styles.alertBadgeGroup}>
              {alertBadges.map((badge, i) => (
                <span key={i} className={styles.alertBadgeChip}>⚡ {badge}</span>
              ))}
            </div>
          ) : (
            <span className={styles.missing}>—</span>
          )}
        </td>

        {/* ESI */}
        <td className={styles.td}>
          {esiLevel !== '--' ? (
            <span className={styles.esiBadge} style={{ color: esiColor, borderColor: esiColor }}>
              {esiLevel}
            </span>
          ) : <span className={styles.missing}>—</span>}
        </td>

        {/* Chief Complaint */}
        <td className={`${styles.td} ${styles.tdCC}`}><span className={styles.ccText}>{cc}</span></td>

        {/* Vitals — (!) prefix before abnormal value with space */}
        <td className={styles.td}><span className={vitalClass(hrAbnormal)}>{hrAbnormal ? '(!) ' : ''}{hr}</span></td>
        <td className={styles.td}><span className={vitalClass(bpAbnormal)}>{bpAbnormal ? '(!) ' : ''}{bp}</span></td>
        <td className={styles.td}><span className={vitalClass(rrAbnormal)}>{rrAbnormal ? '(!) ' : ''}{rr}</span></td>
        <td className={styles.td}><span className={vitalClass(spo2Abnormal)}>{spo2Abnormal ? '(!) ' : ''}{spo2 !== '--' ? `${spo2}%` : '--'}</span></td>
        <td className={styles.td}><span className={vitalClass(tempAbnormal)}>{tempAbnormal ? '(!) ' : ''}{temp !== '--' ? `${temp}°` : '--'}</span></td>
        <td className={styles.td}><span className={vitalClass(sugarAbnormal)}>{sugarAbnormal ? '(!) ' : ''}{sugar}</span></td>

        {/* Required Resources */}
        <td className={`${styles.td} ${styles.tdResources}`}>
          {requirements.length > 0 ? (
            <div className={styles.chips}>
              {requirements.map((req, i) => (
                <span key={i} className={styles.chipResource}>{req}</span>
              ))}
            </div>
          ) : <span className={styles.missing}>—</span>}
        </td>

        {/* Comments (Sprint 5) */}
        <td className={`${styles.td} ${styles.tdComments}`}>
          <CommentCell
            bundleId={bundle.id}
            patientName={patientLastFirst}
            hospitalId={hospitalId}
            comments={comments}
            userSession={userSession}
            isArchived={false}
          />
        </td>

        {/* Actions — wrapped in flex div so td vertical-align: middle works */}
        <td className={`${styles.td} ${styles.tdActions}`}>
          <div className={styles.actionsWrapper}>
            <button className={styles.btnDetails} onClick={() => handleOpenDetails(bundle)}>Details</button>
            {canArrivePatients && arriving ? (
              <button className={styles.btnArrive} disabled>Arriving…</button>
            ) : canArrivePatients ? (
              <button
                className={styles.btnArrive}
                onClick={() => { setArriveError(null); setShowConfirm(true) }}
                title={arriveError ?? undefined}
              >
                Arrive
              </button>
            ) : null}
            {arriveError && <span className={styles.arriveError} title={arriveError}>!</span>}
          </div>
        </td>
      </tr>

      {/* Arrive Confirm Modal (Item 6) */}
      {showConfirm && (
        <tr>
          <td colSpan={15} style={{ padding: 0, border: 'none' }}>
            <div style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
            }} onClick={() => setShowConfirm(false)}>
              <div style={{
                background: '#1e293b', borderRadius: '12px', padding: '28px 32px',
                minWidth: '380px', maxWidth: '480px', border: '1px solid #334155',
                boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
              }} onClick={(e) => e.stopPropagation()}>
                <h3 style={{ margin: '0 0 12px', color: '#f1f5f9', fontSize: '1.1rem' }}>
                  Confirm Arrival
                </h3>
                <p style={{ margin: '0 0 24px', color: '#94a3b8', fontSize: '0.9rem', lineHeight: 1.5 }}>
                  Are you sure you want to Arrive <strong style={{ color: '#e2e8f0' }}>{patientLastFirst}</strong>?
                  They will be moved to the History Tab.
                </p>
                <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => setShowConfirm(false)}
                    style={{
                      padding: '8px 20px', borderRadius: '6px', border: '1px solid #475569',
                      background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: '0.875rem',
                    }}
                  >No</button>
                  <button
                    onClick={handleConfirmArrive}
                    style={{
                      padding: '8px 20px', borderRadius: '6px', border: 'none',
                      background: '#22c55e', color: '#fff', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 600,
                    }}
                  >Yes — Arrive</button>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
