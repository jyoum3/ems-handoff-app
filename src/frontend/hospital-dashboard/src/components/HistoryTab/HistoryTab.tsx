// HistoryTab.tsx — Sprint 5 Full Update
// Items: Sugar, arrivedAt format, confirm modal, Required Resources, comments,
//        userSession, abnormal vitals, isArchived CommentCell

import { useState } from 'react'
import type { FHIRBundle, HospitalId, HospitalComment, CommentMap } from '../../types/fhir'
import {
  getPatient,
  getEncounter,
  getObservation,
  formatPatientName,
  formatAge,
  formatGender,
  formatArrivedAt,
  getESILevel,
  getESIColor,
  getVital,
  isVitalAbnormal,
} from '../../utils/fhirHelpers'
import { recoverHandoff } from '../../services/api'
import CommentCell from '../CommentCell/CommentCell'
import styles from './HistoryTab.module.css'

interface UserSessionLike {
  role: string
  firstName: string
  lastName: string
  displayLabel?: string
}

interface HistoryTabProps {
  bundles: FHIRBundle[]
  hospitalId: HospitalId
  hydrationStatus: 'idle' | 'loading' | 'hydrated' | 'error'
  onViewDetails: (bundle: FHIRBundle) => void
  canRestorePatients: boolean
  authorLabel: string | null
  userSession?: UserSessionLike | null
  comments?: CommentMap
}

function vitalClass(baseClass: string, abnormal: boolean, abnormalClass: string) {
  return abnormal ? abnormalClass : baseClass
}

function HistoryRow({
  bundle,
  hospitalId,
  onViewDetails,
  canRestorePatients,
  userSession,
  comments,
}: {
  bundle: FHIRBundle
  hospitalId: HospitalId
  onViewDetails: (bundle: FHIRBundle) => void
  canRestorePatients: boolean
  userSession?: UserSessionLike | null
  comments: HospitalComment[]
}) {
  const [recovering, setRecovering] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [recoverError, setRecoverError] = useState<string | null>(null)

  const patient = getPatient(bundle)
  const encounter = getEncounter(bundle)
  const obs = getObservation(bundle)

  const esiLevel = getESILevel(encounter)
  const esiColor = getESIColor(esiLevel)
  const name = formatPatientName(patient)
  const age = formatAge(patient)
  const gender = formatGender(patient)
  const cc = encounter?.reasonCode?.[0]?.text ?? '—'
  const requirements = encounter?.resourceRequirements ?? []
  const medicUnit = bundle.medicUnit ?? null
  const arrivedTime = formatArrivedAt(bundle.arrivedAt)

  const hr = getVital(obs, 'HR')
  const bp = getVital(obs, 'BP')
  const rr = getVital(obs, 'RR')
  const spo2 = getVital(obs, 'SpO2')
  const temp = getVital(obs, 'Temp')
  const sugar = getVital(obs, 'Sugar')

  const patientLastFirst = `${patient?.name?.[0]?.family ?? 'Unknown'}, ${patient?.name?.[0]?.given?.[0] ?? 'Unknown'}`

  const handleConfirmRestore = async () => {
    setShowConfirm(false)
    setRecovering(true)
    setRecoverError(null)
    try {
      await recoverHandoff(bundle.id, hospitalId)
    } catch (err) {
      setRecoverError(err instanceof Error ? err.message : 'Restore failed')
      setRecovering(false)
    }
  }

  return (
    <>
      <tr className={styles.row}>
        {/* Arrived Time */}
        <td className={`${styles.td} ${styles.tdArrived}`}>
          <span className={styles.arrivedTime}>{arrivedTime}</span>
        </td>

        {/* Unit */}
        <td className={`${styles.td} ${styles.tdUnit}`}>
          {medicUnit !== null ? <span className={styles.unitBadge}>#{medicUnit}</span> : <span className={styles.missing}>—</span>}
        </td>

        {/* Status */}
        <td className={styles.td}>
          <span className={styles.arrivedBadge}>✅ Arrived</span>
        </td>

        {/* Patient */}
        <td className={`${styles.td} ${styles.tdPatient}`}>
          <span className={styles.patientName}>{name}</span>
          <span className={styles.patientDemo}>{age} · {gender}</span>
        </td>

        {/* ESI */}
        <td className={styles.td}>
          {esiLevel !== '--' ? (
            <span className={styles.esiBadge} style={{ color: esiColor, borderColor: esiColor }}>{esiLevel}</span>
          ) : <span className={styles.missing}>—</span>}
        </td>

        {/* Chief Complaint */}
        <td className={`${styles.td} ${styles.tdCC}`}><span className={styles.ccText}>{cc}</span></td>

        {/* Vitals */}
        <td className={styles.td}><span className={vitalClass(styles.vital, isVitalAbnormal('HR', hr), styles.vitalAbnormal)}>{hr}{isVitalAbnormal('HR', hr) ? '!' : ''}</span></td>
        <td className={styles.td}><span className={vitalClass(styles.vital, isVitalAbnormal('BP', bp), styles.vitalAbnormal)}>{bp}{isVitalAbnormal('BP', bp) ? '!' : ''}</span></td>
        <td className={styles.td}><span className={styles.vital}>{rr}</span></td>
        <td className={styles.td}><span className={vitalClass(styles.vital, isVitalAbnormal('SpO2', spo2), styles.vitalAbnormal)}>{spo2 !== '--' ? `${spo2}%` : '--'}{isVitalAbnormal('SpO2', spo2) ? '!' : ''}</span></td>
        <td className={styles.td}><span className={vitalClass(styles.vital, isVitalAbnormal('Temp', temp), styles.vitalAbnormal)}>{temp !== '--' ? `${temp}°` : '--'}{isVitalAbnormal('Temp', temp) ? '!' : ''}</span></td>
        <td className={styles.td}><span className={vitalClass(styles.vital, isVitalAbnormal('Sugar', sugar), styles.vitalAbnormal)}>{sugar}{isVitalAbnormal('Sugar', sugar) ? '!' : ''}</span></td>

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

        {/* Comments (read-only in history) */}
        <td className={`${styles.td} ${styles.tdComments}`}>
          <CommentCell
            bundleId={bundle.id}
            patientName={patientLastFirst}
            hospitalId={hospitalId}
            comments={comments}
            userSession={userSession ?? null}
            isArchived={true}
          />
        </td>

        {/* Actions */}
        <td className={`${styles.td} ${styles.tdActions}`}>
          <button className={styles.btnDetails} onClick={() => onViewDetails(bundle)}>Details</button>
          {canRestorePatients && recovering ? (
            <button className={styles.btnRestore} disabled>Restoring…</button>
          ) : canRestorePatients ? (
            <button
              className={styles.btnRestore}
              onClick={() => { setRecoverError(null); setShowConfirm(true) }}
              title={recoverError ?? 'Restore to live queue'}
            >Restore</button>
          ) : null}
          {recoverError && <span className={styles.restoreError} title={recoverError}>!</span>}
        </td>
      </tr>

      {/* Restore Confirm Modal (Item 6) */}
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
                <h3 style={{ margin: '0 0 12px', color: '#f1f5f9', fontSize: '1.1rem' }}>Confirm Restore</h3>
                <p style={{ margin: '0 0 24px', color: '#94a3b8', fontSize: '0.9rem', lineHeight: 1.5 }}>
                  Are you sure you want to Restore <strong style={{ color: '#e2e8f0' }}>{patientLastFirst}</strong>?
                  They will be moved back to the Live Queue.
                </p>
                <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                  <button onClick={() => setShowConfirm(false)} style={{
                    padding: '8px 20px', borderRadius: '6px', border: '1px solid #475569',
                    background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: '0.875rem',
                  }}>No</button>
                  <button onClick={handleConfirmRestore} style={{
                    padding: '8px 20px', borderRadius: '6px', border: 'none',
                    background: '#10B981', color: '#fff', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 600,
                  }}>Yes — Restore</button>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

export default function HistoryTab({
  bundles,
  hospitalId,
  hydrationStatus,
  onViewDetails,
  canRestorePatients,
  userSession,
  comments = {},
}: HistoryTabProps) {
  if (hydrationStatus === 'loading') {
    return (
      <div className={styles.emptyState}>
        <div className={styles.spinner} />
        <p className={styles.emptyText}>Loading patient history…</p>
      </div>
    )
  }
  if (hydrationStatus === 'error') {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyIcon}>⚠️</span>
        <p className={styles.emptyText}>Failed to load patient history.</p>
        <p className={styles.emptySubtext}>New arrivals will still appear here in real time via SignalR.</p>
      </div>
    )
  }
  if (bundles.length === 0) {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyIcon}>📋</span>
        <p className={styles.emptyText}>No patients arrived in the last 24 hours</p>
        <p className={styles.emptySubtext}>Patients move here automatically when marked as arrived.</p>
      </div>
    )
  }

  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr className={styles.headerRow}>
            <th className={styles.th}>Arrived</th>
            <th className={styles.th}>Unit</th>
            <th className={styles.th}>Status</th>
            <th className={styles.th}>Patient</th>
            <th className={styles.th}>ESI</th>
            <th className={styles.th}>Chief Complaint</th>
            <th className={styles.th}>HR</th>
            <th className={styles.th}>BP</th>
            <th className={styles.th}>RR</th>
            <th className={styles.th}>SpO₂</th>
            <th className={styles.th}>Temp</th>
            <th className={styles.th}>Sugar</th>
            <th className={styles.th}>Required Resources</th>
            <th className={styles.th}>Comments</th>
            <th className={styles.th}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {bundles.map((bundle) => (
            <HistoryRow
              key={bundle.id}
              bundle={bundle}
              hospitalId={hospitalId}
              onViewDetails={onViewDetails}
              canRestorePatients={canRestorePatients}
              userSession={userSession}
              comments={comments[bundle.id] ?? []}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}
