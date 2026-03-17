/**
 * HistorySection.tsx — Section 7: Medical History (AMPLE)
 * =========================================================
 * Phase 4 Sprint 2.5 — Replaces ResourcesSection.tsx
 * Phase 4 Sprint 3 — Label corrected: HISTORY (SAMPLE) → HISTORY (AMPLE)
 *   'S' (Symptoms) was removed from the schema in Sprint 2.5 — label now matches.
 *
 * AMPLE: Allergies, Medications, Past Medical History,
 *         Last Oral Intake, Events Leading to Call
 */

import { useRef } from 'react';
import type { PatientFormData } from '../../utils/fhirBuilder';
import styles from './PatientForm.module.css';

interface HistorySectionProps {
  data: PatientFormData;
  onChange: (field: keyof PatientFormData, value: PatientFormData[keyof PatientFormData]) => void;
}

interface ChipInputProps {
  chips: string[];
  onAdd: (value: string) => void;
  onRemove: (index: number) => void;
  placeholder?: string;
}

function ChipInput({ chips, onAdd, onRemove, placeholder }: ChipInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={styles.chipInputWrapper}>
      <div className={styles.chipList}>
        {chips.map((chip, i) => (
          <span key={i} className={styles.chip}>
            {chip}
            <button type="button" className={styles.chipRemove} onClick={() => onRemove(i)}>✕</button>
          </span>
        ))}
      </div>
      <input
        ref={inputRef}
        type="text"
        className={styles.chipTextInput}
        placeholder={chips.length === 0 ? placeholder : 'Add more…'}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ',') && e.currentTarget.value.trim()) {
            e.preventDefault();
            onAdd(e.currentTarget.value.trim());
            e.currentTarget.value = '';
          }
        }}
      />
    </div>
  );
}

export default function HistorySection({ data, onChange }: HistorySectionProps) {
  return (
    <div className={styles.sectionContent}>

      {/* Allergies (A) — chip input */}
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>
          <span className={styles.sampleLetter}>A</span> Allergies
        </label>
        <ChipInput
          chips={data.allergies}
          onAdd={(v) => onChange('allergies', [...data.allergies, v])}
          onRemove={(i) => onChange('allergies', data.allergies.filter((_, idx) => idx !== i))}
          placeholder="e.g. Penicillin, Sulfa, NKDA…"
        />
      </div>

      {/* Medications (M) */}
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>
          <span className={styles.sampleLetter}>M</span> Medications
        </label>
        <ChipInput
          chips={data.medications}
          onAdd={(v) => onChange('medications', [...data.medications, v])}
          onRemove={(i) => onChange('medications', data.medications.filter((_, idx) => idx !== i))}
          placeholder="e.g. Metformin, Lisinopril, Aspirin…"
        />
      </div>

      {/* Past Medical History (P) */}
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>
          <span className={styles.sampleLetter}>P</span> Past Medical History
        </label>
        <ChipInput
          chips={data.knownHistory}
          onAdd={(v) => onChange('knownHistory', [...data.knownHistory, v])}
          onRemove={(i) => onChange('knownHistory', data.knownHistory.filter((_, idx) => idx !== i))}
          placeholder="e.g. Type 2 Diabetes, HTN, Afib, COPD…"
        />
      </div>

      {/* Last Oral Intake (L) */}
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>
          <span className={styles.sampleLetter}>L</span> Last Oral Intake
        </label>
        <input
          type="text"
          className={styles.input}
          value={data.lastOralIntake}
          onChange={(e) => onChange('lastOralIntake', e.target.value)}
          placeholder="e.g. 3 hours ago, 0800 this morning, Unknown"
        />
      </div>

      {/* Events Leading to Call (E) */}
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>
          <span className={styles.sampleLetter}>E</span> Events Leading to Call
        </label>
        <textarea
          className={styles.textarea}
          rows={3}
          value={data.events}
          onChange={(e) => onChange('events', e.target.value)}
          placeholder="Narrative of events leading to EMS activation…"
        />
      </div>

    </div>
  );
}
