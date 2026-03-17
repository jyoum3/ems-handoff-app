/**
 * VitalsSection.tsx — Section 3: Vital Signs
 * ============================================
 * Phase 4 Sprint 2.75 (revised) — ECG staging + pain score
 * Phase 4 Sprint 3 — Clock button + inline time picker on both sub-cards
 *
 * Clock Button UX:
 *   [🕐 Set Time] appears in both Initial Vitals and Current Vitals sub-card headers.
 *   Clicking opens an inline time picker row directly below the sub-card header:
 *     [🕐 Set to Now]   OR   [ datetime-local input ]  [Set]
 *   [Set to Now] → fills input with current datetime → closes picker
 *   [Set] → confirms and closes picker
 *   Selected time stored as `vitalInitialTime` / `vitalCurrentTime` in PatientFormData.
 *   Displayed as "Time: Mar 11 · 13:38" in muted slate text below header.
 *   Time travels with the bundle as an extension on the Observation entry.
 */

import { useState, useEffect } from 'react';
import type { EcgRecord } from '../../types/fhir';
import type { PatientFormData } from '../../utils/fhirBuilder';
import styles from './PatientForm.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface VitalsSectionProps {
  data: PatientFormData;
  onChange: (field: keyof PatientFormData, value: PatientFormData[keyof PatientFormData]) => void;
  stagedEcgFile: File | null;
  stagedEcgRhythm: string;
  onStagedEcgFileChange: (file: File | null) => void;
  onStagedEcgRhythmChange: (rhythm: string) => void;
  onDeleteEcg: (index: number) => void;
  ecgRecords: EcgRecord[];
  // Fix 5 — Sprint 3.1: when true, renders ONLY the Current Vitals sub-card.
  // Used by LiveHandoffView [✏️ Update Current Vitals] context — suppresses
  // Initial Vitals sub-card and ECG upload zone.
  currentOnlyMode?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BP_LOCATIONS    = ['Right Arm', 'Left Arm', 'Right Forearm', 'Left Forearm', 'Right Calf', 'Left Calf'];
const BP_ORIENTATIONS = ['Lying', 'Sitting', 'Standing'];
const SPO2_DEVICES    = ['Room Air', 'Nasal Cannula', 'Non-Rebreather', 'Bag-Valve-Mask', 'Ventilator', 'CPAP', 'BiPAP'];
const TEMP_LOCATIONS  = ['Oral', 'Axillary', 'Rectal', 'Tympanic', 'Temporal'];

// ---------------------------------------------------------------------------
// formatVitalTime — "Mar 11 · 13:38" from ISO datetime
// ---------------------------------------------------------------------------

function formatVitalTime(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const month = d.toLocaleString('en-US', { month: 'short' });
    const day = d.getDate();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${month} ${day} · ${hours}:${minutes}`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// InlineTimePicker — clock button + collapsible picker row
// ---------------------------------------------------------------------------

interface InlineTimePickerProps {
  value: string;              // ISO datetime string (vitalInitialTime / vitalCurrentTime)
  onChange: (iso: string) => void;
}

function InlineTimePicker({ value, onChange }: InlineTimePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputVal, setInputVal] = useState('');

  // Sync inputVal when picker opens
  const open = () => {
    setInputVal(value ? toDatetimeLocal(value) : '');
    setIsOpen(true);
  };

  const close = () => setIsOpen(false);

  const handleSetNow = () => {
    const nowIso = new Date().toISOString();
    const nowLocal = toDatetimeLocal(nowIso);
    setInputVal(nowLocal);
    onChange(new Date(nowLocal).toISOString());
    close();
  };

  const handleSet = () => {
    if (inputVal) {
      onChange(new Date(inputVal).toISOString());
    }
    close();
  };

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: '4px' }}>
      {/* Button + timestamp display */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {value && (
          <span style={{ fontSize: '11px', color: '#64748b' }}>
            Time: {formatVitalTime(value)}
          </span>
        )}
        <button
          type="button"
          onClick={isOpen ? close : open}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            padding: '3px 8px', borderRadius: '5px', cursor: 'pointer',
            background: value ? 'rgba(249,115,22,0.12)' : 'rgba(51,65,85,0.5)',
            border: `1px solid ${value ? '#F97316' : '#475569'}`,
            color: value ? '#fb923c' : '#94a3b8',
            fontSize: '12px', fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
          title={isOpen ? 'Close time picker' : 'Set vitals time'}
        >
          🕐 {value ? 'Change Time' : 'Set Time'}
        </button>
      </div>

      {/* Inline picker — slides in below button row */}
      {isOpen && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
          padding: '8px 10px', borderRadius: '6px',
          background: '#0f172a', border: '1px solid #334155',
        }}>
          <button
            type="button"
            onClick={handleSetNow}
            style={{
              padding: '4px 10px', borderRadius: '5px', cursor: 'pointer',
              background: '#F97316', border: 'none',
              color: '#fff', fontSize: '12px', fontWeight: 700, whiteSpace: 'nowrap',
            }}
          >
            🕐 Set to Now
          </button>
          <span style={{ color: '#475569', fontSize: '12px' }}>or</span>
          <input
            type="datetime-local"
            value={inputVal}
            onChange={e => setInputVal(e.target.value)}
            style={{
              padding: '4px 8px', borderRadius: '5px', border: '1px solid #334155',
              background: '#1e293b', color: '#f1f5f9', fontSize: '12px',
            }}
          />
          <button
            type="button"
            onClick={handleSet}
            disabled={!inputVal}
            style={{
              padding: '4px 10px', borderRadius: '5px', cursor: inputVal ? 'pointer' : 'not-allowed',
              background: inputVal ? '#1e293b' : 'rgba(30,41,59,0.4)',
              border: '1px solid #475569',
              color: inputVal ? '#f1f5f9' : '#475569', fontSize: '12px', fontWeight: 600,
            }}
          >
            Set
          </button>
          {value && (
            <button
              type="button"
              onClick={() => { onChange(''); close(); }}
              style={{
                padding: '4px 8px', borderRadius: '5px', cursor: 'pointer',
                background: 'none', border: '1px solid #475569',
                color: '#64748b', fontSize: '11px',
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Convert ISO string to datetime-local value format ("YYYY-MM-DDTHH:MM") */
function toDatetimeLocal(iso: string): string {
  try {
    const d = new Date(iso);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dy = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${mo}-${dy}T${h}:${m}`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// VitalsGrid — shared layout for initial and current vitals
// ---------------------------------------------------------------------------

interface VitalsGridProps {
  prefix: 'Initial' | 'Current';
  data: PatientFormData;
  onChange: (field: keyof PatientFormData, value: PatientFormData[keyof PatientFormData]) => void;
  showHeightWeight?: boolean;
}

function VitalsGrid({ prefix, data, onChange, showHeightWeight }: VitalsGridProps) {
  const p = prefix === 'Initial' ? 'Initial' : 'Current';

  const hrKey      = `hr${p}`       as keyof PatientFormData;
  const bpKey      = `bp${p}`       as keyof PatientFormData;
  const bpLocKey   = `bpLocation${p}` as keyof PatientFormData;
  const bpOriKey   = `bpOrientation${p}` as keyof PatientFormData;
  const rrKey      = `rr${p}`       as keyof PatientFormData;
  const spo2Key    = `spo2${p}`     as keyof PatientFormData;
  const spo2DevKey = `spo2Device${p}` as keyof PatientFormData;
  const spo2FrKey  = `spo2FlowRate${p}` as keyof PatientFormData;
  const tempKey    = `temp${p}`     as keyof PatientFormData;
  const tempLocKey = `tempLocation${p}` as keyof PatientFormData;
  const sugarKey   = `sugar${p}`    as keyof PatientFormData;

  return (
    <div className={styles.vitalsGrid}>
      {/* HR */}
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>HR (bpm)</label>
        <input type="number" className={styles.input}
          value={data[hrKey] as string}
          onChange={e => onChange(hrKey, e.target.value)}
          placeholder="60–100" min="0" />
      </div>

      {/* BP row */}
      <div className={`${styles.fieldGroup} ${styles.spanFull}`}>
        <label className={styles.fieldLabel}>Blood Pressure</label>
        <div className={styles.vitalsRow3}>
          <div>
            <label className={styles.subLabel}>mmHg</label>
            <input type="text" className={styles.input}
              value={data[bpKey] as string}
              onChange={e => onChange(bpKey, e.target.value)}
              placeholder="120/80" />
          </div>
          <div>
            <label className={styles.subLabel}>Location</label>
            <select className={styles.select}
              value={data[bpLocKey] as string}
              onChange={e => onChange(bpLocKey, e.target.value)}>
              <option value="">Location…</option>
              {BP_LOCATIONS.map(loc => <option key={loc} value={loc}>{loc}</option>)}
            </select>
          </div>
          <div>
            <label className={styles.subLabel}>Position</label>
            <select className={styles.select}
              value={data[bpOriKey] as string}
              onChange={e => onChange(bpOriKey, e.target.value)}>
              <option value="">Position…</option>
              {BP_ORIENTATIONS.map(ori => <option key={ori} value={ori}>{ori}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* RR */}
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>RR (breaths/min)</label>
        <input type="number" className={styles.input}
          value={data[rrKey] as string}
          onChange={e => onChange(rrKey, e.target.value)}
          placeholder="12–20" min="0" />
      </div>

      {/* SpO2 row */}
      <div className={`${styles.fieldGroup} ${styles.spanFull}`}>
        <label className={styles.fieldLabel}>SpO2</label>
        <div className={styles.vitalsRow3}>
          <div>
            <label className={styles.subLabel}>%</label>
            <input type="number" className={styles.input}
              value={data[spo2Key] as string}
              onChange={e => onChange(spo2Key, e.target.value)}
              placeholder="95–100" min="0" max="100" />
          </div>
          <div>
            <label className={styles.subLabel}>Device</label>
            <select className={styles.select}
              value={data[spo2DevKey] as string}
              onChange={e => onChange(spo2DevKey, e.target.value)}>
              <option value="">Device…</option>
              {SPO2_DEVICES.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label className={styles.subLabel}>Flow Rate (L/min)</label>
            <input type="number" className={styles.input}
              value={data[spo2FrKey] as string}
              onChange={e => onChange(spo2FrKey, e.target.value)}
              placeholder="0–16" min="0" max="16" />
          </div>
        </div>
      </div>

      {/* Temp row */}
      <div className={`${styles.fieldGroup} ${styles.spanFull}`}>
        <label className={styles.fieldLabel}>Temperature</label>
        <div className={styles.vitalsRow2}>
          <div>
            <label className={styles.subLabel}>°F</label>
            <input type="number" className={styles.input}
              value={data[tempKey] as string}
              onChange={e => onChange(tempKey, e.target.value)}
              placeholder="97–99.5" step="0.1" />
          </div>
          <div>
            <label className={styles.subLabel}>Location</label>
            <select className={styles.select}
              value={data[tempLocKey] as string}
              onChange={e => onChange(tempLocKey, e.target.value)}>
              <option value="">Location…</option>
              {TEMP_LOCATIONS.map(loc => <option key={loc} value={loc}>{loc}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Blood Sugar */}
      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>Blood Sugar (mg/dL)</label>
        <input type="number" className={styles.input}
          value={data[sugarKey] as string}
          onChange={e => onChange(sugarKey, e.target.value)}
          placeholder="70–180" min="0" />
      </div>

      {/* Height + Weight — prefix-aware (Fix 6) */}
      {showHeightWeight && (
        <div className={`${styles.fieldGroup} ${styles.spanFull}`}>
          <label className={styles.fieldLabel}>Estimated Size</label>
          <div className={styles.vitalsRow2}>
            <div>
              <label className={styles.subLabel}>Height (in)</label>
              <input type="number" className={styles.input}
                value={prefix === 'Initial' ? data.height : (data.heightCurrent ?? '')}
                onChange={e => onChange(prefix === 'Initial' ? 'height' : 'heightCurrent', e.target.value)}
                placeholder="e.g. 68" min="0" />
            </div>
            <div>
              <label className={styles.subLabel}>Weight (lbs)</label>
              <input type="number" className={styles.input}
                value={prefix === 'Initial' ? data.weight : (data.weightCurrent ?? '')}
                onChange={e => onChange(prefix === 'Initial' ? 'weight' : 'weightCurrent', e.target.value)}
                placeholder="e.g. 165" min="0" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// VitalsSection
// ---------------------------------------------------------------------------

export default function VitalsSection({
  data,
  onChange,
  stagedEcgFile,
  stagedEcgRhythm,
  onStagedEcgFileChange,
  onStagedEcgRhythmChange,
  onDeleteEcg,
  ecgRecords,
  currentOnlyMode = false,
}: VitalsSectionProps) {
  const [currentOpen, setCurrentOpen] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState('');

  // Local object URL for staged file — created/revoked automatically
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!stagedEcgFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(stagedEcgFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [stagedEcgFile]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) onStagedEcgFileChange(file);
  };

  const openLightbox = (src: string) => {
    setLightboxSrc(src);
    setLightboxOpen(true);
  };

  const ecgZoneState: 'uploaded' | 'staged' | 'empty' =
    ecgRecords.length > 0 ? 'uploaded' :
    stagedEcgFile !== null ? 'staged' :
    'empty';

  const uploadedRecord = ecgRecords.length > 0 ? ecgRecords[ecgRecords.length - 1] : null;

  // ── Pain score block helper — reusable for Initial and Current ────────────
  const renderPainScore = (
    fieldKey: 'painInitial' | 'painCurrent',
    defaultSetValue: string,
  ) => {
    const val = data[fieldKey] as string;
    return (
      <div className={styles.fieldGroup} style={{ marginTop: '12px' }}>
        <label className={styles.fieldLabel}>
          Pain Score (NRS 0–10)
          <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '8px' }}>(default: N/A)</span>
        </label>
        {val === '' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center',
              padding: '4px 12px', borderRadius: '6px',
              background: 'rgba(100,116,139,0.2)', border: '1px solid #475569',
              color: '#94a3b8', fontSize: '13px', fontWeight: 600,
            }}>N/A</span>
            <button
              type="button"
              onClick={() => onChange(fieldKey, defaultSetValue)}
              style={{
                padding: '4px 10px', borderRadius: '6px', cursor: 'pointer',
                background: 'rgba(51,65,85,0.5)', border: '1px solid #475569',
                color: '#e2e8f0', fontSize: '12px', fontWeight: 500,
              }}
            >Set Score</button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <input
              type="range" min={0} max={10} step={1}
              value={val}
              onChange={e => onChange(fieldKey, e.target.value)}
              style={{ flex: 1 }}
            />
            <span style={{ minWidth: '30px', textAlign: 'center', color: '#f1f5f9', fontWeight: 700, fontSize: '16px' }}>
              {val}
            </span>
            <button
              type="button"
              onClick={() => onChange(fieldKey, '')}
              title="Set to N/A"
              style={{
                padding: '3px 8px', borderRadius: '5px', cursor: 'pointer',
                background: 'rgba(51,65,85,0.5)', border: '1px solid #475569',
                color: '#64748b', fontSize: '11px',
              }}
            >N/A</button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={styles.sectionContent}>

      {/* ── Initial Vitals Sub-card — suppressed in currentOnlyMode ─── */}
      {!currentOnlyMode && (
        <div className={styles.subCard}>
          {/* Sub-card header with clock button */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
            <h4 className={styles.subCardTitle} style={{ margin: 0 }}>Initial Vitals</h4>
            <InlineTimePicker
              value={data.vitalInitialTime}
              onChange={(iso) => onChange('vitalInitialTime', iso)}
            />
          </div>
          <VitalsGrid prefix="Initial" data={data} onChange={onChange} showHeightWeight />
          {renderPainScore('painInitial', '5')}
        </div>
      )}

      {/* ── Current Vitals Sub-card ──────────────────────────────────── */}
      {/* In currentOnlyMode: always expanded, with height/weight/pain.  */}
      {/* In normal mode: collapsible, no height/weight/pain.            */}
      {currentOnlyMode ? (
        <div className={styles.subCard}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
            <h4 className={styles.subCardTitle} style={{ margin: 0 }}>Update Current Vitals</h4>
            <InlineTimePicker
              value={data.vitalCurrentTime}
              onChange={(iso) => onChange('vitalCurrentTime', iso)}
            />
          </div>
          <VitalsGrid prefix="Current" data={data} onChange={onChange} showHeightWeight />
          {renderPainScore('painCurrent', '5')}
        </div>
      ) : (
        <div className={styles.subCard}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
            <button type="button" className={styles.subCardHeader}
              onClick={() => setCurrentOpen(!currentOpen)}
              style={{ flex: 1, textAlign: 'left' }}>
              <span>Current Vitals</span>
              <span className={styles.subCardHint}>(Add when conditions change)</span>
              <span className={`${styles.chevron} ${currentOpen ? styles.chevronOpen : ''}`}>▾</span>
            </button>
            {currentOpen && (
              <InlineTimePicker
                value={data.vitalCurrentTime}
                onChange={(iso) => onChange('vitalCurrentTime', iso)}
              />
            )}
          </div>
          {currentOpen && (
            <VitalsGrid prefix="Current" data={data} onChange={onChange} showHeightWeight={false} />
          )}
        </div>
      )}

      {/* ── ECG Upload Sub-card — suppressed in currentOnlyMode ─────── */}
      {!currentOnlyMode && <div className={styles.subCard}>
        <h4 className={styles.subCardTitle}>
          12-Lead ECG
          {ecgRecords.length > 0 && (
            <span style={{
              marginLeft: '10px', fontSize: '11px', fontWeight: 600,
              padding: '2px 8px', borderRadius: '10px',
              background: 'rgba(249,115,22,0.15)', border: '1px solid #F97316', color: '#fb923c',
            }}>
              {ecgRecords.length === 1 ? '1 ECG on file' : `${ecgRecords.length} ECGs on file`}
            </span>
          )}
          {stagedEcgFile && ecgRecords.length === 0 && (
            <span style={{
              marginLeft: '10px', fontSize: '11px', fontWeight: 600,
              padding: '2px 8px', borderRadius: '10px',
              background: 'rgba(234,179,8,0.12)', border: '1px solid #ca8a04', color: '#fde047',
            }}>
              Staged — uploads on Submit
            </span>
          )}
        </h4>

        {/* ── STATE: UPLOADED — show blob thumbnail + delete ── */}
        {ecgZoneState === 'uploaded' && uploadedRecord && (
          <div>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
              <button
                type="button"
                onClick={() => openLightbox(uploadedRecord.url)}
                style={{
                  background: 'none', border: '1px solid #334155', borderRadius: '6px',
                  padding: 0, cursor: 'pointer', overflow: 'hidden',
                  width: '96px', height: '72px', flexShrink: 0,
                }}
                title="Click to view full size"
              >
                <img
                  src={uploadedRecord.url}
                  alt="ECG thumbnail"
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: '#fb923c', marginBottom: '2px' }}>
                  {uploadedRecord.label}
                </div>
                <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '4px' }}>
                  {new Date(uploadedRecord.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                </div>
                {uploadedRecord.rhythmInterpretation && (
                  <div style={{ fontSize: '12px', color: '#cbd5e1', marginBottom: '6px' }}>
                    {uploadedRecord.rhythmInterpretation}
                  </div>
                )}
                <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '8px' }}>
                  Click image to view full size
                </div>
                <button
                  type="button"
                  onClick={() => onDeleteEcg(ecgRecords.length - 1)}
                  style={{
                    fontSize: '11px', padding: '3px 10px', borderRadius: '5px',
                    background: 'rgba(239,68,68,0.12)', border: '1px solid #ef4444',
                    color: '#f87171', cursor: 'pointer', fontWeight: 600,
                  }}
                >
                  🗑 Remove ECG
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── STATE: STAGED — local preview + delete + rhythm note ── */}
        {ecgZoneState === 'staged' && previewUrl && (
          <div>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', marginBottom: '10px' }}>
              <button
                type="button"
                onClick={() => openLightbox(previewUrl)}
                style={{
                  background: 'none', border: '1px solid #ca8a04', borderRadius: '6px',
                  padding: 0, cursor: 'pointer', overflow: 'hidden',
                  width: '96px', height: '72px', flexShrink: 0,
                }}
                title="Click to view full size"
              >
                <img
                  src={previewUrl}
                  alt="ECG preview"
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: '#fde047', marginBottom: '2px' }}>
                  Staged — will be labeled "Initial" on Submit
                </div>
                <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '6px' }}>
                  {stagedEcgFile?.name}
                </div>
                <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '8px' }}>
                  Click image to preview full size
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onStagedEcgFileChange(null);
                    onStagedEcgRhythmChange('');
                  }}
                  style={{
                    fontSize: '11px', padding: '3px 10px', borderRadius: '5px',
                    background: 'rgba(239,68,68,0.12)', border: '1px solid #ef4444',
                    color: '#f87171', cursor: 'pointer', fontWeight: 600,
                  }}
                >
                  🗑 Remove
                </button>
              </div>
            </div>
            <input
              type="text"
              className={styles.input}
              placeholder="Rhythm interpretation (e.g. Normal Sinus, ST Elevation V1-V4)"
              value={stagedEcgRhythm}
              onChange={e => onStagedEcgRhythmChange(e.target.value)}
            />
          </div>
        )}

        {/* ── STATE: EMPTY — show upload zone ── */}
        {ecgZoneState === 'empty' && (
          <label
            className={styles.ecgZone}
            style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column',
              alignItems: 'center', gap: '6px' }}
          >
            <input
              type="file"
              accept="image/jpeg,image/png,application/pdf"
              style={{ display: 'none' }}
              onChange={handleFileSelect}
            />
            <span className={styles.ecgIcon}>📷</span>
            <span style={{ fontSize: '13px', color: '#94a3b8' }}>Tap to select ECG photo</span>
            <span style={{ fontSize: '11px', color: '#475569' }}>JPEG · PNG · PDF — max 10 MB</span>
          </label>
        )}
      </div>}

      {/* ── Lightbox Overlay ─────────────────────────────────────────── */}
      {lightboxOpen && (
        <div
          onClick={() => setLightboxOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.92)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <button
            type="button"
            onClick={() => setLightboxOpen(false)}
            style={{
              position: 'absolute', top: '16px', right: '20px',
              background: 'none', border: 'none', color: '#f1f5f9',
              fontSize: '24px', cursor: 'pointer', lineHeight: 1,
            }}
            aria-label="Close lightbox"
          >✕</button>
          <img
            src={lightboxSrc}
            alt="ECG full view"
            onClick={e => e.stopPropagation()}
            style={{
              maxWidth: '92vw', maxHeight: '88vh',
              objectFit: 'contain', borderRadius: '8px',
              border: '1px solid #334155',
            }}
          />
        </div>
      )}
    </div>
  );
}
