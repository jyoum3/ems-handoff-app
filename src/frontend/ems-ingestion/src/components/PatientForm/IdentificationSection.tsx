/**
 * IdentificationSection.tsx — Section 1: Patient Identification & Alerts
 * ========================================================================
 * Phase 4 Sprint 2.5 — Replaces DemographicsSection.tsx
 *
 * Fields (in order):
 *   Unknown Patient checkbox (top)
 *   Identity grid: Last Name, First Name, DOB, Gender
 *   Code Status toggle group (Full Code / DNR / DNI / DNR/DNI)
 *   Alert Badges chip input
 *   Emergency Contact sub-card (Last Name, First Name, Phone, Relationship)
 */

import { useEffect, useRef } from 'react';
import type { PatientFormData } from '../../utils/fhirBuilder';
import styles from './PatientForm.module.css';

// ---------------------------------------------------------------------------
// Age calculator — used for live DOB display
// ---------------------------------------------------------------------------

function calcAge(birthDate: string): number | null {
  if (!birthDate || birthDate === '1880-01-01') return null;
  try {
    const dob = new Date(birthDate);
    if (isNaN(dob.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - dob.getFullYear();
    const m = now.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
    return age >= 0 && age < 130 ? age : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// ChipInput — reusable chip component
// ---------------------------------------------------------------------------

interface ChipInputProps {
  chips: string[];
  onAdd: (value: string) => void;
  onRemove: (index: number) => void;
  placeholder?: string;
  chipColor?: string;
}

function ChipInput({ chips, onAdd, onRemove, placeholder, chipColor }: ChipInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
      e.preventDefault();
      onAdd(input.value.trim());
      input.value = '';
    }
  };

  return (
    <div className={styles.chipInputWrapper}>
      <div className={styles.chipList}>
        {chips.map((chip, i) => (
          <span
            key={i}
            className={styles.chip}
            style={chipColor ? { background: chipColor, color: '#fff' } : undefined}
          >
            {chip}
            <button
              type="button"
              className={styles.chipRemove}
              onClick={() => onRemove(i)}
              aria-label={`Remove ${chip}`}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <input
        ref={inputRef}
        type="text"
        className={styles.chipTextInput}
        onKeyDown={handleKeyDown}
        placeholder={chips.length === 0 ? placeholder : 'Add more…'}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// IdentificationSection
// ---------------------------------------------------------------------------

interface IdentificationSectionProps {
  data: PatientFormData;
  onChange: (field: keyof PatientFormData, value: PatientFormData[keyof PatientFormData]) => void;
}

const CODE_STATUS_OPTIONS = ['Full Code', 'DNR', 'DNI', 'DNR/DNI'] as const;
const GENDER_OPTIONS = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'unknown', label: 'Unknown' },
  { value: 'other', label: 'Other' },
];

export default function IdentificationSection({ data, onChange }: IdentificationSectionProps) {
  // ── Unknown-patient toggle: skip initial mount so pre-populated edit values
  // are never wiped on first render. Only fire when the checkbox is actually
  // toggled by the user.
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return; // do NOT clear fields on mount — form data is already pre-populated
    }
    if (data.isUnknownPatient) {
      onChange('familyName', 'Unknown');
      onChange('givenName', 'Patient');
      onChange('birthDate', '1880-01-01');
      onChange('gender', 'unknown');
    } else {
      // Checkbox was unchecked by the user — clear the auto-filled placeholders
      onChange('familyName', '');
      onChange('givenName', '');
      onChange('birthDate', '');
    }
  }, [data.isUnknownPatient]); // eslint-disable-line react-hooks/exhaustive-deps

  const addAlertBadge = (value: string) => {
    onChange('alertBadges', [...data.alertBadges, value]);
  };

  const removeAlertBadge = (index: number) => {
    onChange('alertBadges', data.alertBadges.filter((_, i) => i !== index));
  };

  return (
    <div className={styles.sectionContent}>

      {/* ── Unknown Patient Toggle ──────────────────────────────────── */}
      <div className={styles.unknownPatientRow}>
        <label className={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={data.isUnknownPatient}
            onChange={(e) => onChange('isUnknownPatient', e.target.checked)}
            className={styles.checkbox}
          />
          <span className={styles.checkboxText}>
            <strong>Unknown / Unidentified Patient</strong>
            <span className={styles.checkboxHint}> — auto-fills name, DOB, and gender</span>
          </span>
        </label>
      </div>

      {/* ── Identity Grid (2-col) ────────────────────────────────────── */}
      <div className={`${styles.twoColGrid} ${data.isUnknownPatient ? styles.fieldDisabled : ''}`}>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Last Name</label>
          <input
            type="text"
            className={styles.input}
            value={data.familyName}
            onChange={(e) => onChange('familyName', e.target.value)}
            disabled={data.isUnknownPatient}
            placeholder="Last name"
          />
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>First Name</label>
          <input
            type="text"
            className={styles.input}
            value={data.givenName}
            onChange={(e) => onChange('givenName', e.target.value)}
            disabled={data.isUnknownPatient}
            placeholder="First name"
          />
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Date of Birth</label>
          {/* 3-dropdown DOB picker — avoids native date picker year-scroll UX issue on mobile/PWA.
              Year dropdown lists current year → 1920 in descending order for fast access to
              common patient birth years (1940–2000 are 20–85 steps from top, not 40+ scroll taps). */}
          {(() => {
            const currentYear = new Date().getFullYear();
            const MONTHS = [
              { v: '01', l: 'January' }, { v: '02', l: 'February' }, { v: '03', l: 'March' },
              { v: '04', l: 'April' }, { v: '05', l: 'May' }, { v: '06', l: 'June' },
              { v: '07', l: 'July' }, { v: '08', l: 'August' }, { v: '09', l: 'September' },
              { v: '10', l: 'October' }, { v: '11', l: 'November' }, { v: '12', l: 'December' },
            ];
            const raw = (!data.birthDate || data.birthDate === '1880-01-01') ? '' : data.birthDate;
            const parts = raw ? raw.split('-') : ['', '', ''];
            const dobY = parts[0] ?? '';
            const dobM = parts[1] ?? '';
            const dobD = parts[2] ?? '';
            const maxDay = (dobY && dobM)
              ? new Date(parseInt(dobY), parseInt(dobM), 0).getDate()
              : 31;

            const handlePart = (part: 'y' | 'm' | 'd', value: string) => {
              const y = part === 'y' ? value : dobY;
              const m = part === 'm' ? value : dobM;
              const d = part === 'd' ? value : dobD;
              if (y && m && d) {
                // Clamp day if new month/year has fewer days
                const clampedD = Math.min(parseInt(d), new Date(parseInt(y), parseInt(m), 0).getDate());
                onChange('birthDate', `${y}-${m.padStart(2, '0')}-${String(clampedD).padStart(2, '0')}`);
              } else {
                onChange('birthDate', '');
              }
            };

            const sel: React.CSSProperties = {
              flex: 1, padding: '7px 8px', fontSize: '13px',
              background: '#0f172a', color: data.isUnknownPatient ? '#475569' : '#f1f5f9',
              border: '1px solid #334155', borderRadius: '6px', outline: 'none',
            };

            return (
              <div style={{ display: 'flex', gap: '6px', opacity: data.isUnknownPatient ? 0.4 : 1 }}>
                <select style={sel} value={dobM} disabled={data.isUnknownPatient}
                  onChange={(e) => handlePart('m', e.target.value)}>
                  <option value="">Month</option>
                  {MONTHS.map(({ v, l }) => <option key={v} value={v}>{l}</option>)}
                </select>
                <select style={{ ...sel, maxWidth: '80px' }} value={dobD} disabled={data.isUnknownPatient}
                  onChange={(e) => handlePart('d', e.target.value)}>
                  <option value="">Day</option>
                  {Array.from({ length: maxDay }, (_, i) => String(i + 1).padStart(2, '0')).map((d) => (
                    <option key={d} value={d}>{parseInt(d)}</option>
                  ))}
                </select>
                <select style={{ ...sel, maxWidth: '90px' }} value={dobY} disabled={data.isUnknownPatient}
                  onChange={(e) => handlePart('y', e.target.value)}>
                  <option value="">Year</option>
                  {Array.from({ length: currentYear - 1919 }, (_, i) => currentYear - i).map((y) => (
                    <option key={y} value={String(y)}>{y}</option>
                  ))}
                </select>
              </div>
            );
          })()}
          {/* Live age auto-calculation */}
          {!data.isUnknownPatient && data.birthDate && data.birthDate !== '1880-01-01' && (() => {
            const age = calcAge(data.birthDate);
            return age !== null ? (
              <span style={{ fontSize: '12px', color: '#4ade80', fontWeight: 600, marginTop: '4px', display: 'block' }}>
                Age: {age} year{age !== 1 ? 's' : ''}
              </span>
            ) : null;
          })()}
        </div>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Gender</label>
          <select
            className={styles.select}
            value={data.gender}
            onChange={(e) => onChange('gender', e.target.value)}
          >
            <option value="">Select…</option>
            {GENDER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Code Status ─────────────────────────────────────────────── */}
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>Code Status</label>
        <div className={styles.toggleGroup}>
          {CODE_STATUS_OPTIONS.map((status) => (
            <button
              key={status}
              type="button"
              className={`${styles.toggleBtn} ${data.codeStatus === status ? styles.toggleBtnActive : ''}`}
              onClick={() => onChange('codeStatus', data.codeStatus === status ? '' : status)}
            >
              {status}
            </button>
          ))}
        </div>
      </div>

      {/* ── Alert Badges ─────────────────────────────────────────────── */}
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>Alert Badges</label>
        <ChipInput
          chips={data.alertBadges}
          onAdd={addAlertBadge}
          onRemove={removeAlertBadge}
          placeholder="e.g. STEMI, Stroke Alert, Trauma Activation, OB Patient…"
          chipColor="#F97316"
        />
      </div>

      {/* ── Emergency Contact Sub-card ───────────────────────────────── */}
      <div className={styles.subCard}>
        <h4 className={styles.subCardTitle}>Emergency Contact</h4>
        <div className={styles.twoColGrid}>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Last Name</label>
            <input
              type="text"
              className={styles.input}
              value={data.emergencyContactFamily}
              onChange={(e) => onChange('emergencyContactFamily', e.target.value)}
              placeholder="Contact last name"
            />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>First Name</label>
            <input
              type="text"
              className={styles.input}
              value={data.emergencyContactGiven}
              onChange={(e) => onChange('emergencyContactGiven', e.target.value)}
              placeholder="Contact first name"
            />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Phone</label>
            <input
              type="text"
              className={styles.input}
              value={data.emergencyContactPhone}
              onChange={(e) => onChange('emergencyContactPhone', e.target.value)}
              placeholder="XXX-XXX-XXXX"
              inputMode="tel"
            />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Relationship</label>
            <input
              type="text"
              className={styles.input}
              value={data.emergencyContactRelationship}
              onChange={(e) => onChange('emergencyContactRelationship', e.target.value)}
              placeholder="e.g. Wife, Son, Facility Staff"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
