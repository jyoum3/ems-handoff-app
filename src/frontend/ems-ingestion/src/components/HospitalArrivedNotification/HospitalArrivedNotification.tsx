/**
 * HospitalArrivedNotification.tsx — Full-Screen Blocking Overlay
 * ================================================================
 * Phase 4 Sprint 3 — Triggered by SignalR emsHandoffUpdate
 * with action: "arrived_by_hospital".
 *
 * Prevents medic from interacting with the app until they confirm
 * or choose to restore the patient.
 */

import { useState } from 'react';
import type { FHIRBundle } from '../../types/fhir';
import { recoverHandoff } from '../../services/api';
import styles from './HospitalArrivedNotification.module.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPatientName(bundle: FHIRBundle): string {
  const patient = bundle.entry
    .map((e) => e.resource)
    .find((r) => r.resourceType === 'Patient') as
    | { resourceType: 'Patient'; name?: { family?: string; given?: string[] }[] }
    | undefined;
  if (!patient?.name?.[0]) return 'Unknown Patient';
  const n = patient.name[0];
  const family = n.family ?? '';
  const given = n.given?.[0] ?? '';
  if (family && given) return `${family.toUpperCase()}, ${given}`;
  return family || given || 'Unknown Patient';
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface HospitalArrivedNotificationProps {
  bundle: FHIRBundle;
  bundleId: string;
  hospitalId: string;
  onRestore: (restoredBundle: FHIRBundle) => void;
  onConfirmClear: () => void;
}

// ---------------------------------------------------------------------------
// HospitalArrivedNotification
// ---------------------------------------------------------------------------

export default function HospitalArrivedNotification({
  bundle,
  bundleId,
  hospitalId,
  onRestore,
  onConfirmClear,
}: HospitalArrivedNotificationProps) {
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');

  const patientName = getPatientName(bundle);

  const handleRestore = async () => {
    setRestoreError('');
    setIsRestoring(true);
    try {
      const restoredBundle = await recoverHandoff(bundleId, hospitalId);
      onRestore(restoredBundle);
    } catch {
      setRestoreError('Restore failed — please try again.');
      setIsRestoring(false);
    }
  };

  return (
    <div className={styles.overlay}>
      <div className={styles.card}>
        <div className={styles.icon}>⚠️</div>

        <h2 className={styles.title}>Patient Arrived by Hospital</h2>

        <p className={styles.body}>
          <strong style={{ color: '#f1f5f9' }}>{patientName}</strong> was marked as
          Arrived by the receiving team at{' '}
          <strong style={{ color: '#f1f5f9' }}>{hospitalId}</strong>. If this was
          done in error, you can restore them to the active queue.
        </p>

        {restoreError && (
          <div className={styles.error}>{restoreError}</div>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.restoreBtn}
            onClick={handleRestore}
            disabled={isRestoring}
          >
            {isRestoring ? '⏳ Restoring…' : '🔄 Restore Patient'}
          </button>

          <button
            type="button"
            className={styles.clearBtn}
            onClick={onConfirmClear}
            disabled={isRestoring}
          >
            Confirm &amp; Clear
          </button>
        </div>
      </div>
    </div>
  );
}
