/**
 * OriginSection.tsx — Section 7: Origin & Scene
 * ================================================
 * Phase 4 Sprint 2.5 — Split from former ResourcesSection
 *
 * Fields:
 *   Origin Source (select)
 *   Origin Address (text)
 *   Scene Notes (chip input — amber chips for scene context)
 */

import { useRef } from 'react';
import type { PatientFormData } from '../../utils/fhirBuilder';
import styles from './PatientForm.module.css';

interface OriginSectionProps {
  data: PatientFormData;
  onChange: (field: keyof PatientFormData, value: PatientFormData[keyof PatientFormData]) => void;
}

const ORIGIN_SOURCES = [
  'Scene',
  'Skilled Nursing Facility',
  'Residence',
  'Motor Vehicle Accident',
  'Other',
];

interface ChipInputProps {
  chips: string[];
  onAdd: (value: string) => void;
  onRemove: (index: number) => void;
  placeholder?: string;
  chipColor?: string;
}

function ChipInput({ chips, onAdd, onRemove, placeholder, chipColor }: ChipInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={styles.chipInputWrapper}>
      <div className={styles.chipList}>
        {chips.map((chip, i) => (
          <span
            key={i}
            className={styles.chip}
            style={chipColor ? { background: chipColor, color: '#92400e' } : undefined}
          >
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

export default function OriginSection({ data, onChange }: OriginSectionProps) {
  return (
    <div className={styles.sectionContent}>

      {/* Origin Source */}
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>Origin Source</label>
        <select
          className={styles.select}
          value={data.originSource}
          onChange={(e) => onChange('originSource', e.target.value)}
        >
          <option value="">Select origin type…</option>
          {ORIGIN_SOURCES.map((src) => (
            <option key={src} value={src}>{src}</option>
          ))}
        </select>
      </div>

      {/* Origin Address */}
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>Origin Address</label>
        <input
          type="text"
          className={styles.input}
          value={data.originAddress}
          onChange={(e) => onChange('originAddress', e.target.value)}
          placeholder="e.g. 1234 Market St, Philadelphia, PA 19103"
        />
      </div>

      {/* Scene Notes — amber chips */}
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>Scene Notes</label>
        <ChipInput
          chips={data.sceneNotes}
          onAdd={(v) => onChange('sceneNotes', [...data.sceneNotes, v])}
          onRemove={(i) => onChange('sceneNotes', data.sceneNotes.filter((_, idx) => idx !== i))}
          placeholder="e.g. Empty pill bottles found, No seatbelt used, Found at bottom of stairs…"
          chipColor="#FEF3C7"
        />
      </div>

    </div>
  );
}
