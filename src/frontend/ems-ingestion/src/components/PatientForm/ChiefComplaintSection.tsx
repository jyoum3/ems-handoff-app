/**
 * ChiefComplaintSection.tsx — Section 2: Chief Complaint & Timeline
 * ==================================================================
 * Phase 4 Sprint 2.5 — Replaces TriageSection.tsx (Scene Safety removed)
 *
 * Fields:
 *   Chief Complaint (textarea, 2 rows)
 *   ESI Level (select)
 *   Triage Note (textarea, 6 rows) — with HPI/Assessment/Intervention template
 *     and real-time abnormal vitals injection via getAbnormalVitals()
 *   Timeline sub-card:
 *     Last Known Well, Onset/Injury Time, EMS Contact Time (+🕐 button), Arrival ETA
 */

import { useEffect, useRef } from 'react';
import type { PatientFormData } from '../../utils/fhirBuilder';
import { getAbnormalVitals } from '../../utils/fhirBuilder';
import styles from './PatientForm.module.css';

const ESI_OPTIONS = [
  'ESI-1 (CRITICAL)',
  'ESI-2 (EMERGENT)',
  'ESI-3 (URGENT)',
  'ESI-4 (LESS URGENT)',
  'ESI-5 (MINOR)',
];

const TRIAGE_TEMPLATE = `HPI: \n\nClinical Findings/Assessment: \n[ABNORMAL_VITALS_PLACEHOLDER]\n`;

interface ChiefComplaintSectionProps {
  data: PatientFormData;
  onChange: (field: keyof PatientFormData, value: PatientFormData[keyof PatientFormData]) => void;
}

// Format a Date for datetime-local input (YYYY-MM-DDTHH:MM)
function toDatetimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Helper: is a timeline field set to a real datetime (not 'Unknown' and not empty)?
function isDateSet(val: string) { return val && val !== 'Unknown'; }

export default function ChiefComplaintSection({ data, onChange }: ChiefComplaintSectionProps) {
  const templateInitializedRef = useRef(false);

  // Pre-populate triage note template on first mount if empty
  useEffect(() => {
    if (!templateInitializedRef.current && !data.triageNote.trim()) {
      templateInitializedRef.current = true;
      onChange('triageNote', TRIAGE_TEMPLATE);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reactive: update the ABNORMAL_VITALS_PLACEHOLDER when vitals change
  // We only inject if the note still contains the placeholder token
  const abnormalVitals = getAbnormalVitals(data);
  const displayNote = data.triageNote.includes('[ABNORMAL_VITALS_PLACEHOLDER]')
    ? data.triageNote.replace('[ABNORMAL_VITALS_PLACEHOLDER]', abnormalVitals || '')
    : data.triageNote;

  const handleTriageNoteChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    // If the placeholder is still present, keep it — let builder handle replacement at submit.
    // If the medic deleted it, store raw text.
    onChange('triageNote', e.target.value);
  };

  const handleEmsContactNow = () => {
    onChange('emsContactTime', toDatetimeLocal(new Date()));
  };

  // Multi-select encounter type toggle
  const toggleEncounterType = (type: string) => {
    const current = data.encounterTypes;
    onChange('encounterTypes', current.includes(type)
      ? current.filter((t) => t !== type)
      : [...current, type]);
  };

  return (
    <div className={styles.sectionContent}>

      {/* Calendar icon: white (inverted) + slightly larger for dark theme */}
      <style>{`
        input[type="datetime-local"]::-webkit-calendar-picker-indicator {
          filter: invert(1);
          cursor: pointer;
          width: 18px;
          height: 18px;
          opacity: 0.85;
        }
      `}</style>

      {/* Encounter Type — multi-select, drives team activation pathway (Phase 4 Sprint 2.75) */}
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>
          Encounter Type
          <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '8px' }}>(select all that apply)</span>
        </label>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {(['Medical', 'Trauma', 'Behavioral', 'OB-GYN', 'Pediatric'] as const).map((type) => {
            const active = data.encounterTypes.includes(type);
            return (
              <button
                key={type}
                type="button"
                onClick={() => toggleEncounterType(type)}
                style={{
                  padding: '6px 14px',
                  borderRadius: '8px',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: '1px solid',
                  transition: 'all 0.15s ease',
                  borderColor: active ? '#F97316' : '#334155',
                  background: active ? 'rgba(249,115,22,0.2)' : 'rgba(51,65,85,0.4)',
                  color: active ? '#fb923c' : '#94a3b8',
                }}
              >
                {type}
              </button>
            );
          })}
        </div>
      </div>

      {/* Chief Complaint */}
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>Chief Complaint</label>
        <textarea
          className={styles.textarea}
          rows={2}
          value={data.chiefComplaint}
          onChange={(e) => onChange('chiefComplaint', e.target.value)}
          placeholder="Primary reason for EMS activation…"
        />
      </div>

      {/* ESI Level */}
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>ESI Level</label>
        <select
          className={styles.select}
          value={data.esiLevel}
          onChange={(e) => onChange('esiLevel', e.target.value)}
        >
          <option value="">Select ESI level…</option>
          {ESI_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </div>

      {/* Triage Note — shows placeholder replaced in display but stores raw */}
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>
          Triage Note
          {abnormalVitals && (
            <span className={styles.abnormalTag}> ⚠ Abnormal vitals detected</span>
          )}
        </label>
        <textarea
          className={styles.textarea}
          rows={7}
          value={displayNote}
          onChange={handleTriageNoteChange}
          placeholder="HPI / Clinical Findings / Interventions…"
        />
      </div>

      {/* Timeline Sub-card */}
      <div className={styles.subCard}>
        <h4 className={styles.subCardTitle}>Timeline</h4>
        <div className={styles.twoColGrid}>

          {/* Last Known Well — defaults to Unknown; medic sets specific time if known */}
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Last Known Well</label>
            {isDateSet(data.lastKnownWell) ? (
              <div className={styles.inputWithButton}>
                <input
                  type="datetime-local"
                  value={data.lastKnownWell}
                  onChange={(e) => onChange('lastKnownWell', e.target.value)}
                  className={styles.input}
                />
                <button type="button" className={styles.timestampBtn}
                  onClick={() => onChange('lastKnownWell', 'Unknown')}
                  title="Set to Unknown"
                  style={{ color: '#fff', borderColor: '#fff', fontSize: '11px' }}>
                  ?
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center',
                  padding: '4px 10px', borderRadius: '6px',
                  background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.4)',
                  color: '#fbbf24', fontSize: '13px', fontWeight: 600,
                }}>Unknown</span>
                <button type="button"
                  onClick={() => onChange('lastKnownWell', toDatetimeLocal(new Date()))}
                  style={{
                    padding: '4px 10px', borderRadius: '6px', cursor: 'pointer',
                    background: 'rgba(51,65,85,0.5)', border: '1px solid #475569',
                    color: '#e2e8f0', fontSize: '12px', fontWeight: 500,
                  }}>Set Time</button>
              </div>
            )}
          </div>

          {/* Onset / Injury Time — defaults to Unknown; medic sets specific time if known */}
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Onset / Injury Time</label>
            {isDateSet(data.onsetTime) ? (
              <div className={styles.inputWithButton}>
                <input
                  type="datetime-local"
                  value={data.onsetTime}
                  onChange={(e) => onChange('onsetTime', e.target.value)}
                  className={styles.input}
                />
                <button type="button" className={styles.timestampBtn}
                  onClick={() => onChange('onsetTime', 'Unknown')}
                  title="Set to Unknown"
                  style={{ color: '#fff', borderColor: '#fff', fontSize: '11px' }}>
                  ?
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center',
                  padding: '4px 10px', borderRadius: '6px',
                  background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.4)',
                  color: '#fbbf24', fontSize: '13px', fontWeight: 600,
                }}>Unknown</span>
                <button type="button"
                  onClick={() => onChange('onsetTime', toDatetimeLocal(new Date()))}
                  style={{
                    padding: '4px 10px', borderRadius: '6px', cursor: 'pointer',
                    background: 'rgba(51,65,85,0.5)', border: '1px solid #475569',
                    color: '#e2e8f0', fontSize: '12px', fontWeight: 500,
                  }}>Set Time</button>
              </div>
            )}
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>EMS Contact Time</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <input
                type="datetime-local"
                value={data.emsContactTime}
                onChange={(e) => onChange('emsContactTime', e.target.value)}
                className={styles.input}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className={styles.timestampBtn}
                onClick={handleEmsContactNow}
                title="Insert current time"
              >
                🕐
              </button>
            </div>
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Arrival ETA</label>
            <input
              type="datetime-local"
              value={data.arrivalEta}
              onChange={(e) => onChange('arrivalEta', e.target.value)}
              className={styles.input}
            />
          </div>

        </div>
      </div>
    </div>
  );
}
