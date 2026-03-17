/**
 * ShiftCheckIn.tsx — EMS Ingestion PWA: Shift Start Verification Overlay
 * ========================================================================
 * Phase 4 Sprint 2.5: Added Unit Type (ALS/BLS) radio toggle between
 * Unit Number and Direct Phone. All four fields required before submit.
 *
 * FIELDS (in order):
 *   1. Medic Name    — text input
 *   2. Unit Number   — number input
 *   3. Unit Type     — ALS / BLS radio-style toggle buttons (Sprint 2.5)
 *   4. Direct Phone  — text input, XXX-XXX-XXXX format
 *
 * PROPS:
 *   onComplete: (unit, unitType, name, phone) => void
 */

import { useState } from 'react';
import styles from './ShiftCheckIn.module.css';

interface ShiftCheckInProps {
  onComplete: (unit: number, unitType: 'ALS' | 'BLS', name: string, phone: string) => void;
}

const PHONE_PATTERN = /^\d{3}-\d{3}-\d{4}$/;

export default function ShiftCheckIn({ onComplete }: ShiftCheckInProps) {
  const [medicName, setMedicName] = useState('');
  const [unitNumber, setUnitNumber] = useState('');
  const [unitType, setUnitType] = useState<'ALS' | 'BLS' | ''>('');
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [generalError, setGeneralError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isValid =
    medicName.trim().length > 0 &&
    unitNumber.trim().length > 0 &&
    unitType !== '' &&
    phone.trim().length > 0;

  const handlePhoneBlur = () => {
    if (phone.trim() && !PHONE_PATTERN.test(phone.trim())) {
      setPhoneError('Format required: XXX-XXX-XXXX (e.g. 215-555-0199)');
    } else {
      setPhoneError('');
    }
  };

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPhone(e.target.value);
    if (phoneError && PHONE_PATTERN.test(e.target.value.trim())) {
      setPhoneError('');
    }
  };

  const handleSubmit = () => {
    setGeneralError('');

    if (!medicName.trim() || !unitNumber.trim() || !unitType || !phone.trim()) {
      setGeneralError('All fields are required.');
      return;
    }

    const unit = parseInt(unitNumber.trim(), 10);
    if (isNaN(unit) || unit <= 0) {
      setGeneralError('Unit number must be a positive integer.');
      return;
    }

    if (!PHONE_PATTERN.test(phone.trim())) {
      setPhoneError('Format required: XXX-XXX-XXXX (e.g. 215-555-0199)');
      return;
    }

    setIsSubmitting(true);
    try {
      onComplete(unit, unitType as 'ALS' | 'BLS', medicName.trim(), phone.trim());
    } catch (err) {
      setGeneralError(err instanceof Error ? err.message : 'Session start failed.');
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && isValid && !isSubmitting) {
      handleSubmit();
    }
  };

  return (
    <div className={styles.overlay}>
      <div className={styles.card}>

        {/* ── Header ──────────────────────────────────────────────── */}
        <div className={styles.header}>
          <span className={styles.icon}>🚑</span>
          <div className={styles.headerText}>
            <h2 className={styles.title}>SHIFT START VERIFICATION</h2>
            <p className={styles.subtitle}>
              Verify your crew details before beginning patient intake.
            </p>
          </div>
        </div>

        {/* ── Body: Input Fields ───────────────────────────────────── */}
        <div className={styles.body}>

          {/* Medic Name */}
          <div className={styles.fieldGroup}>
            <label className={styles.label} htmlFor="medicName">
              Medic Name <span className={styles.required}>*</span>
            </label>
            <input
              id="medicName"
              type="text"
              className={styles.input}
              value={medicName}
              onChange={(e) => setMedicName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Full Name, e.g. Jane Doe"
              autoComplete="name"
              autoFocus
            />
          </div>

          {/* Unit Number */}
          <div className={styles.fieldGroup}>
            <label className={styles.label} htmlFor="unitNumber">
              Unit Number <span className={styles.required}>*</span>
            </label>
            <input
              id="unitNumber"
              type="number"
              className={styles.input}
              value={unitNumber}
              onChange={(e) => setUnitNumber(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. 55"
              min="1"
            />
          </div>

          {/* Unit Type — ALS / BLS toggle */}
          <div className={styles.fieldGroup}>
            <label className={styles.label}>
              Unit Type <span className={styles.required}>*</span>
            </label>
            <div className={styles.unitTypeRow}>
              <button
                type="button"
                className={`${styles.unitTypeBtn} ${unitType === 'ALS' ? styles.unitTypeBtnActive : ''}`}
                onClick={() => setUnitType('ALS')}
              >
                ALS
              </button>
              <button
                type="button"
                className={`${styles.unitTypeBtn} ${unitType === 'BLS' ? styles.unitTypeBtnActive : ''}`}
                onClick={() => setUnitType('BLS')}
              >
                BLS
              </button>
            </div>
          </div>

          {/* Direct Phone */}
          <div className={styles.fieldGroup}>
            <label className={styles.label} htmlFor="medicPhone">
              Direct Phone <span className={styles.required}>*</span>
            </label>
            <input
              id="medicPhone"
              type="text"
              className={`${styles.input} ${phoneError ? styles.inputError : ''}`}
              value={phone}
              onChange={handlePhoneChange}
              onBlur={handlePhoneBlur}
              onKeyDown={handleKeyDown}
              placeholder="XXX-XXX-XXXX"
              autoComplete="tel"
              inputMode="tel"
            />
            {phoneError && (
              <p className={styles.errorText}>{phoneError}</p>
            )}
          </div>

          {/* General error message */}
          {generalError && (
            <div className={styles.errorBanner}>{generalError}</div>
          )}
        </div>

        {/* ── Footer: Submit Button ────────────────────────────────── */}
        <div className={styles.footer}>
          <button
            type="button"
            className={styles.btnStart}
            onClick={handleSubmit}
            disabled={!isValid || isSubmitting}
          >
            {isSubmitting ? 'Starting Shift…' : 'Start Shift'}
          </button>
          <p className={styles.disclaimer}>
            Your unit, unit type, name, and phone will be attached to every
            patient record submitted during this shift.
          </p>
        </div>
      </div>
    </div>
  );
}
