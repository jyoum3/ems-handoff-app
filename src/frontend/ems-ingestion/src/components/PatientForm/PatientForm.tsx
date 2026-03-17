/**
 * PatientForm.tsx — EMS Ingestion PWA: 7-Section Patient Data Entry Form
 * ========================================================================
 * Phase 4 Sprint 2.5 — Complete rewrite
 *
 * SECTIONS (all collapsible):
 *   1. Identification & Alerts   (IdentificationSection)
 *   2. Chief Complaint & Timeline (ChiefComplaintSection)
 *   3. Vital Signs               (VitalsSection)
 *   4. Assessment                (AssessmentSection)
 *   5. Interventions             (InterventionsSection)
 *   6. History (SAMPLE)          (HistorySection)
 *   7. Origin & Scene            (OriginSection)
 */

import { useState, useRef } from 'react';
import type { EmsSession, EcgRecord, FHIRBundle } from '../../types/fhir';
import {
  buildFHIRBundle,
  generateBundleId,
  type PatientFormData,
} from '../../utils/fhirBuilder';
import { submitHandoff, uploadEcg } from '../../services/api';

import IdentificationSection from './IdentificationSection';
import ChiefComplaintSection from './ChiefComplaintSection';
import VitalsSection from './VitalsSection';
import AssessmentSection from './AssessmentSection';
import InterventionsSection from './InterventionsSection';
import HistorySection from './HistorySection';
import OriginSection from './OriginSection';

import styles from './PatientForm.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PatientFormProps {
  session: EmsSession;
  onSubmitted: (bundle: FHIRBundle) => void;
}

// ---------------------------------------------------------------------------
// Default form state
// ---------------------------------------------------------------------------

const DEFAULT_FORM: PatientFormData = {
  // Section 1
  isUnknownPatient: false,
  familyName: '',
  givenName: '',
  birthDate: '',
  gender: '',
  codeStatus: '',
  alertBadges: [],
  emergencyContactFamily: '',
  emergencyContactGiven: '',
  emergencyContactPhone: '',
  emergencyContactRelationship: '',
  // Section 2
  chiefComplaint: '',
  esiLevel: '',
  triageNote: '',
  lastKnownWell: 'Unknown',
  onsetTime: 'Unknown',
  emsContactTime: '',
  arrivalEta: '',
  encounterTypes: [],
  // Section 3 — Initial
  hrInitial: '',
  bpInitial: '',
  bpLocationInitial: '',
  bpOrientationInitial: '',
  rrInitial: '',
  spo2Initial: '',
  spo2DeviceInitial: '',
  spo2FlowRateInitial: '',
  tempInitial: '',
  tempLocationInitial: '',
  sugarInitial: '',
  height: '',
  weight: '',
  painInitial: '',
  // Section 3 — Current
  hrCurrent: '',
  bpCurrent: '',
  bpLocationCurrent: '',
  bpOrientationCurrent: '',
  rrCurrent: '',
  spo2Current: '',
  spo2DeviceCurrent: '',
  spo2FlowRateCurrent: '',
  tempCurrent: '',
  tempLocationCurrent: '',
  sugarCurrent: '',
  // Sprint 3.1 Fix 6: current vitals height/weight/pain
  heightCurrent: '',
  weightCurrent: '',
  painCurrent: '',
  gcsCurrent: '',
  // Section 4
  mentalStatus: '',
  gcs: '',
  orientation: [],
  pupils: '',
  motorLeft: '',
  motorRight: '',
  speech: '',
  airway: '',
  lungSounds: [],
  skin: [],
  pertinentNegatives: [],
  // Section 5
  interventions: [],
  resourceRequirements: [],
  // Section 6
  allergies: [],
  medications: [],
  knownHistory: [],
  lastOralIntake: '',
  events: '',
  // Section 7
  originSource: '',
  originAddress: '',
  sceneNotes: [],
  // Top-level
  hospitalId: '',
  isolation: '',
  // Sprint 3.3: vital timestamps (transportNotes removed — superseded by transportLog[])
  vitalInitialTime: '',
  vitalCurrentTime: '',
};

// ---------------------------------------------------------------------------
// Section descriptor (controls collapsible behavior)
// ---------------------------------------------------------------------------

type SectionId = 'id' | 'complaint' | 'vitals' | 'assessment' | 'interventions' | 'history' | 'origin';

interface SectionDescriptor {
  id: SectionId;
  title: string;
  badge?: string;
}

const SECTIONS: SectionDescriptor[] = [
  { id: 'id', title: '1. Identification & Alerts' },
  { id: 'complaint', title: '2. Chief Complaint & Timeline' },
  { id: 'vitals', title: '3. Vital Signs' },
  { id: 'assessment', title: '4. Assessment' },
  { id: 'interventions', title: '5. Interventions & Resources' },
  { id: 'history', title: '6. History (AMPLE)' },
  { id: 'origin', title: '7. Origin & Scene' },
];

const HOSPITAL_OPTIONS = [
  { value: 'HUP-PAV', label: 'HUP — Pavilion' },
  { value: 'HUP-PRESBY', label: 'HUP — Presbyterian' },
  { value: 'HUP-CEDAR', label: 'HUP — Cedar' },
];

// ---------------------------------------------------------------------------
// PatientForm
// ---------------------------------------------------------------------------

export default function PatientForm({ session, onSubmitted }: PatientFormProps) {
  const [formData, setFormData] = useState<PatientFormData>(DEFAULT_FORM);
  const [openSections, setOpenSections] = useState<Record<SectionId, boolean>>({
    id: true,
    complaint: true,
    vitals: true,
    assessment: true,
    interventions: true,
    history: true,
    origin: true,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [validationError, setValidationError] = useState('');

  // BundleId generated once per patient encounter — stable across retries
  const bundleIdRef = useRef<string>(generateBundleId(session.medicUnit));

  // ECG state — separate from PatientFormData (transient UI state).
  // stagedEcgFile: File object selected by medic, NOT yet uploaded.
  //   Upload happens in handleSubmit after successful bundle submission.
  // ecgRecords: confirmed records returned from the backend after upload.
  const [stagedEcgFile, setStagedEcgFile] = useState<File | null>(null);
  const [stagedEcgRhythm, setStagedEcgRhythm] = useState('');
  const [ecgRecords, setEcgRecords] = useState<EcgRecord[]>([]);

  const handleDeleteEcg = (index: number) => {
    setEcgRecords(prev => prev.filter((_, i) => i !== index));
  };

  // ── Generic field update handler ───────────────────────────────────────
  const handleChange = (
    field: keyof PatientFormData,
    value: PatientFormData[keyof PatientFormData],
  ) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  // ── Collapsible section toggle ─────────────────────────────────────────
  const toggleSection = (sectionId: SectionId) => {
    setOpenSections((prev) => ({ ...prev, [sectionId]: !prev[sectionId] }));
  };

  // ── Section data summary (fields populated indicator) ─────────────────
  function getSectionFieldCount(id: SectionId): number {
    switch (id) {
      case 'id':
        return [formData.familyName, formData.givenName, formData.birthDate,
          formData.gender, formData.codeStatus].filter(Boolean).length
          + formData.alertBadges.length;
      case 'complaint':
        return [formData.chiefComplaint, formData.esiLevel, formData.triageNote.trim()].filter(Boolean).length;
      case 'vitals':
        return [formData.hrInitial, formData.bpInitial, formData.rrInitial,
          formData.spo2Initial, formData.tempInitial, formData.sugarInitial].filter(Boolean).length;
      case 'assessment':
        return [formData.mentalStatus, formData.gcs, formData.pupils,
          formData.airway].filter(Boolean).length
          + formData.orientation.length + formData.lungSounds.length + formData.skin.length;
      case 'interventions':
        return formData.interventions.length + formData.resourceRequirements.length;
      case 'history':
        return [formData.lastOralIntake, formData.events].filter(Boolean).length
          + formData.allergies.length + formData.medications.length + formData.knownHistory.length;
      case 'origin':
        return [formData.originSource, formData.originAddress].filter(Boolean).length
          + formData.sceneNotes.length;
      default:
        return 0;
    }
  }

  // ── Validation ─────────────────────────────────────────────────────────
  const validate = (): boolean => {
    setValidationError('');

    if (!formData.hospitalId) {
      setValidationError('Please select a destination hospital.');
      return false;
    }
    const hasIdentifier =
      formData.givenName.trim() ||
      formData.familyName.trim() ||
      formData.chiefComplaint.trim() ||
      formData.isUnknownPatient;

    if (!hasIdentifier) {
      setValidationError('Please enter at least a patient name, chief complaint, or check "Unknown Patient".');
      return false;
    }

    return true;
  };

  // ── Submit handler ──────────────────────────────────────────────────────
  const handleSubmit = async () => {
    setSubmitError('');
    if (!validate()) return;

    setIsSubmitting(true);
    try {
      const bundleId = bundleIdRef.current;
      const bundle = buildFHIRBundle(formData, session, bundleId);
      await submitHandoff(bundle);

      // Fix 1: Upload staged ECG BEFORE calling onSubmitted so LiveHandoffView
      // mounts with ecgRecords already populated — prevents blank ECG section on load.
      let finalBundle: FHIRBundle = bundle;
      if (stagedEcgFile && formData.hospitalId) {
        try {
          const result = await uploadEcg(
            bundleId,
            formData.hospitalId,
            stagedEcgFile,
            stagedEcgRhythm.trim() || undefined,
          );
          const newRecord: EcgRecord = {
            url: result.blob_url,
            timestamp: new Date().toISOString(),
            label: result.label,
            blobKey: result.blobKey,
            rhythmInterpretation: stagedEcgRhythm.trim() || undefined,
          };
          finalBundle = { ...bundle, ecgRecords: [newRecord] };
          setEcgRecords([newRecord]);
          setStagedEcgFile(null);
          setStagedEcgRhythm('');
        } catch (err) {
          // Non-blocking: still proceed with onSubmitted using bundle without ECG.
          console.error('[PatientForm] ECG upload failed:', err);
        }
      }

      onSubmitted(finalBundle); // ← passes complete bundle (with or without ECG)
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : 'Submission failed. Please try again.',
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className={styles.formContainer}>

      {/* ── Hospital Selector (top, prominent) ────────────────────── */}
      <div className={styles.hospitalSelector}>
        <label className={styles.hospitalLabel}>
          Destination Hospital <span className={styles.required}>*</span>
        </label>
        <select
          className={`${styles.select} ${styles.hospitalSelect}`}
          value={formData.hospitalId}
          onChange={(e) => handleChange('hospitalId', e.target.value)}
        >
          <option value="">Select destination hospital…</option>
          {HOSPITAL_OPTIONS.map((h) => (
            <option key={h.value} value={h.value}>{h.label}</option>
          ))}
        </select>
      </div>

      {/* ── 7 Collapsible Sections ────────────────────────────────── */}
      {SECTIONS.map(({ id, title }) => {
        const isOpen = openSections[id];
        const fieldCount = getSectionFieldCount(id);

        return (
          <div key={id} className={styles.sectionCard}>
            {/* Section header */}
            <button
              type="button"
              className={styles.sectionHeader}
              onClick={() => toggleSection(id)}
            >
              <span className={styles.sectionTitle}>{title}</span>
              <div className={styles.sectionHeaderRight}>
                {/* ECG status badge — only on Vital Signs section header */}
                {id === 'vitals' && ecgRecords.length > 0 && (
                  <span style={{
                    fontSize: '11px', fontWeight: 700,
                    padding: '2px 8px', borderRadius: '10px',
                    background: 'rgba(249,115,22,0.15)', border: '1px solid #F97316', color: '#fb923c',
                    marginRight: '4px',
                  }}>
                    📷 {ecgRecords.length === 1 ? '1 ECG' : `${ecgRecords.length} ECGs`}
                  </span>
                )}
                {id === 'vitals' && stagedEcgFile && ecgRecords.length === 0 && (
                  <span style={{
                    fontSize: '11px', fontWeight: 700,
                    padding: '2px 8px', borderRadius: '10px',
                    background: 'rgba(234,179,8,0.12)', border: '1px solid #ca8a04', color: '#fde047',
                    marginRight: '4px',
                  }}>
                    📷 ECG Staged
                  </span>
                )}
                {fieldCount > 0 && (
                  <span className={styles.sectionBadge}>✓ {fieldCount}</span>
                )}
                <span className={`${styles.sectionChevron} ${isOpen ? styles.sectionChevronOpen : ''}`}>
                  ▾
                </span>
              </div>
            </button>

            {/* Section body — always rendered (CSS hide preserves component state) */}
            <div className={styles.sectionBody} style={{ display: isOpen ? 'block' : 'none' }}>
              {id === 'id' && (
                <IdentificationSection data={formData} onChange={handleChange} />
              )}
              {id === 'complaint' && (
                <ChiefComplaintSection data={formData} onChange={handleChange} />
              )}
              {id === 'vitals' && (
                <VitalsSection
                  data={formData}
                  onChange={handleChange}
                  stagedEcgFile={stagedEcgFile}
                  stagedEcgRhythm={stagedEcgRhythm}
                  onStagedEcgFileChange={setStagedEcgFile}
                  onStagedEcgRhythmChange={setStagedEcgRhythm}
                  onDeleteEcg={handleDeleteEcg}
                  ecgRecords={ecgRecords}
                />
              )}
              {id === 'assessment' && (
                <AssessmentSection data={formData} onChange={handleChange} />
              )}
              {id === 'interventions' && (
                <InterventionsSection data={formData} onChange={handleChange} />
              )}
              {id === 'history' && (
                <HistorySection data={formData} onChange={handleChange} />
              )}
              {id === 'origin' && (
                <OriginSection data={formData} onChange={handleChange} />
              )}
            </div>
          </div>
        );
      })}

      {/* ── Validation / Submit Error Messages ───────────────────── */}
      {validationError && (
        <div className={styles.inlineError}>{validationError}</div>
      )}
      {submitError && (
        <div className={styles.submitError}>{submitError}</div>
      )}

      {/* ── Submit Button ─────────────────────────────────────────── */}
      <button
        type="button"
        className={styles.submitBtn}
        onClick={handleSubmit}
        disabled={isSubmitting}
      >
        {isSubmitting ? '⏳ Submitting Handoff…' : '🚑 Submit Handoff'}
      </button>
    </div>
  );
}
