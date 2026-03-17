/**
 * DivertModal.tsx — Hospital Diversion Modal
 * ============================================
 * Phase 4 Sprint 3 — Two-step confirm diversion flow.
 *
 * Step 1: Select new hospital + optional ETA → click [🔀 Divert Patient]
 * Step 2: Warning highlights orange + button reads "Confirm Diversion" → click
 * On success: calls onDiverted(updatedBundle)
 */

import { useState } from 'react';
import type { FHIRBundle, HospitalId } from '../../types/fhir';
import { divertHandoff } from '../../services/api';
import styles from './DivertModal.module.css';

// ---------------------------------------------------------------------------
// Hospital options
// ---------------------------------------------------------------------------

const ALL_HOSPITALS: { value: HospitalId; label: string }[] = [
  { value: 'HUP-PAV',    label: 'HUP — Pavilion' },
  { value: 'HUP-PRESBY', label: 'HUP — Presbyterian' },
  { value: 'HUP-CEDAR',  label: 'HUP — Cedar' },
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DivertModalProps {
  currentHospitalId: string;
  bundleId: string;
  onDiverted: (newBundle: FHIRBundle) => void;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// DivertModal
// ---------------------------------------------------------------------------

export default function DivertModal({
  currentHospitalId,
  bundleId,
  onDiverted,
  onClose,
}: DivertModalProps) {
  const otherHospitals = ALL_HOSPITALS.filter((h) => h.value !== currentHospitalId);

  const [newHospitalId, setNewHospitalId] = useState<string>(otherHospitals[0]?.value ?? '');
  const [newEta, setNewEta] = useState('');
  const [confirmStep, setConfirmStep] = useState(false);
  const [isDiverting, setIsDiverting] = useState(false);
  const [divertError, setDivertError] = useState('');

  const handlePrimaryClick = async () => {
    if (!newHospitalId) return;

    if (!confirmStep) {
      setConfirmStep(true);
      return;
    }

    // Step 2 — Execute diversion
    setDivertError('');
    setIsDiverting(true);
    try {
      const updatedBundle = await divertHandoff(
        bundleId,
        currentHospitalId,
        newHospitalId,
        newEta || undefined,
      );
      onDiverted(updatedBundle);
    } catch {
      setDivertError('Diversion failed — please try again.');
      setIsDiverting(false);
      setConfirmStep(false);
    }
  };

  const handleClose = () => {
    if (!isDiverting) onClose();
  };

  return (
    <div className={styles.overlay} onClick={handleClose}>
      {/* Invert datetime-local calendar picker icon for dark background + bigger icon */}
      <style>{`
        input[type="datetime-local"]::-webkit-calendar-picker-indicator {
          filter: invert(1);
          opacity: 0.85;
          cursor: pointer;
          width: 18px;
          height: 18px;
        }
      `}</style>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={styles.header}>
          <h2 className={styles.title}>🔀 Divert Patient</h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={handleClose}
            disabled={isDiverting}
            aria-label="Close"
          >✕</button>
        </div>

        {/* Current Hospital (read-only) */}
        <div className={styles.fieldGroup}>
          <label className={styles.label}>Current Hospital</label>
          <div className={styles.readOnly}>{currentHospitalId}</div>
        </div>

        {/* New Hospital selector */}
        <div className={styles.fieldGroup}>
          <label className={styles.label}>New Destination Hospital <span className={styles.req}>*</span></label>
          <select
            className={styles.select}
            value={newHospitalId}
            onChange={(e) => { setNewHospitalId(e.target.value); setConfirmStep(false); }}
            disabled={isDiverting}
          >
            {otherHospitals.map((h) => (
              <option key={h.value} value={h.value}>{h.label}</option>
            ))}
          </select>
        </div>

        {/* Updated ETA (optional) */}
        <div className={styles.fieldGroup}>
          <label className={styles.label}>Updated ETA <span className={styles.optional}>(optional)</span></label>
          <input
            type="datetime-local"
            value={newEta}
            onChange={(e) => { setNewEta(e.target.value); setConfirmStep(false); }}
            disabled={isDiverting}
            className={styles.input}
          />
        </div>

        {/* Warning block */}
        <div
          className={styles.warning}
          style={{
            borderColor: confirmStep ? '#F97316' : '#ca8a04',
            background: confirmStep ? 'rgba(249,115,22,0.10)' : 'rgba(234,179,8,0.08)',
          }}
        >
          <span className={styles.warningIcon}>⚠️</span>
          <p className={styles.warningText}>
            This will <strong>immediately notify both hospitals.</strong> The current
            hospital's team will see this patient removed from their live queue.
            {newHospitalId && (
              <> The new destination will be <strong>{newHospitalId}</strong>.</>
            )}
          </p>
        </div>

        {divertError && (
          <div className={styles.errorText}>{divertError}</div>
        )}

        {/* Actions */}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.cancelBtn}
            onClick={handleClose}
            disabled={isDiverting}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.primaryBtn}
            style={{
              background: confirmStep ? '#F97316' : '#374151',
              borderColor: confirmStep ? '#F97316' : '#475569',
            }}
            onClick={handlePrimaryClick}
            disabled={!newHospitalId || isDiverting}
          >
            {isDiverting
              ? '⏳ Diverting…'
              : confirmStep
              ? '✅ Confirm Diversion'
              : '🔀 Divert Patient'}
          </button>
        </div>
      </div>
    </div>
  );
}
