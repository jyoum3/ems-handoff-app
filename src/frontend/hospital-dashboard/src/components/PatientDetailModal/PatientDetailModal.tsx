/**
 * PatientDetailModal.tsx — Full FHIR Bundle Clinical Detail Overlay
 * ==================================================================
 * Sprint 4.3: EcgViewer (read-only) in Section 8, section flash animations,
 * Vital Signs / Assessment History polish (10 cards always rendered,
 * 🔒 Initial / ● CURRENT labeling, Neuro/Physical sub-headers).
 *
 * Sprint 4.2: Two-pane layout (65% clinical + 33% chat), edit markers,
 * sticky Arrive action bar. All clinical sections unchanged from Sprint 3.4.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { FHIRBundle, HospitalId, ObservationResource, ChatMessage } from '../../types/fhir'
import {
  getPatient,
  getEncounter,
  getObservation,
  formatPatientName,
  formatAge,
  formatETAFull,
  formatArrivedAt,
  formatLKW,
  getESILevel,
  getESIColor,
  getVital,
  getExtensionValue,
  getTriageNote,
  isVitalAbnormal,
  getAssessment,
  getCodeStatus,
  getAlertBadges,
  getInitialVitals,
  getMedicUnitType,
  getSceneNotes,
  getEncounterTypes,
  getExtensionDateTime,
  getPainScore,
  getVitalHistory,
  getAssessmentHistory,
  getTransportLog,
} from '../../utils/fhirHelpers'
import { fetchArchiveBundle, arrivePatient } from '../../services/api'
import ChatPanel from '../ChatPanel/ChatPanel'
import EcgViewer from '../EcgViewer/EcgViewer'
import type { UserSession } from '../../hooks/useUser'
import styles from './PatientDetailModal.module.css'

// =============================================================================
// Props
// =============================================================================

interface PatientDetailModalProps {
  bundle: FHIRBundle
  hospitalId: HospitalId
  mode: 'live' | 'archive'
  onClose: () => void
  // Sprint 4.2 additions:
  userSession: UserSession
  chatMessages: ChatMessage[]
  onMessagesLoaded: (messages: ChatMessage[]) => void
  onNewMessage: (messages: ChatMessage[]) => void
  onArrived?: (bundle: FHIRBundle) => void
  canArrivePatients?: boolean
}

// =============================================================================
// Utilities
// =============================================================================

function showIf(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && value !== '' && value !== '—'
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <span className={`${styles.value} ${mono ? styles.mono : ''}`}>{value}</span>
    </div>
  )
}

/**
 * Compute abnormal vitals string from an ObservationResource.
 * Each flag is prefixed with "(!) " for visual urgency.
 */
function computeAbnormalVitalsText(obs: ObservationResource | null): string {
  if (!obs?.component) return ''
  const parts: string[] = []

  const hrComp = obs.component.find(c => c.code.text === 'HR')
  const hr = hrComp?.valueQuantity?.value
  if (hr !== undefined && (hr < 60 || hr > 100)) parts.push(`(!) HR: ${hr} bpm`)

  const bpComp = obs.component.find(c => c.code.text === 'BP')
  const bpStr = bpComp?.valueString
  if (bpStr) {
    const systolic = parseInt(bpStr.split('/')[0], 10)
    if (!isNaN(systolic) && (systolic < 90 || systolic > 180)) parts.push(`(!) BP: ${bpStr} mmHg`)
  }

  const rrComp = obs.component.find(c => c.code.text === 'RR')
  const rr = rrComp?.valueQuantity?.value
  if (rr !== undefined && (rr < 12 || rr > 20)) parts.push(`(!) RR: ${rr} /min`)

  const spo2Comp = obs.component.find(c => c.code.text === 'SpO2')
  const spo2 = spo2Comp?.valueQuantity?.value
  if (spo2 !== undefined && spo2 < 95) parts.push(`(!) SpO2: ${spo2}%`)

  const tempComp = obs.component.find(c => c.code.text === 'Temp')
  const temp = tempComp?.valueQuantity?.value
  if (temp !== undefined && (temp < 97 || temp > 99.5)) parts.push(`(!) Temp: ${temp}F`)

  const sugarComp = obs.component.find(c => c.code.text === 'Sugar')
  const sugar = sugarComp?.valueQuantity?.value
  if (sugar !== undefined && (sugar < 70 || sugar > 180)) parts.push(`(!) Sugar: ${sugar} mg/dL`)

  return parts.join(' | ')
}

/**
 * Parses the stored triage note into discrete display sections.
 */
function parseTriageNote(note: string | null): { hpiText: string; customClinical: string } {
  if (!note) return { hpiText: '', customClinical: '' }

  const clinicalMarker = 'Clinical Findings/Assessment:'
  const clinicalIdx = note.indexOf(clinicalMarker)

  const hpiBlock = clinicalIdx !== -1 ? note.slice(0, clinicalIdx) : note
  const hpiMatch = hpiBlock.match(/HPI:\s*([\s\S]*)/)
  const hpiText = hpiMatch ? hpiMatch[1].trim() : hpiBlock.trim()

  if (clinicalIdx === -1) return { hpiText, customClinical: '' }

  const afterClinical = note.slice(clinicalIdx + clinicalMarker.length)
  const lines = afterClinical.split('\n')
  const customLines: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('(!)')) continue
    if (trimmed === 'History:') break
    if (/^[AMPLE]\s*-/.test(trimmed)) break
    customLines.push(line)
  }

  return { hpiText, customClinical: customLines.join('\n').trim() }
}

/** HH:MM:SS 24-hour — used for transport log entries so two notes in same minute are distinguishable */
function formatLogTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  } catch { return iso }
}

function formatHistoryDate(iso: string): string {
  try {
    const d = new Date(iso)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const yyyy = d.getFullYear()
    const hh = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    return `${mm}/${dd}/${yyyy} ${hh}:${min}`
  } catch { return iso }
}

// Sprint 4.2: Format ISO timestamp as HH:MM for edit markers
function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  } catch { return iso }
}

// Sprint 4.3: Section flash — returns inline animation style when section key is active.
// Uses inline style (not CSS class) so animation restarts on every re-trigger.
function flashStyle(sectionKey: string, flashedSections: Set<string>) {
  return flashedSections.has(sectionKey)
    ? { animation: 'sectionFlash 2.5s ease-out forwards' }
    : {}
}

const LOG_TYPE_META: Record<string, { label: string; color: string }> = {
  note:               { label: 'Note',              color: '#94a3b8' },
  vitals_update:      { label: 'Vitals Update',     color: '#38bdf8' },
  assessment_update:  { label: 'Assessment Update', color: '#c084fc' },
  ecg_upload:         { label: 'ECG Upload',        color: '#fb923c' },
}

// =============================================================================
// PatientDetailModal
// =============================================================================

export default function PatientDetailModal({
  bundle: initialBundle,
  hospitalId,
  mode,
  onClose,
  userSession,
  chatMessages,
  onMessagesLoaded,
  onNewMessage,
  onArrived,
  canArrivePatients = false,
}: PatientDetailModalProps) {
  const [bundle, setBundle] = useState<FHIRBundle>(initialBundle)
  const [fetchStatus, setFetchStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Sprint 4.2: Arrive button state machine
  const [arriveStep, setArriveStep] = useState<'idle' | 'confirm' | 'arriving'>('idle')
  const [arriveError, setArriveError] = useState<string | null>(null)

  // Sprint 4.3: Section flash state
  const [flashedSections, setFlashedSections] = useState<Set<string>>(new Set())
  const prevBundleRef = useRef<FHIRBundle | null>(null)

  useEffect(() => {
    if (mode !== 'archive') return
    setFetchStatus('loading')
    fetchArchiveBundle(initialBundle.id, hospitalId)
      .then((archived) => { if (archived) setBundle(archived); setFetchStatus('done') })
      .catch((err) => { setFetchError(err instanceof Error ? err.message : 'Failed to load archive'); setFetchStatus('error') })
  }, [mode, hospitalId, initialBundle.id])

  // Fix 6A: Sync bundle state when initialBundle prop changes in live mode.
  useEffect(() => {
    if (mode === 'live') {
      setBundle(initialBundle)
    }
  }, [initialBundle, mode])

  // Sprint 4.3: Section flash detection — fires when live bundle updates
  useEffect(() => {
    if (mode !== 'live') return
    const prev = prevBundleRef.current
    if (!prev) {
      prevBundleRef.current = initialBundle
      return
    }

    const sectionsToFlash = new Set<string>()

    if ((initialBundle.vitalHistory?.length ?? 0) > (prev.vitalHistory?.length ?? 0)) {
      sectionsToFlash.add('vitals')
    }
    if ((initialBundle.assessmentHistory?.length ?? 0) > (prev.assessmentHistory?.length ?? 0)) {
      sectionsToFlash.add('assessment')
    }
    if ((initialBundle.transportLog?.length ?? 0) > (prev.transportLog?.length ?? 0)) {
      sectionsToFlash.add('narrative')
    }
    if ((initialBundle.ecgRecords?.length ?? 0) > (prev.ecgRecords?.length ?? 0)) {
      sectionsToFlash.add('ecg')
    }

    const editCountIncreased = (initialBundle.editCount ?? 0) > (prev.editCount ?? 0)
    const vitalOrAssessmentCovered = sectionsToFlash.has('vitals') || sectionsToFlash.has('assessment')
    if (editCountIncreased && !vitalOrAssessmentCovered) {
      sectionsToFlash.add('demographics')
    }

    prevBundleRef.current = initialBundle

    if (sectionsToFlash.size === 0) return

    setFlashedSections(sectionsToFlash)
    const timer = setTimeout(() => setFlashedSections(new Set()), 2500)
    return () => clearTimeout(timer)
  }, [initialBundle, mode])

  const handleKeyDown = useCallback((e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }, [onClose])
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // Sprint 4.2: Arrive handler
  const handleArrive = async () => {
    if (arriveStep === 'idle') { setArriveStep('confirm'); return }
    if (arriveStep === 'confirm') {
      setArriveStep('arriving')
      setArriveError(null)
      try {
        await arrivePatient(bundle.id, hospitalId)
        onArrived?.(bundle)
        onClose()
      } catch (err) {
        setArriveError(err instanceof Error ? err.message : 'Arrival failed')
        setArriveStep('idle')
      }
    }
  }

  // ── FHIR Data Extraction ─────────────────────────────────────────────────
  const patient   = getPatient(bundle)
  const encounter = getEncounter(bundle)
  const obs       = getObservation(bundle)

  const esiLevel = getESILevel(encounter)
  const esiColor = getESIColor(esiLevel)

  const name = formatPatientName(patient)
  const age  = formatAge(patient)
  const dob  = patient?.birthDate ?? null

  const cc            = encounter?.reasonCode?.[0]?.text ?? null
  const esiText       = encounter?.priority?.text ?? null
  const triageNote    = getTriageNote(obs)
  const requirements  = encounter?.resourceRequirements ?? []
  const interventions = encounter?.interventions ?? []
  const medications   = patient?.medications ?? []

  const assessment       = getAssessment(bundle)
  const codeStatus       = getCodeStatus(bundle)
  const alertBadges      = getAlertBadges(bundle)
  const initialVitals    = getInitialVitals(bundle)
  const unitType         = getMedicUnitType(bundle)
  const sceneNotes       = getSceneNotes(bundle)
  const encounterTypes   = getEncounterTypes(bundle)
  const painScore        = getPainScore(bundle)
  const vitalHistory      = getVitalHistory(bundle)
  const assessmentHistory = getAssessmentHistory(bundle)
  const transportLog      = getTransportLog(bundle)

  const spo2Comp    = initialVitals?.component?.find(c => c.code.text === 'SpO2')
  const spo2Device  = spo2Comp?.device ?? null
  const spo2FlowRate = spo2Comp?.flowRate ?? null
  const isolation   = getExtensionValue(patient?.extension, 'isolation')
  const knownHistory = getExtensionValue(patient?.extension, 'known-history')
  const allergies   = getExtensionValue(patient?.extension, 'allergies')
  const lastOralIntake = getExtensionValue(patient?.extension, 'last-oral-intake')

  const lkwRaw  = getExtensionDateTime(encounter?.extension, 'lkw')
               ?? getExtensionValue(encounter?.extension, 'lkw')
  const lkw     = lkwRaw ? formatLKW(lkwRaw) : null
  const onsetRaw = getExtensionDateTime(encounter?.extension, 'onset-time')
                ?? getExtensionValue(encounter?.extension, 'onset-time')
  const onsetDisplay = onsetRaw ? formatLKW(onsetRaw) : 'Unknown'
  const events  = getExtensionValue(encounter?.extension, 'events')

  const { hpiText, customClinical } = parseTriageNote(triageNote)
  const abnormalVitalsText = computeAbnormalVitalsText(initialVitals)
  const pertinentNegatives = assessment?.pertinentNegatives ?? []

  const originSource  = bundle.fromOrigin?.source  ?? null
  const originAddress = bundle.fromOrigin?.address ?? null

  const contactEntry = patient?.contact?.[0]
  const contactNameDisplay = (() => {
    const n = contactEntry?.name
    if (n?.family || n?.given) return [n.given, n.family].filter(Boolean).join(' ')
    return n?.text ?? null
  })()
  const contactPhoneDisplay = contactEntry?.telecom?.find(t => t.system === 'phone')?.value ?? null
  const contactRelationship = contactEntry?.relationship?.[0]?.text ?? null

  type VitalKey = 'HR' | 'BP' | 'RR' | 'SpO2' | 'Temp' | 'Sugar'
  const vitals = [
    { label: 'HR',    value: getVital(obs, 'HR'),    unit: 'bpm',   key: 'HR'    as VitalKey },
    { label: 'BP',    value: getVital(obs, 'BP'),    unit: 'mmHg',  key: 'BP'    as VitalKey },
    { label: 'RR',    value: getVital(obs, 'RR'),    unit: '/min',  key: 'RR'    as VitalKey },
    { label: 'SPO2',  value: getVital(obs, 'SpO2'),  unit: '%',     key: 'SpO2'  as VitalKey },
    { label: 'TEMP',  value: getVital(obs, 'Temp'),  unit: 'F',     key: 'Temp'  as VitalKey },
    { label: 'GCS',   value: getVital(obs, 'GCS'),   unit: '',      key: null },
    { label: 'Sugar', value: getVital(obs, 'Sugar'), unit: 'mg/dL', key: 'Sugar' as VitalKey },
  ]
  const hasVitals = vitals.some(v => showIf(v.value))

  const medicUnit  = bundle.medicUnit  ?? null
  const medicName  = bundle.medicName  ?? null
  const medicPhone = bundle.medicPhone ?? null
  const isArrived  = bundle.handoffStatus === 'arrived'
  const statusText = isArrived ? 'Arrived' : 'Inbound'
  const arrivedAt  = formatArrivedAt(bundle.arrivedAt)
  const etaResult  = formatETAFull(encounter?.period?.end)

  const hasMedHistory = showIf(knownHistory) || medications.length > 0 || showIf(allergies)
  const hasContextual = showIf(originSource) || showIf(originAddress) ||
    showIf(contactNameDisplay) || showIf(events) || showIf(lastOralIntake) || sceneNotes.length > 0
  const hasClinical = true

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={styles.modalOuter}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Patient Detail"
      >

        {/* LEFT PANE: Clinical Details */}
        <div className={styles.leftPane}>

          {/* SECTION 1: HEADER BAR */}
          <div className={styles.header}>
            <div className={styles.headerRow}>
              <div className={styles.crewInfo}>
                {showIf(medicUnit !== null ? String(medicUnit) : null) && (
                  <span className={styles.unitBadge}>Unit #{medicUnit}</span>
                )}
                {unitType && (
                  <span style={{
                    fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '10px',
                    background: unitType === 'ALS' ? '#F97316' : '#3B82F6', color: '#fff',
                    letterSpacing: '0.05em',
                  }}>{unitType}</span>
                )}
                {showIf(medicName) && <span className={styles.medicName}>{medicName}</span>}
                {showIf(medicPhone !== null ? String(medicPhone) : null) && (
                  <a href={`tel:${medicPhone}`} className={styles.medicPhone}
                    onClick={e => e.stopPropagation()} title="Call medic">
                    {medicPhone}
                  </a>
                )}
              </div>

              <div className={styles.etaDisplay}>
                {isArrived ? (
                  <>
                    <span className={styles.etaLabel}>Arrived At</span>
                    <span className={styles.etaValue}>{arrivedAt}</span>
                  </>
                ) : (
                  <>
                    <span className={styles.etaLabel}>ETA</span>
                    <span className={styles.etaValue}
                      style={etaResult.isOverdue ? { color: '#f87171', fontWeight: 700 } : undefined}>
                      {etaResult.display}
                    </span>
                  </>
                )}
                {alertBadges.map((badge, i) => (
                  <span key={i} style={{
                    padding: '2px 8px', borderRadius: '5px', fontSize: '11px', fontWeight: 700,
                    background: 'rgba(245,158,11,0.2)', border: '1px solid #f59e0b', color: '#fbbf24',
                    letterSpacing: '0.03em', whiteSpace: 'nowrap',
                  }}>{badge}</span>
                ))}
              </div>

              <div className={styles.headerControls}>
                {bundle.isEdited && (bundle.editCount ?? 0) > 0 && (
                  <span className={styles.editedBadge}>Edited x{bundle.editCount}</span>
                )}
                {bundle.isEdited && bundle.lastEditedAt && (
                  <span className={styles.lastUpdated}>Updated: {formatTime(bundle.lastEditedAt)}</span>
                )}
                <span className={`${styles.statusBadge} ${isArrived ? styles.statusArrived : styles.statusInbound}`}>
                  {statusText}
                </span>
                {mode === 'archive' && (
                  <span className={`${styles.modeBadge} ${fetchStatus === 'loading' ? styles.modeLoading : ''}`}>
                    {fetchStatus === 'loading' ? 'Loading archive...' : 'Archive Record'}
                  </span>
                )}
                {esiLevel && (
                  <span className={styles.esiBadge} style={{ color: esiColor, borderColor: esiColor }}>
                    {esiText ?? `ESI-${esiLevel}`}
                  </span>
                )}
                <button className={styles.closeBtn} onClick={onClose} aria-label="Close">x</button>
              </div>
            </div>
          </div>

          {fetchStatus === 'error' && (
            <div className={styles.fetchError}>{fetchError} - Showing last known state from session.</div>
          )}

          {/* Scrollable Clinical Body */}
          <div className={styles.body}>

            {/* SECTION 2: DEMOGRAPHICS */}
            <div className={styles.section} style={flashStyle('demographics', flashedSections)}>
              <h3 className={styles.sectionTitle}>Demographics</h3>
              <div className={styles.demoRow}>
                <span className={styles.demoItem}>
                  <span className={styles.demoLabel}>Name</span>
                  <span className={styles.demoValue}>{name}</span>
                </span>
                {showIf(dob) && (
                  <span className={styles.demoItem}>
                    <span className={styles.demoLabel}>DOB</span>
                    <span className={styles.demoValue}>{dob}</span>
                  </span>
                )}
                <span className={styles.demoItem}>
                  <span className={styles.demoLabel}>Age</span>
                  <span className={styles.demoValue}>{age}</span>
                </span>
                <span className={styles.demoItem}>
                  <span className={styles.demoLabel}>Gender</span>
                  <span className={styles.demoValue}>
                    {patient?.gender
                      ? patient.gender.charAt(0).toUpperCase() + patient.gender.slice(1)
                      : 'Unknown'}
                  </span>
                </span>
              </div>
            </div>

            {/* SECTION 3: CLINICAL NARRATIVE */}
            {hasClinical && (
              <div className={styles.section} style={flashStyle('narrative', flashedSections)}>
                <h3 className={styles.sectionTitle}>Clinical Narrative</h3>

                {(showIf(esiText) || showIf(cc) || showIf(codeStatus)) && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '28px', alignItems: 'flex-start', marginBottom: '12px' }}>
                    {showIf(esiText) && (
                      <div>
                        <div className={styles.label}>ESI Level</div>
                        <div className={styles.value} style={{ color: esiColor, fontWeight: 700 }}>{esiText}</div>
                      </div>
                    )}
                    {showIf(cc) && (
                      <div>
                        <div className={styles.label}>Chief Complaint</div>
                        <div className={styles.value}>{cc}</div>
                      </div>
                    )}
                    {encounterTypes.length > 0 && (() => {
                      const etColors: Record<string, { bg: string; border: string; text: string }> = {
                        Medical:    { bg: 'rgba(59,130,246,0.15)',  border: '#3b82f6', text: '#60a5fa' },
                        Trauma:     { bg: 'rgba(239,68,68,0.15)',   border: '#ef4444', text: '#f87171' },
                        Behavioral: { bg: 'rgba(168,85,247,0.15)', border: '#a855f7', text: '#c084fc' },
                        'OB-GYN':   { bg: 'rgba(236,72,153,0.15)', border: '#ec4899', text: '#f472b6' },
                        Pediatric:  { bg: 'rgba(20,184,166,0.15)', border: '#14b8a6', text: '#2dd4bf' },
                      };
                      return (
                        <div>
                          <div className={styles.label}>Encounter Type</div>
                          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                            {encounterTypes.map((et) => {
                              const c = etColors[et] ?? { bg: 'rgba(100,116,139,0.15)', border: '#64748b', text: '#94a3b8' };
                              return (
                                <span key={et} style={{
                                  display: 'inline-block', padding: '4px 12px', borderRadius: '6px',
                                  fontSize: '13px', fontWeight: 700,
                                  background: c.bg, border: `1px solid ${c.border}`, color: c.text,
                                }}>{et}</span>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}
                    {showIf(codeStatus) && (
                      <div>
                        <div className={styles.label}>Code Status</div>
                        <div style={{ marginTop: '4px' }}>
                          <span style={{
                            display: 'inline-block', padding: '4px 12px', borderRadius: '6px',
                            fontSize: '13px', fontWeight: 700,
                            background: codeStatus === 'Full Code' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                            border: `1px solid ${codeStatus === 'Full Code' ? '#22c55e' : '#ef4444'}`,
                            color: codeStatus === 'Full Code' ? '#4ade80' : '#f87171',
                          }}>{codeStatus}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-start', marginBottom: '12px', flexWrap: 'wrap' }}>
                  <Field label="Last Known Well" value={lkw ?? 'Unknown'} />
                  <Field label="Onset / Injury Time" value={onsetDisplay} />
                  {showIf(isolation) && (
                    <div className={styles.field}>
                      <span className={styles.label}>Isolation</span>
                      <span style={{
                        display: 'inline-block', padding: '4px 10px', borderRadius: '6px',
                        fontSize: '12px', fontWeight: 600,
                        background: 'rgba(239,68,68,0.12)', border: '1px solid #ef4444', color: '#f87171',
                      }}>{isolation}</span>
                    </div>
                  )}
                </div>

                <div className={styles.narrativeBlock}>
                  <span className={styles.label}>Triage Narrative</span>

                  <div style={{ marginBottom: '10px', marginTop: '8px' }}>
                    <span style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>HPI: </span>
                    {hpiText && <span style={{ color: '#e2e8f0', fontSize: '13px', whiteSpace: 'pre-wrap' }}>{hpiText}</span>}
                  </div>

                  <div style={{ marginBottom: customClinical ? '4px' : '8px' }}>
                    <span style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Clinical Findings/Assessment: </span>
                    {customClinical && <span style={{ color: '#e2e8f0', fontSize: '13px', whiteSpace: 'pre-wrap' }}>{customClinical}</span>}
                  </div>

                  {abnormalVitalsText && (
                    <div style={{ marginBottom: '10px', fontSize: '13px', lineHeight: 1.6 }}>
                      {abnormalVitalsText.split(' | ').map((flag, i, arr) => (
                        <span key={i}>
                          <span style={{ color: '#f87171', fontWeight: 600 }}>{flag}</span>
                          {i < arr.length - 1 && <span style={{ color: '#e2e8f0' }}> | </span>}
                        </span>
                      ))}
                    </div>
                  )}

                  <div style={{ marginBottom: '10px' }}>
                    <span style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Pertinent Negatives: </span>
                    {pertinentNegatives.length > 0 && (
                      <span style={{ color: '#e2e8f0', fontSize: '13px' }}>{pertinentNegatives.join(', ')}</span>
                    )}
                  </div>

                  <div style={{ marginBottom: '10px' }}>
                    <span style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>AVPU: </span>
                    {assessment?.mentalStatus && (
                      <span style={{ color: '#e2e8f0', fontSize: '13px' }}>{assessment.mentalStatus}</span>
                    )}
                  </div>

                  <div style={{ marginBottom: '10px' }}>
                    <span style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>ORIENTATION: </span>
                    {assessment?.orientation && assessment.orientation.length > 0 && (() => {
                      const orient = assessment.orientation;
                      if (orient.includes('x0 (None)')) {
                        return <span style={{ color: '#e2e8f0', fontSize: '13px' }}>AxO x0</span>;
                      }
                      return <span style={{ color: '#e2e8f0', fontSize: '13px' }}>AxO x{orient.length} ({orient.join(', ')})</span>;
                    })()}
                  </div>

                  <div style={{ marginBottom: '10px' }}>
                    <span style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Pain Score: </span>
                    <span style={{ color: painScore !== null ? '#e2e8f0' : '#64748b', fontSize: '13px' }}>
                      {painScore !== null ? `${painScore}/10` : 'N/A'}
                    </span>
                  </div>

                  <div style={{ marginTop: '8px' }}>
                    <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>History:</div>
                    {([
                      { key: 'A', value: allergies ?? '' },
                      { key: 'M', value: medications.length > 0 ? medications.join(', ') : '' },
                      { key: 'P', value: knownHistory ?? '' },
                      { key: 'L', value: lastOralIntake ?? '' },
                      { key: 'E', value: events ?? '' },
                    ] as { key: string; value: string }[]).map(({ key, value }) => (
                      <div key={key} style={{ fontSize: '13px', lineHeight: 1.9 }}>
                        <span style={{ color: '#94a3b8', fontWeight: 600 }}>{key} - </span>
                        <span style={{ color: '#e2e8f0' }}>{value}</span>
                      </div>
                    ))}
                  </div>

                  {/* Sprint 3.3: Transport Log (read-only on hospital side) */}
                  {transportLog.length > 0 && (
                    <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #1e293b' }}>
                      <div style={{ color: '#64748b', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '6px' }}>Transport Log</div>
                      {transportLog.map((entry, idx) => {
                        const meta = LOG_TYPE_META[entry.type] ?? LOG_TYPE_META['note']
                        return (
                          <div key={idx} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '6px', padding: '4px 8px', marginBottom: '4px', background: 'rgba(15,23,42,0.5)', borderRadius: '5px', borderLeft: '2px solid #334155', fontSize: '12px' }}>
                            <span style={{ fontSize: '10px', color: '#475569', flexShrink: 0 }}>{formatLogTimestamp(entry.timestamp)}</span>
                            <span style={{ fontSize: '11px', fontWeight: 700, color: meta.color, flexShrink: 0 }}>{meta.label}</span>
                            {entry.autoSummary && (
                              <span style={{ fontSize: '12px' }}>
                                {entry.autoSummary.split(' | ').map((seg, si, arr) => (
                                  <span key={si}>
                                    <span style={{ color: seg.startsWith('(!)') ? '#f87171' : '#cbd5e1', fontWeight: seg.startsWith('(!)') ? 700 : 400 }}>{seg}</span>
                                    {si < arr.length - 1 && <span style={{ color: '#475569' }}> | </span>}
                                  </span>
                                ))}
                              </span>
                            )}
                            {entry.medicComment && <span style={{ color: '#94a3b8', fontStyle: 'italic', fontSize: '11px' }}>"{entry.medicComment}"</span>}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                {interventions.length > 0 && (
                  <div className={styles.resourceBlock}>
                    <span className={styles.label}>Interventions</span>
                    <div className={styles.chips}>
                      {interventions.map((iv, i) => (
                        <span key={i} style={{
                          padding: '3px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                          background: 'rgba(59,130,246,0.15)', border: '1px solid #3b82f6', color: '#60a5fa',
                        }}>{iv}</span>
                      ))}
                    </div>
                  </div>
                )}

                {requirements.length > 0 && (
                  <div className={styles.resourceBlock}>
                    <span className={styles.label}>Required Resources</span>
                    <div className={styles.chips}>
                      {requirements.map((req, i) => (
                        <span key={i} className={styles.chipResourceRed}>{req}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* SECTION 4: 12-LEAD ECG — moved before Vitals per UX request */}
            {(bundle.ecgRecords ?? []).length > 0 && (
              <div
                className={styles.section}
                style={flashStyle('ecg', flashedSections)}
              >
                <h3 className={styles.sectionTitle}>12-Lead ECG</h3>
                <EcgViewer
                  records={bundle.ecgRecords ?? []}
                  bundleId={bundle.id}
                  hospitalId={hospitalId}
                />
              </div>
            )}

            {/* SECTION 5: VITAL SIGNS HISTORY — horizontal time-column table */}
            {(vitalHistory.length > 0 || hasVitals) && (
              <div className={styles.section} style={flashStyle('vitals', flashedSections)}>
                <h3 className={styles.sectionTitle}>Vital Signs</h3>
                {vitalHistory.length > 0 ? (
                  /* Horizontal time-column table — vital labels sticky on left, each entry is a column */
                  <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: '4px' }}>
                    <table style={{ borderCollapse: 'collapse', minWidth: 'max-content', width: '100%' }}>
                      <thead>
                        <tr>
                          <th style={{ position: 'sticky', left: 0, zIndex: 2, background: '#0f172a', padding: '6px 10px', textAlign: 'left', fontSize: '11px', fontWeight: 700, color: '#475569', textTransform: 'uppercase', whiteSpace: 'nowrap', minWidth: '72px', borderRight: '1px solid #1e293b', borderBottom: '1px solid #334155' }}>Vital</th>
                          {vitalHistory.map((entry, idx) => {
                            const isInitial = idx === 0
                            const isCurrent = idx === vitalHistory.length - 1
                            return (
                              <th key={idx} style={{ padding: '6px 12px', textAlign: 'center', fontSize: '11px', minWidth: '120px', borderBottom: '1px solid #334155', background: isCurrent && vitalHistory.length > 1 ? 'rgba(34,197,94,0.05)' : '#0f172a', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                                <div style={{ fontWeight: 700, color: '#e2e8f0' }}>{isInitial ? 'Initial' : entry.label} {isInitial ? '🔒' : ''}</div>
                                <div style={{ fontSize: '10px', color: '#475569', marginTop: '2px' }}>{formatHistoryDate(entry.timestamp)}</div>
                                {isCurrent && vitalHistory.length > 1 && (
                                  <div style={{ marginTop: '3px' }}>
                                    <span style={{ padding: '1px 6px', borderRadius: '8px', background: 'rgba(34,197,94,0.15)', border: '1px solid #22c55e', color: '#4ade80', fontSize: '10px', fontWeight: 700 }}>● CURRENT</span>
                                  </div>
                                )}
                              </th>
                            )
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {([
                          { label: 'HR',    getV: (e: typeof vitalHistory[0]) => e.hr    ?? '', unit: 'bpm',   isAbn: (v: string) => { const n = parseFloat(v); return !isNaN(n) && (n < 60 || n > 100) } },
                          { label: 'BP',    getV: (e: typeof vitalHistory[0]) => e.bp    ?? '', unit: 'mmHg',  isAbn: (v: string) => { const m = v.match(/^(\d+)/); return m ? parseInt(m[1]) < 90 || parseInt(m[1]) > 180 : false } },
                          { label: 'RR',    getV: (e: typeof vitalHistory[0]) => e.rr    ?? '', unit: '/min',  isAbn: (v: string) => { const n = parseFloat(v); return !isNaN(n) && (n < 12 || n > 20) } },
                          { label: 'SpO₂',  getV: (e: typeof vitalHistory[0]) => e.spo2  ?? '', unit: '%',     isAbn: (v: string) => { const n = parseFloat(v); return !isNaN(n) && n < 95 } },
                          { label: 'Temp',  getV: (e: typeof vitalHistory[0]) => e.temp  ?? '', unit: '°F',    isAbn: (v: string) => { const n = parseFloat(v); return !isNaN(n) && (n < 97 || n > 99.5) } },
                          { label: 'GCS',   getV: (e: typeof vitalHistory[0]) => e.gcs   ?? '', unit: '',      isAbn: null },
                          { label: 'Sugar', getV: (e: typeof vitalHistory[0]) => e.sugar ?? '', unit: 'mg/dL', isAbn: (v: string) => { const n = parseFloat(v); return !isNaN(n) && (n < 70 || n > 180) } },
                          { label: 'HT',    getV: (e: typeof vitalHistory[0]) => e.height ?? '', unit: 'in',   isAbn: null },
                          { label: 'WT',    getV: (e: typeof vitalHistory[0]) => e.weight ?? '', unit: 'lbs',  isAbn: null },
                          { label: 'Pain',  getV: (e: typeof vitalHistory[0]) => e.pain !== undefined ? String(e.pain) : '', unit: '/10', isAbn: null },
                        ] as { label: string; getV: (e: typeof vitalHistory[0]) => string; unit: string; isAbn: ((v: string) => boolean) | null }[]).map(({ label, getV, unit, isAbn }) => (
                          <tr key={label}>
                            <td style={{ position: 'sticky', left: 0, zIndex: 1, background: '#0f172a', padding: '5px 10px', fontSize: '12px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', whiteSpace: 'nowrap', borderRight: '1px solid #1e293b', borderTop: '1px solid #0f1f2e' }}>{label}</td>
                            {vitalHistory.map((entry, idx) => {
                              const raw = getV(entry)
                              const val = raw !== '' ? raw : '—'
                              const abn = val !== '—' && isAbn ? isAbn(val) : false
                              const isCurrent = idx === vitalHistory.length - 1
                              return (
                                <td key={idx} style={{ padding: '5px 12px', textAlign: 'center', fontSize: '13px', fontWeight: abn ? 700 : 400, color: abn ? '#f87171' : '#f1f5f9', background: isCurrent && vitalHistory.length > 1 ? 'rgba(34,197,94,0.03)' : 'transparent', borderTop: '1px solid #0f1f2e', whiteSpace: 'nowrap' }}>
                                  {val}{val !== '—' && unit ? ` ${unit}` : ''}{abn ? ' ⚠' : ''}
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  /* Fallback: old bundle without vitalHistory — keep existing grid */
                  <div className={styles.vitalsGrid}>
                    {vitals.map(({ label, value, unit, key }) => {
                      if (!showIf(value)) return null
                      const abnormal = key ? isVitalAbnormal(key, value) : false
                      const isSpO2 = label === 'SPO2'
                      const displayValue = (label === 'BP' && value !== '--' && unit && !value.includes(unit)) ? `${value} ${unit}` : value
                      return (
                        <div key={label} className={`${styles.vitalCard} ${abnormal ? styles.vitalCardAbnormal : ''}`}>
                          <span className={styles.vitalLabel}>{label}</span>
                          <span className={`${styles.vitalValue} ${abnormal ? styles.vitalValueAbnormal : ''}`}>
                            {abnormal && <span className={styles.vitalFlag}>(!) </span>}
                            {displayValue}
                          </span>
                          {isSpO2 && (spo2Device || spo2FlowRate) && (
                            <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '5px', display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap', lineHeight: 1.4 }}>
                              {spo2Device && <span>{spo2Device}</span>}
                              {spo2FlowRate && <span>{spo2FlowRate} L/min</span>}
                            </div>
                          )}
                        </div>
                      )
                    })}
                    {painScore !== null && (
                      <div className={styles.vitalCard}>
                        <span className={styles.vitalLabel}>PAIN</span>
                        <span className={styles.vitalValue}>{painScore}<span style={{ fontSize: '0.55em', fontWeight: 400, color: '#94a3b8', marginLeft: '2px' }}>/10</span></span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* SECTION 6: ASSESSMENT HISTORY — horizontal time-column table */}
            {(assessmentHistory.length > 0 || !!assessment) && (
              <div className={styles.section} style={flashStyle('assessment', flashedSections)}>
                <h3 className={styles.sectionTitle}>Assessment</h3>
                {assessmentHistory.length > 0 ? (
                  /* Horizontal time-column table — field labels sticky on left, each entry is a column */
                  <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: '4px' }}>
                    <table style={{ borderCollapse: 'collapse', minWidth: 'max-content', width: '100%' }}>
                      <thead>
                        <tr>
                          <th style={{ position: 'sticky', left: 0, zIndex: 2, background: '#0f172a', padding: '6px 10px', textAlign: 'left', fontSize: '11px', fontWeight: 700, color: '#475569', textTransform: 'uppercase', whiteSpace: 'nowrap', minWidth: '100px', borderRight: '1px solid #1e293b', borderBottom: '1px solid #334155' }}>Field</th>
                          {assessmentHistory.map((entry, idx) => {
                            const isInitial = idx === 0
                            const isCurrent = idx === assessmentHistory.length - 1
                            return (
                              <th key={idx} style={{ padding: '6px 12px', textAlign: 'center', fontSize: '11px', minWidth: '160px', borderBottom: '1px solid #334155', background: isCurrent && assessmentHistory.length > 1 ? 'rgba(34,197,94,0.05)' : '#0f172a', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                                <div style={{ fontWeight: 700, color: '#e2e8f0' }}>{isInitial ? 'Initial' : entry.label} {isInitial ? '🔒' : ''}</div>
                                <div style={{ fontSize: '10px', color: '#475569', marginTop: '2px' }}>{formatHistoryDate(entry.timestamp)}</div>
                                {isCurrent && assessmentHistory.length > 1 && (
                                  <div style={{ marginTop: '3px' }}>
                                    <span style={{ padding: '1px 6px', borderRadius: '8px', background: 'rgba(34,197,94,0.15)', border: '1px solid #22c55e', color: '#4ade80', fontSize: '10px', fontWeight: 700 }}>● CURRENT</span>
                                  </div>
                                )}
                              </th>
                            )
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {([
                          { label: 'AVPU',          getV: (e: typeof assessmentHistory[0]) => e.avpu ?? '' },
                          { label: 'Orientation',   getV: (e: typeof assessmentHistory[0]) => { const o = e.orientation ?? []; if (o.length === 0) return ''; if (o.includes('x0 (None)')) return 'AxO x0'; return `AxO x${o.length} (${o.join(', ')})`; } },
                          { label: 'Pupils',        getV: (e: typeof assessmentHistory[0]) => e.pupils ?? '' },
                          { label: 'Speech',        getV: (e: typeof assessmentHistory[0]) => e.speech ?? '' },
                          { label: 'Motor L',       getV: (e: typeof assessmentHistory[0]) => e.motorLeft ?? '' },
                          { label: 'Motor R',       getV: (e: typeof assessmentHistory[0]) => e.motorRight ?? '' },
                          { label: 'Airway',        getV: (e: typeof assessmentHistory[0]) => e.airway ?? '' },
                          { label: 'Lung Sounds',   getV: (e: typeof assessmentHistory[0]) => (e.lungSounds ?? []).join(', ') },
                          { label: 'Skin',          getV: (e: typeof assessmentHistory[0]) => (e.skin ?? []).join(', ') },
                          { label: 'Pertinent Neg', getV: (e: typeof assessmentHistory[0]) => (e.pertinentNegatives ?? []).join(', ') },
                        ] as { label: string; getV: (e: typeof assessmentHistory[0]) => string }[]).map(({ label, getV }) => (
                          <tr key={label}>
                            <td style={{ position: 'sticky', left: 0, zIndex: 1, background: '#0f172a', padding: '5px 10px', fontSize: '12px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', whiteSpace: 'nowrap', borderRight: '1px solid #1e293b', borderTop: '1px solid #0f1f2e' }}>{label}</td>
                            {assessmentHistory.map((entry, idx) => {
                              const val = getV(entry) || '—'
                              const isCurrent = idx === assessmentHistory.length - 1
                              return (
                                <td key={idx} style={{ padding: '5px 12px', textAlign: 'center', fontSize: '13px', color: '#f1f5f9', background: isCurrent && assessmentHistory.length > 1 ? 'rgba(34,197,94,0.03)' : 'transparent', borderTop: '1px solid #0f1f2e', wordBreak: 'break-word', maxWidth: '200px' }}>
                                  {val}
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : assessment && (
                  /* Fallback: old bundle without assessmentHistory */
                  <>
                    <div style={{ marginBottom: '12px' }}>
                      <span className={styles.label} style={{ fontSize: '11px', letterSpacing: '0.08em', color: '#64748b', textTransform: 'uppercase' }}>Neuro</span>
                      <div className={styles.contextRow} style={{ marginTop: '6px' }}>
                        <Field label="AVPU" value={assessment.mentalStatus ?? '\u2014'} />
                        {assessment.gcs !== undefined && assessment.gcs !== null && (
                          <Field label="GCS" value={String(assessment.gcs)} />
                        )}
                        <Field label="Orientation" value={(() => {
                          const orient = assessment.orientation ?? [];
                          if (orient.length === 0) return '\u2014';
                          if (orient.includes('x0 (None)')) return 'AxO x0 (None)';
                          return `AxO x${orient.length} (${orient.join(', ')})`;
                        })()} />
                        {assessment.pupils && <Field label="Pupils" value={assessment.pupils} />}
                        {assessment.motorLeft && <Field label="Motor L" value={assessment.motorLeft} />}
                        {assessment.motorRight && <Field label="Motor R" value={assessment.motorRight} />}
                        {assessment.speech && <Field label="Speech" value={assessment.speech} />}
                      </div>
                    </div>
                    {(assessment.airway || (assessment.lungSounds?.length ?? 0) > 0 || (assessment.skin?.length ?? 0) > 0) && (
                      <div>
                        <span className={styles.label} style={{ fontSize: '11px', letterSpacing: '0.08em', color: '#64748b', textTransform: 'uppercase' }}>Physical</span>
                        <div className={styles.contextRow} style={{ marginTop: '6px' }}>
                          {assessment.airway && <Field label="Airway" value={assessment.airway} />}
                          {assessment.lungSounds && assessment.lungSounds.length > 0 && (
                            <Field label="Lung Sounds" value={assessment.lungSounds.join(', ')} />
                          )}
                          {assessment.skin && assessment.skin.length > 0 && (
                            <Field label="Skin" value={assessment.skin.join(', ')} />
                          )}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* SECTION 7: HISTORY */}
            {hasMedHistory && (
              <div className={styles.section}>
                <h3 className={styles.sectionTitle}>History</h3>

                {showIf(knownHistory) && (
                  <div className={styles.resourceBlock}>
                    <span className={styles.label}>Past Medical History</span>
                    <div className={styles.chips}>
                      {knownHistory!.split(',').map((h, i) => (
                        <span key={i} className={styles.chipHistory}>{h.trim()}</span>
                      ))}
                    </div>
                  </div>
                )}

                {medications.length > 0 && (
                  <div className={styles.resourceBlock}>
                    <span className={styles.label}>Medications</span>
                    <div className={styles.chips}>
                      {medications.map((med, i) => (
                        <span key={i} className={styles.chipMed}>{med}</span>
                      ))}
                    </div>
                  </div>
                )}

                {showIf(allergies) && (
                  <div className={styles.resourceBlock}>
                    <span className={styles.label}>Allergies</span>
                    <div className={styles.chips}>
                      {allergies!.split(',').map((a, i) => (
                        <span key={i} style={{
                          padding: '3px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                          background: 'rgba(239,68,68,0.15)', border: '1px solid #ef4444', color: '#f87171',
                        }}>{a.trim()}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* SECTION 8: CONTEXTUAL DATA */}
            {hasContextual && (
              <div className={styles.section}>
                <h3 className={styles.sectionTitle}>Contextual Data</h3>

                {(showIf(originSource) || showIf(originAddress) ||
                  showIf(contactNameDisplay) || showIf(contactPhoneDisplay)) && (
                  <div className={styles.contextRow}>
                    {showIf(originSource) && <Field label="From" value={originSource!} />}
                    {showIf(originAddress) && <Field label="Address" value={originAddress!} />}
                    {showIf(contactNameDisplay) && (
                      <Field label="Emergency Contact" value={contactNameDisplay!} />
                    )}
                    {showIf(contactRelationship) && <Field label="Relationship" value={contactRelationship!} />}
                    {showIf(contactPhoneDisplay) && <Field label="Contact Phone" value={contactPhoneDisplay!} />}
                  </div>
                )}

                {showIf(lastOralIntake) && (
                  <div className={styles.narrativeBlock}>
                    <span className={styles.label}>Last Oral Intake</span>
                    <p className={styles.narrativeText}>{lastOralIntake}</p>
                  </div>
                )}

                {showIf(events) && (
                  <div className={styles.narrativeBlock}>
                    <span className={styles.label}>Events</span>
                    <p className={styles.narrativeText}>{events}</p>
                  </div>
                )}

                {sceneNotes.length > 0 && (
                  <div className={styles.resourceBlock}>
                    <span className={styles.label}>Scene Notes</span>
                    <div className={styles.chips}>
                      {sceneNotes.map((note, i) => (
                        <span key={i} style={{
                          padding: '3px 10px', borderRadius: '6px', fontSize: '12px',
                          background: 'rgba(234,179,8,0.15)', border: '1px solid #ca8a04', color: '#fde047',
                        }}>{note}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Bundle ID footer */}
            <div className={styles.footer}>
              <span className={styles.label}>Bundle ID</span>
              <span className={`${styles.bundleId} ${styles.mono}`}>{bundle.id}</span>
            </div>

          </div>{/* end .body */}

          {/* Sprint 4.2: Sticky Arrive Action Bar (bottom of left pane) */}
          {mode === 'live' && canArrivePatients && bundle.handoffStatus !== 'arrived' && (
            <div className={styles.arriveBar}>
              {arriveError && (
                <span className={styles.arriveErrorText}>{arriveError}</span>
              )}
              {arriveStep === 'idle' && (
                <button className={styles.arriveBtn} onClick={handleArrive}>
                  Arrive Patient
                </button>
              )}
              {arriveStep === 'confirm' && (
                <>
                  <span className={styles.arriveConfirmText}>
                    Arrive <strong>{formatPatientName(getPatient(bundle))}</strong>?
                  </span>
                  <button className={styles.arriveConfirmBtn} onClick={handleArrive}>
                    Confirm
                  </button>
                  <button className={styles.arriveCancelBtn} onClick={() => setArriveStep('idle')}>
                    Cancel
                  </button>
                </>
              )}
              {arriveStep === 'arriving' && (
                <button className={styles.arriveBtn} disabled>Arriving...</button>
              )}
            </div>
          )}

        </div>{/* end .leftPane */}

        {/* RIGHT PANE: Chat Hub */}
        <div className={styles.rightPane}>
          <ChatPanel
            bundle={bundle}
            hospitalId={hospitalId}
            userSession={userSession}
            messages={chatMessages}
            onMessagesLoaded={onMessagesLoaded}
            onNewMessage={onNewMessage}
          />
        </div>

      </div>{/* end .modalOuter */}
    </div>
  )
}
