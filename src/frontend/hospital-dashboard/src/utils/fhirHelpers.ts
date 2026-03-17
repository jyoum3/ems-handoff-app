// fhirHelpers.ts — FHIR Bundle extraction & formatting utilities
// Sprint 5: OVERDUE +Nmin, formatArrivedAt MM/DD/YYYY|HH:MM,
//           Sugar vital, isVitalAbnormal, formatLKW

import type {
  AssessmentResource,
  EcgRecord,
  EncounterResource,
  FHIRBundle,
  ObservationResource,
  PatientResource,
  VitalSignEntry,
  AssessmentEntry,
  TransportLogEntry,
} from '../types/fhir';

// ---------------------------------------------------------------------------
// Resource Extractors
// ---------------------------------------------------------------------------

export function getPatient(bundle: FHIRBundle): PatientResource | undefined {
  return bundle.entry
    .map((e) => e.resource)
    .find((r): r is PatientResource => r.resourceType === 'Patient');
}

export function getEncounter(bundle: FHIRBundle): EncounterResource | undefined {
  return bundle.entry
    .map((e) => e.resource)
    .find((r): r is EncounterResource => r.resourceType === 'Encounter');
}

export function getObservation(bundle: FHIRBundle): ObservationResource | undefined {
  return bundle.entry
    .map((e) => e.resource)
    .find((r): r is ObservationResource => r.resourceType === 'Observation');
}

// ---------------------------------------------------------------------------
// Patient Name
// ---------------------------------------------------------------------------

export function getPatientName(bundle: FHIRBundle): { first: string; last: string; full: string; lastFirst: string } {
  const patient = getPatient(bundle);
  const nameEntry = patient?.name?.[0];
  const last = nameEntry?.family ?? 'Unknown';
  const first = nameEntry?.given?.[0] ?? 'Unknown';
  return {
    first,
    last,
    full: `${first} ${last}`,
    lastFirst: `${last}, ${first}`,
  };
}

// ---------------------------------------------------------------------------
// Extension Helper
// ---------------------------------------------------------------------------

export function getExtensionValue(
  extensions: { url: string; valueString?: string; valueDateTime?: string }[] | undefined,
  url: string,
): string | undefined {
  return extensions?.find((e) => e.url === url)?.valueString;
}

export function getExtensionDateTime(
  extensions: { url: string; valueString?: string; valueDateTime?: string }[] | undefined,
  url: string,
): string | undefined {
  return extensions?.find((e) => e.url === url)?.valueDateTime;
}

// ---------------------------------------------------------------------------
// Vital Sign Extraction
// Supports: HR, BP, RR, SpO2, GCS, Temp, Sugar (Blood Glucose / BGL)
// ---------------------------------------------------------------------------

export function getVital(obs: ObservationResource | undefined, key: string): string {
  if (!obs?.component) return '--';
  const aliases: Record<string, string[]> = {
    Sugar: ['Sugar', 'Blood Glucose', 'BGL', 'Glucose'],
  };
  const targets = aliases[key] ?? [key];
  const comp = obs.component.find((c) =>
    targets.some((t) => c.code?.text?.toLowerCase() === t.toLowerCase()),
  );
  if (!comp) return '--';
  if (comp.valueString) return comp.valueString;
  if (comp.valueQuantity?.value !== undefined) {
    const unit = comp.valueQuantity.unit ?? '';
    return unit ? `${comp.valueQuantity.value} ${unit}` : String(comp.valueQuantity.value);
  }
  return '--';
}

// ---------------------------------------------------------------------------
// Abnormal Vital Flags (Item 17)
// ---------------------------------------------------------------------------

/**
 * Standardized vital sign abnormal thresholds — single source of truth.
 * Applied consistently across: PatientRow (row flags), PatientDetailModal
 * (vitals grid + triage note), LiveHandoffView (vitals table + triage note).
 *
 * Approved thresholds (2026-03-16):
 *   HR:    < 50  or > 120 bpm
 *   BP:    systolic < 90 or > 179 mmHg  (diastolic not flagged independently)
 *   RR:    < 11  or > 21 /min
 *   SpO2:  < 90%
 *   Temp:  < 96.8°F or > 100.4°F
 *   GCS:   <= 14
 *   Sugar: < 70 or > 200 mg/dL
 */
export function isVitalAbnormal(
  key: 'HR' | 'BP' | 'RR' | 'SpO2' | 'Temp' | 'Sugar' | 'GCS',
  rawValue: string,
): boolean {
  if (!rawValue || rawValue === '--') return false;
  const num = parseFloat(rawValue);

  switch (key) {
    case 'HR':
      return !isNaN(num) && (num < 50 || num > 120);

    case 'BP': {
      // Parse "158/94" or "158/94 mmHg" — flag systolic only
      const match = rawValue.match(/(\d+)\s*\/\s*(\d+)/);
      if (!match) return false;
      const systolic = parseInt(match[1], 10);
      return systolic < 90 || systolic > 179;
    }

    case 'RR':
      return !isNaN(num) && (num < 11 || num > 21);

    case 'SpO2':
      return !isNaN(num) && num < 90;

    case 'Temp':
      return !isNaN(num) && (num < 96.8 || num > 100.4);

    case 'Sugar':
      return !isNaN(num) && (num < 70 || num > 200);

    case 'GCS':
      return !isNaN(num) && num <= 14;

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// ESI Level
// ---------------------------------------------------------------------------

export function getESI(bundle: FHIRBundle): string {
  const enc = getEncounter(bundle);
  return enc?.priority?.text ?? '--';
}

// ---------------------------------------------------------------------------
// ETA Formatting (Item 5: OVERDUE +Nmin)
// ---------------------------------------------------------------------------

export interface ETAResult {
  display: string;      // e.g. "14:32 ~ 8min" or "OVERDUE +23min"
  isOverdue: boolean;
  minutesAway: number;  // negative if overdue
}

export function formatETAFull(etaISO: string | undefined): ETAResult {
  if (!etaISO) return { display: '--', isOverdue: false, minutesAway: 0 };

  const etaDate = new Date(etaISO);
  if (isNaN(etaDate.getTime())) return { display: '--', isOverdue: false, minutesAway: 0 };

  const now = new Date();
  const diffMs = etaDate.getTime() - now.getTime();
  const diffMin = Math.round(diffMs / 60000);
  const isOverdue = diffMin < 0;

  const hh = etaDate.getHours().toString().padStart(2, '0');
  const mm = etaDate.getMinutes().toString().padStart(2, '0');
  const timeStr = `${hh}:${mm}`;

  if (isOverdue) {
    const overdueMin = Math.abs(diffMin);
    return {
      display: `OVERDUE +${overdueMin}min`,
      isOverdue: true,
      minutesAway: diffMin,
    };
  }

  return {
    display: `${timeStr} ~ ${diffMin}min`,
    isOverdue: false,
    minutesAway: diffMin,
  };
}

// ---------------------------------------------------------------------------
// Arrived At Formatting (Item 9: MM/DD/YYYY | HH:MM local time)
// ---------------------------------------------------------------------------

export function formatArrivedAt(arrivedAt: string | undefined): string {
  if (!arrivedAt) return '--';
  const d = new Date(arrivedAt);
  if (isNaN(d.getTime())) return '--';
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  const year = d.getFullYear();
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${month}/${day}/${year} | ${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// Last Known Well Formatting (Item 12: MM/DD/YYYY | HH:MM local time)
// ---------------------------------------------------------------------------

export function formatLKW(lkwISO: string | undefined): string {
  if (!lkwISO) return '--';
  // Passthrough for 'Unknown' sentinel (new default value — not a parseable date)
  if (lkwISO.trim() === 'Unknown') return 'Unknown';
  const d = new Date(lkwISO);
  if (isNaN(d.getTime())) return lkwISO; // passthrough non-parseable strings as-is
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  const year = d.getFullYear();
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${month}/${day}/${year} | ${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// Comment Timestamp Formatting (MM/DD/YYYY - HH:MM)
// ---------------------------------------------------------------------------

export function formatCommentDate(isoString: string): string {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  const year = d.getFullYear();
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${month}/${day}/${year} - ${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// ESI Color Helper
// ---------------------------------------------------------------------------

export function getESIColor(esiText: string): string {
  if (esiText.includes('1') || esiText.toUpperCase().includes('CRITICAL')) return '#EF4444';
  if (esiText.includes('2') || esiText.toUpperCase().includes('EMERGENT')) return '#F97316';
  if (esiText.includes('3') || esiText.toUpperCase().includes('URGENT')) return '#EAB308';
  if (esiText.includes('4')) return '#3B82F6';
  if (esiText.includes('5')) return '#22C55E';
  return '#94A3B8';
}

// ---------------------------------------------------------------------------
// Backward-Compatible Aliases (accept resource objects directly)
// ---------------------------------------------------------------------------

/** Formats patient name as "Last, First" from a PatientResource */
export function formatPatientName(patient: PatientResource | undefined): string {
  if (!patient) return 'Unknown, Unknown';
  const nameEntry = patient.name?.[0];
  const last = nameEntry?.family ?? 'Unknown';
  const first = nameEntry?.given?.[0] ?? 'Unknown';
  return `${last}, ${first}`;
}

/** Formats age from a PatientResource */
export function formatAge(patient: PatientResource | undefined): string {
  if (!patient) return '--';
  if (patient.computed_age !== undefined && patient.computed_age !== null) {
    if (patient.computed_age > 120) return 'Unknown';
    return String(patient.computed_age);
  }
  return '--';
}

/** Formats gender for display from a PatientResource */
export function formatGender(patient: PatientResource | undefined): string {
  const g = patient?.gender;
  if (!g || g.toLowerCase() === 'unknown') return 'Unknown';
  return g.charAt(0).toUpperCase() + g.slice(1).toLowerCase();
}

/** Returns ESI level text from an EncounterResource */
export function getESILevel(encounter: EncounterResource | undefined): string {
  return encounter?.priority?.text ?? '--';
}

/** @deprecated Use formatETAFull(eta).display */
export function formatETA(etaISO: string | undefined): string {
  return formatETAFull(etaISO).display;
}

/** Extracts triage note text from an ObservationResource */
export function getTriageNote(obs: ObservationResource | undefined): string {
  return obs?.note?.[0]?.text ?? '';
}

// ---------------------------------------------------------------------------
// Phase 4 Sprint 2.5: New helper functions
// ---------------------------------------------------------------------------

/** Returns the AssessmentResource from the bundle, or null if not present */
export function getAssessment(bundle: FHIRBundle): AssessmentResource | null {
  const found = bundle.entry
    .map((e) => e.resource)
    .find((r): r is AssessmentResource => r.resourceType === 'Assessment');
  return found ?? null;
}

/** Returns the code status string (e.g. "DNR") or null */
export function getCodeStatus(bundle: FHIRBundle): string | null {
  const patient = getPatient(bundle);
  return patient?.codeStatus ?? null;
}

/** Returns alert badges array or [] */
export function getAlertBadges(bundle: FHIRBundle): string[] {
  const patient = getPatient(bundle);
  return patient?.alertBadges ?? [];
}

/** Returns the Observation with observationType="initial", or the first Observation (backward compat) */
export function getInitialVitals(bundle: FHIRBundle): ObservationResource | null {
  const all = bundle.entry
    .map((e) => e.resource)
    .filter((r): r is ObservationResource => r.resourceType === 'Observation');
  // Prefer explicit initial tag
  return all.find((r) => r.observationType === 'initial') ?? all[0] ?? null;
}

/** Returns the Observation with observationType="current", or null if not present */
export function getCurrentVitals(bundle: FHIRBundle): ObservationResource | null {
  return (
    bundle.entry
      .map((e) => e.resource)
      .find((r): r is ObservationResource =>
        r.resourceType === 'Observation' && r.observationType === 'current',
      ) ?? null
  );
}

/** Returns ALS | BLS | null */
export function getMedicUnitType(bundle: FHIRBundle): string | null {
  return bundle.medicUnitType ?? null;
}

/** Returns scene notes array from EncounterResource or [] */
export function getSceneNotes(bundle: FHIRBundle): string[] {
  const enc = getEncounter(bundle);
  return enc?.sceneNotes ?? [];
}

/** Returns interventions array from EncounterResource or [] */
export function getInterventions(bundle: FHIRBundle): string[] {
  const enc = getEncounter(bundle);
  return enc?.interventions ?? [];
}

// ---------------------------------------------------------------------------
// Phase 4 Sprint 2.75: ECG + Clinical completeness helpers
// ---------------------------------------------------------------------------

/** Returns all EcgRecord entries or [] */
export function getEcgRecords(bundle: FHIRBundle): EcgRecord[] {
  return bundle.ecgRecords ?? [];
}

/** Returns the current (last) EcgRecord or null. Frontend always renders [-1] as "Current". */
export function getCurrentEcg(bundle: FHIRBundle): EcgRecord | null {
  const records = getEcgRecords(bundle);
  return records.length > 0 ? records[records.length - 1] : null;
}

/**
 * Returns EcgRecord at specific index or null.
 * Supports negative indexing: -1 = last (current), 0 = first (initial).
 */
export function getEcgByIndex(bundle: FHIRBundle, index: number): EcgRecord | null {
  const records = getEcgRecords(bundle);
  const i = index < 0 ? records.length + index : index;
  return records[i] ?? null;
}

/** Returns all encounter type strings (e.g. ['Trauma', 'OB-GYN']) or [] */
export function getEncounterTypes(bundle: FHIRBundle): string[] {
  return getEncounter(bundle)?.encounterTypes ?? [];
}

/** Returns the first encounterType or null. @deprecated Use getEncounterTypes(). */
export function getEncounterType(bundle: FHIRBundle): string | null {
  const types = getEncounterTypes(bundle);
  return types.length > 0 ? types[0] : null;
}

/** Returns NRS pain score (0-10) from the initial vitals Observation or null */
export function getPainScore(bundle: FHIRBundle): number | null {
  return getInitialVitals(bundle)?.pain ?? null;
}

// ---------------------------------------------------------------------------
// Status Badge Helper
// ---------------------------------------------------------------------------

export function getStatusDisplay(status: string | undefined): { label: string; color: string } {
  switch (status?.toLowerCase()) {
    case 'inbound':
      return { label: 'Inbound', color: '#3B82F6' };
    case 'arrived':
      return { label: 'Arrived', color: '#22C55E' };
    default:
      return { label: status ?? 'Unknown', color: '#94A3B8' };
  }
}

// ---------------------------------------------------------------------------
// Phase 4 Sprint 3.3: History Array Helpers
// ---------------------------------------------------------------------------

/** Returns the full vitalHistory[] array or [] for bundles without it */
export function getVitalHistory(bundle: FHIRBundle): VitalSignEntry[] {
  return bundle.vitalHistory ?? [];
}

/** Returns the full assessmentHistory[] array or [] for bundles without it */
export function getAssessmentHistory(bundle: FHIRBundle): AssessmentEntry[] {
  return bundle.assessmentHistory ?? [];
}

/** Returns the full transportLog[] array or [] for bundles without it */
export function getTransportLog(bundle: FHIRBundle): TransportLogEntry[] {
  return bundle.transportLog ?? [];
}

/**
 * Returns the most recent VitalSignEntry (last element of vitalHistory[])
 * or null if history is empty.
 * Used by the hospital dashboard to show the ● CURRENT vital row.
 */
export function getCurrentVitalEntry(bundle: FHIRBundle): VitalSignEntry | null {
  const history = bundle.vitalHistory;
  if (history && history.length > 0) return history[history.length - 1];
  return null;
}

/**
 * Sprint 4.1 (fixed post-Phase-4 testing): Returns the most recent NON-EMPTY
 * value for a given vital code across ALL vitalHistory entries.
 *
 * Problem with the original implementation: it only checked vitalHistory[-1].
 * If the last update only contained BP (leaving HR blank), the fallback jumped
 * all the way to the initial Observation — skipping any intermediate HR updates.
 *
 * Fix: iterate backwards through ALL vitalHistory entries to find the most
 * recent entry where the target field is non-empty ("last-wins merge").
 * Only fall back to the initial Observation if no history entry has a value.
 *
 * Example:
 *   Initial:  HR 80,  BP 160/100
 *   Update 1: HR —,   BP 200/40   ← last entry for BP
 *   Update 2: HR 140, BP —        ← last entry for HR
 *   Row shows: HR 140, BP 200/40  ✓
 *
 * @param bundle - The FHIRBundle to extract from
 * @param code   - Vital code: 'HR' | 'BP' | 'RR' | 'SpO2' | 'Temp' | 'GCS' | 'Sugar'
 */
export function getLatestVitalValue(bundle: FHIRBundle, code: string): string {
  const codeMap: Record<string, keyof VitalSignEntry> = {
    HR: 'hr', BP: 'bp', RR: 'rr', SpO2: 'spo2', Temp: 'temp',
    GCS: 'gcs', Sugar: 'sugar',
  }
  const field = codeMap[code]
  if (field && bundle.vitalHistory && bundle.vitalHistory.length > 0) {
    // Iterate backwards — most recent entry wins
    for (let i = bundle.vitalHistory.length - 1; i >= 0; i--) {
      const entry = bundle.vitalHistory[i]
      const val = entry[field]
      if (val !== undefined && val !== null && String(val) !== '') {
        return String(val)
      }
    }
  }
  // Fallback: initial Observation in bundle.entry[] (pre-Sprint-3.3 bundles)
  const obs = getObservation(bundle)
  return getVital(obs, code)
}
