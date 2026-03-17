/**
 * InterventionsSection.tsx — Section 5: Interventions & Resource Requirements
 * ============================================================================
 * Phase 4 Sprint 2.5 — New dedicated section
 *
 * Two chip inputs:
 *   Interventions (Enter/comma adds chip)
 *   Resource Requirements (Enter/comma adds chip)
 */

import { useRef } from 'react';
import type { PatientFormData } from '../../utils/fhirBuilder';
import styles from './PatientForm.module.css';

interface InterventionsSectionProps {
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

export default function InterventionsSection({ data, onChange }: InterventionsSectionProps) {
  return (
    <div className={styles.sectionContent}>

      {/* Interventions */}
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>Interventions</label>
        <ChipInput
          chips={data.interventions}
          onAdd={(v) => onChange('interventions', [...data.interventions, v])}
          onRemove={(i) => onChange('interventions', data.interventions.filter((_, idx) => idx !== i))}
          placeholder="e.g. IV Access, 12-Lead EKG, Dextrose 50%, RSI, Tourniquet…"
        />
      </div>

      {/* Resource Requirements */}
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>Resource Requirements</label>
        <ChipInput
          chips={data.resourceRequirements}
          onAdd={(v) => onChange('resourceRequirements', [...data.resourceRequirements, v])}
          onRemove={(i) => onChange('resourceRequirements', data.resourceRequirements.filter((_, idx) => idx !== i))}
          placeholder="e.g. LVAD Specialist, Bariatric Bed, Trauma Bay, Isolation Room…"
        />
      </div>

    </div>
  );
}
