/**
 * AssessmentSection.tsx — Section 4: Neurological & Physical Assessment
 * ======================================================================
 * Phase 4 Sprint 2.5 — New section (GCS moved here from Vitals)
 *
 * Two sub-cards:
 *   Neuro: AVPU toggle, GCS, Orientation AxO, Pupils, Motor L/R, Speech
 *   Physical: Airway, Lung Sounds (multi-select chips), Skin (multi-select chips),
 *             Pertinent Negatives (free chip input)
 */

import { useRef } from 'react';
import type { PatientFormData } from '../../utils/fhirBuilder';
import styles from './PatientForm.module.css';

interface AssessmentSectionProps {
  data: PatientFormData;
  onChange: (field: keyof PatientFormData, value: PatientFormData[keyof PatientFormData]) => void;
}

// Pre-defined options for multi-select chip groups
const LUNG_SOUNDS_OPTIONS = [
  'Clear', 'Wheeze R', 'Wheeze L', 'Wheeze Bilateral',
  'Crackles R', 'Crackles L', 'Crackles Bilateral',
  'Absent R', 'Absent L', 'Stridor',
];
const SKIN_OPTIONS = [
  'Warm', 'Cool', 'Hot', 'Dry', 'Moist', 'Diaphoretic',
  'Pale', 'Flushed', 'Cyanotic', 'Mottled', 'Jaundiced',
];
const ORIENTATION_OPTIONS = ['Person', 'Place', 'Time', 'Situation'];
// x0 is mutually exclusive with the above — selecting it clears all others
const ORIENTATION_NONE = 'x0 (None)';

// ---------------------------------------------------------------------------
// ChipInput — free-form chip with Enter/comma trigger
// ---------------------------------------------------------------------------

interface FreeChipInputProps {
  chips: string[];
  onAdd: (v: string) => void;
  onRemove: (i: number) => void;
  placeholder?: string;
}

function FreeChipInput({ chips, onAdd, onRemove, placeholder }: FreeChipInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={styles.chipInputWrapper}>
      <div className={styles.chipList}>
        {chips.map((c, i) => (
          <span key={i} className={styles.chip}>
            {c}
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

// ---------------------------------------------------------------------------
// MultiSelectChips — toggle-style chips from a predefined list
// ---------------------------------------------------------------------------

interface MultiSelectChipsProps {
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
  onAddCustom?: (value: string) => void;
  onRemove?: (index: number) => void;
}

function MultiSelectChips({ options, selected, onToggle, onAddCustom, onRemove }: MultiSelectChipsProps) {
  return (
    <div>
      <div className={styles.chipGroup}>
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            className={`${styles.chipOption} ${selected.includes(opt) ? styles.chipOptionSelected : ''}`}
            onClick={() => onToggle(opt)}
          >
            {opt}
          </button>
        ))}
      </div>
      {onAddCustom && onRemove && (
        <FreeChipInput
          chips={selected.filter((s) => !options.includes(s))}
          onAdd={onAddCustom}
          onRemove={(i) => {
            const customChips = selected.filter((s) => !options.includes(s));
            onRemove(selected.indexOf(customChips[i]));
          }}
          placeholder="Custom…"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AssessmentSection
// ---------------------------------------------------------------------------

export default function AssessmentSection({ data, onChange }: AssessmentSectionProps) {

  // Orientation AxO toggle — x0 (None) is mutually exclusive with all others
  const toggleOrientation = (domain: string) => {
    const current = data.orientation;
    if (domain === ORIENTATION_NONE) {
      // Selecting x0 clears all standard domains
      onChange('orientation', current.includes(ORIENTATION_NONE) ? [] : [ORIENTATION_NONE]);
    } else {
      // Selecting a standard domain clears x0
      const withoutNone = current.filter((d) => d !== ORIENTATION_NONE);
      const next = withoutNone.includes(domain)
        ? withoutNone.filter((d) => d !== domain)
        : [...withoutNone, domain];
      onChange('orientation', next);
    }
  };

  // Lung sounds multi-select
  const toggleLungSound = (val: string) => {
    const current = data.lungSounds;
    onChange('lungSounds', current.includes(val)
      ? current.filter((v) => v !== val)
      : [...current, val]);
  };
  const addCustomLungSound = (val: string) => onChange('lungSounds', [...data.lungSounds, val]);
  const removeLungSoundAt = (i: number) => onChange('lungSounds', data.lungSounds.filter((_, idx) => idx !== i));

  // Skin multi-select
  const toggleSkin = (val: string) => {
    const current = data.skin;
    onChange('skin', current.includes(val)
      ? current.filter((v) => v !== val)
      : [...current, val]);
  };
  const addCustomSkin = (val: string) => onChange('skin', [...data.skin, val]);
  const removeSkinAt = (i: number) => onChange('skin', data.skin.filter((_, idx) => idx !== i));

  // Pertinent negatives
  const addNegative = (val: string) => onChange('pertinentNegatives', [...data.pertinentNegatives, val]);
  const removeNegative = (i: number) => onChange('pertinentNegatives', data.pertinentNegatives.filter((_, idx) => idx !== i));

  return (
    <div className={styles.sectionContent}>

      {/* ── Neuro Sub-card ──────────────────────────────────────────── */}
      <div className={styles.subCard}>
        <h4 className={styles.subCardTitle}>Neurological</h4>

        {/* AVPU */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Mental Status (AVPU)</label>
          <div className={styles.toggleGroup}>
            {(['Alert', 'Voice', 'Pain', 'Unresponsive'] as const).map((level) => (
              <button
                key={level}
                type="button"
                className={`${styles.toggleBtn} ${styles.toggleBtnFull} ${data.mentalStatus === level ? styles.toggleBtnActive : ''}`}
                onClick={() => onChange('mentalStatus', data.mentalStatus === level ? '' : level)}
              >
                {level}
              </button>
            ))}
          </div>
        </div>

        {/* GCS */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>GCS Score — Trauma / Altered Mental Status (3–15)</label>
          <input
            type="number"
            className={`${styles.input} ${styles.inputNarrow}`}
            value={data.gcs}
            onChange={(e) => onChange('gcs', e.target.value)}
            min={3} max={15}
            placeholder="3–15"
          />
        </div>

        {/* Orientation AxO */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Orientation (select all that apply)</label>
          <div className={styles.toggleGroup}>
            {/* x0 (None) — mutually exclusive with all standard domains */}
            <button
              type="button"
              className={`${styles.toggleBtn} ${data.orientation.includes(ORIENTATION_NONE) ? styles.toggleBtnActive : ''}`}
              onClick={() => toggleOrientation(ORIENTATION_NONE)}
              style={{ borderColor: data.orientation.includes(ORIENTATION_NONE) ? '#ef4444' : undefined }}
            >
              x0 (None)
            </button>
            {ORIENTATION_OPTIONS.map((domain) => (
              <button
                key={domain}
                type="button"
                className={`${styles.toggleBtn} ${data.orientation.includes(domain) ? styles.toggleBtnActive : ''}`}
                onClick={() => toggleOrientation(domain)}
              >
                {domain}
              </button>
            ))}
          </div>
          {data.orientation.includes(ORIENTATION_NONE) && (
            <span className={styles.axoLabel}>AxO x0 — Not oriented</span>
          )}
          {!data.orientation.includes(ORIENTATION_NONE) && data.orientation.length > 0 && (
            <span className={styles.axoLabel}>
              AxO x{data.orientation.length} ({data.orientation.join(', ')})
            </span>
          )}
        </div>

        {/* Pupils */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Pupils</label>
          <input
            type="text"
            className={styles.input}
            value={data.pupils}
            onChange={(e) => onChange('pupils', e.target.value)}
            placeholder="e.g. PERRL 3mm, Pinpoint bilateral, Unequal L>R 4mm/2mm"
          />
        </div>

        {/* Motor / Speech — three inline selects */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Motor / Sensory / Speech</label>
          <div className={styles.vitalsRow3}>
            <div>
              <label className={styles.subLabel}>Left Strength</label>
              <select
                className={styles.select}
                value={data.motorLeft}
                onChange={(e) => onChange('motorLeft', e.target.value)}
              >
                <option value="">Left…</option>
                <option value="Equal">Equal</option>
                <option value="Weak">Weak</option>
                <option value="Absent">Absent</option>
              </select>
            </div>
            <div>
              <label className={styles.subLabel}>Right Strength</label>
              <select
                className={styles.select}
                value={data.motorRight}
                onChange={(e) => onChange('motorRight', e.target.value)}
              >
                <option value="">Right…</option>
                <option value="Equal">Equal</option>
                <option value="Weak">Weak</option>
                <option value="Absent">Absent</option>
              </select>
            </div>
            <div>
              <label className={styles.subLabel}>Speech</label>
              <select
                className={styles.select}
                value={data.speech}
                onChange={(e) => onChange('speech', e.target.value)}
              >
                <option value="">Speech…</option>
                <option value="Clear">Clear</option>
                <option value="Slurred">Slurred</option>
                <option value="Aphasic">Aphasic</option>
                <option value="Non-verbal">Non-verbal</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* ── Physical Sub-card ─────────────────────────────────────────── */}
      <div className={styles.subCard}>
        <h4 className={styles.subCardTitle}>Physical</h4>

        {/* Airway */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Airway</label>
          <div className={styles.toggleGroup}>
            {(['Patent', 'Obstructed', 'Managed'] as const).map((status) => (
              <button
                key={status}
                type="button"
                className={`${styles.toggleBtn} ${data.airway === status ? styles.toggleBtnActive : ''}`}
                onClick={() => onChange('airway', data.airway === status ? '' : status)}
              >
                {status}
              </button>
            ))}
          </div>
          {data.airway === 'Managed' && (
            <p className={styles.fieldHint}>Managed = intubated or supraglottic airway in place</p>
          )}
        </div>

        {/* Lung Sounds */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Lung Sounds</label>
          <MultiSelectChips
            options={LUNG_SOUNDS_OPTIONS}
            selected={data.lungSounds}
            onToggle={toggleLungSound}
            onAddCustom={addCustomLungSound}
            onRemove={removeLungSoundAt}
          />
        </div>

        {/* Skin */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Skin</label>
          <MultiSelectChips
            options={SKIN_OPTIONS}
            selected={data.skin}
            onToggle={toggleSkin}
            onAddCustom={addCustomSkin}
            onRemove={removeSkinAt}
          />
        </div>

        {/* Pertinent Negatives */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Pertinent Negatives</label>
          <FreeChipInput
            chips={data.pertinentNegatives}
            onAdd={addNegative}
            onRemove={removeNegative}
            placeholder="e.g. No chest pain, No LOC, No focal deficits, No ETOH…"
          />
        </div>
      </div>
    </div>
  );
}
