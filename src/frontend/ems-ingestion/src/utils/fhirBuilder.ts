// fhirBuilder.ts — EMS Ingestion PWA: FHIR Bundle Assembly Utility
// ==================================================================
// Translates raw PatientFormData + EmsSession into a validated-ready
// FHIRBundle that the backend Pydantic Bouncer will accept at POST /api/ems-to-db.
//
// Phase 4 Sprint 2.5 — Full schema redesign:
//   7 form sections → 4-5 FHIR entries (Patient, Encounter, initial Obs,
//   Assessment [conditional]) + bundle-root history arrays
//
// Phase 4 Sprint 3.3 — History array architecture:
//   - Removed currentObservation (observationType:"current") from bundle.entry[]
//   - Removed transportNotes from EncounterResource
//   - Added vitalHistory[], assessmentHistory[], transportLog[] at bundle root
//   - buildVitalSignEntry / buildAssessmentEntry / buildVitalsAutoSummary /
//     buildAssessmentAutoSummary exported as helpers for inline add-entry forms
//
// Field mapping reference:
//   src/api/models.py              — Pydantic model structure (backend truth)
//   src/shared/schemas/FHIR-patient-schema-v1.json — canonical schema (v2)

import type {
  FHIRBundle,
  EmsSession,
  PatientResource,
  EncounterResource,
  ObservationResource,
  AssessmentResource,
  FHIRExtension,
  PatientContact,
  ObservationComponent,
  VitalSignEntry,
  AssessmentEntry,
  TransportLogEntry,
} from '../types/fhir';

// ---------------------------------------------------------------------------
// PatientFormData — the raw shape of the 7-section patient form
// ---------------------------------------------------------------------------

export interface PatientFormData {
  // ── Section 1: Identification & Alerts ───────────────────────────────────
  isUnknownPatient: boolean;
  familyName: string;
  givenName: string;
  birthDate: string;            // ISO date "YYYY-MM-DD" or sentinel "1880-01-01" or ""
  gender: string;               // "male" | "female" | "unknown" | "other"
  codeStatus: string;           // "Full Code" | "DNR" | "DNI" | "DNR/DNI" | ""
  alertBadges: string[];
  emergencyContactFamily: string;
  emergencyContactGiven: string;
  emergencyContactPhone: string;
  emergencyContactRelationship: string;

  // ── Section 2: Chief Complaint & Timeline ────────────────────────────────
  chiefComplaint: string;
  esiLevel: string;
  triageNote: string;           // HPI/Assessment/Intervention template text
  lastKnownWell: string;        // ISO datetime or ""
  onsetTime: string;            // ISO datetime or ""
  emsContactTime: string;       // ISO datetime or ""
  arrivalEta: string;           // ISO datetime or ""
  // Phase 4 Sprint 2.75
  encounterTypes: string[];     // multi-select: ['Medical','Trauma',...] — can be multiple

  // ── Section 3: Vital Signs ────────────────────────────────────────────────
  // Initial (locked on-scene baseline — stored in vitalHistory[0] + bundle.entry[])
  hrInitial: string;
  bpInitial: string;            // free text "120/80"
  bpLocationInitial: string;
  bpOrientationInitial: string;
  rrInitial: string;
  spo2Initial: string;
  spo2DeviceInitial: string;
  spo2FlowRateInitial: string;
  tempInitial: string;
  tempLocationInitial: string;
  sugarInitial: string;
  height: string;               // estimated inches
  weight: string;               // estimated lbs
  // Phase 4 Sprint 2.75
  painInitial: string;          // NRS 0-10 as string; parsed to int on build, skipped if empty/NaN
  // Current (en-route update fields — used by inline Add Vitals Update form)
  // Sprint 3.3: These no longer build a currentObservation entry; instead they
  // feed buildVitalSignEntry() to create vitalHistory[] update entries.
  hrCurrent: string;
  bpCurrent: string;
  bpLocationCurrent: string;
  bpOrientationCurrent: string;
  rrCurrent: string;
  spo2Current: string;
  spo2DeviceCurrent: string;
  spo2FlowRateCurrent: string;
  tempCurrent: string;
  tempLocationCurrent: string;
  sugarCurrent: string;
  heightCurrent: string;        // estimated inches (current)
  weightCurrent: string;        // estimated lbs (current)
  painCurrent: string;          // NRS 0-10 as string
  // Sprint 3.3: GCS for current vitals update entry
  gcsCurrent: string;

  // ── Section 4: Assessment ─────────────────────────────────────────────────
  mentalStatus: string;         // AVPU
  gcs: string;
  orientation: string[];        // AxO domains checked
  pupils: string;
  motorLeft: string;
  motorRight: string;
  speech: string;
  airway: string;
  lungSounds: string[];
  skin: string[];
  pertinentNegatives: string[];

  // ── Section 5: Interventions & Resource Requirements ─────────────────────
  interventions: string[];
  resourceRequirements: string[];

  // ── Section 6: History (SAMPLE) ───────────────────────────────────────────
  allergies: string[];
  medications: string[];
  knownHistory: string[];
  lastOralIntake: string;       // free text or datetime
  events: string;               // narrative text

  // ── Section 7: Origin & Scene ─────────────────────────────────────────────
  originSource: string;
  originAddress: string;
  sceneNotes: string[];

  // ── Top-level ─────────────────────────────────────────────────────────────
  hospitalId: string;
  isolation: string;

  // ── Phase 4 Sprint 3: Vital timestamps ───────────────────────────────────
  vitalInitialTime: string;   // ISO datetime — set via clock button; stored as extension on initial Observation
  vitalCurrentTime: string;   // ISO datetime — preserved for backward compat; no longer used for a "current" obs
}

// ---------------------------------------------------------------------------
// generateBundleId
// ---------------------------------------------------------------------------

/**
 * Generates a unique bundle ID for this patient encounter.
 * Format: EMS-{medicUnit}-{Date.now()}
 * Called ONCE per patient encounter, on first submit.
 */
export function generateBundleId(medicUnit: number): string {
  return `EMS-${medicUnit}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// getAbnormalVitals — auto-flag triage note helper
// ---------------------------------------------------------------------------

/**
 * Returns a pipe-delimited string of abnormal initial vitals.
 * e.g. "HR: 122 bpm | SpO2: 88%"
 * Thresholds: HR < 60 or > 100 | RR < 12 or > 20 | SpO2 < 95 |
 *             Temp < 97 or > 99.5 | Sugar < 70 or > 180
 *             BP systolic: < 90 or > 180
 * Returns "" if all vitals are within normal limits or absent.
 */
/**
 * Standardized abnormal vital thresholds — must match fhirHelpers.isVitalAbnormal().
 * HR <50/>120 | BP systolic <90/>179 | RR <11/>21 | SpO2 <90% | Temp <96.8/>100.4 | Sugar <70/>200
 */
export function getAbnormalVitals(formData: PatientFormData): string {
  const flags: string[] = [];

  const hr = parseFloat(formData.hrInitial);
  if (!isNaN(hr) && (hr < 60 || hr > 100)) {
    flags.push(`(!) HR: ${hr} bpm`);
  }

  const bp = formData.bpInitial.trim();
  if (bp) {
    const match = bp.match(/^(\d+)/);
    if (match) {
      const systolic = parseInt(match[1], 10);
      if (systolic < 90 || systolic > 180) {
        flags.push(`(!) BP: ${bp} mmHg`);
      }
    }
  }

  const rr = parseFloat(formData.rrInitial);
  if (!isNaN(rr) && (rr < 12 || rr > 20)) {
    flags.push(`(!) RR: ${rr} br/min`);
  }

  const spo2 = parseFloat(formData.spo2Initial);
  if (!isNaN(spo2) && spo2 < 95) {
    flags.push(`(!) SpO2: ${spo2}%`);
  }

  const temp = parseFloat(formData.tempInitial);
  if (!isNaN(temp) && (temp < 97 || temp > 99.5)) {
    flags.push(`(!) Temp: ${temp}°F`);
  }

  const sugar = parseFloat(formData.sugarInitial);
  if (!isNaN(sugar) && (sugar < 70 || sugar > 180)) {
    flags.push(`(!) Sugar: ${sugar} mg/dL`);
  }

  return flags.join(' | ');
}

// ---------------------------------------------------------------------------
// buildObservationComponents — helper for initial vitals
// ---------------------------------------------------------------------------

interface VitalInputSet {
  hr: string;
  bp: string;
  bpLocation: string;
  bpOrientation: string;
  rr: string;
  spo2: string;
  spo2Device: string;
  spo2FlowRate: string;
  temp: string;
  tempLocation: string;
  sugar: string;
}

function buildVitalComponents(v: VitalInputSet): ObservationComponent[] {
  const components: ObservationComponent[] = [];

  if (v.hr.trim()) {
    const val = parseFloat(v.hr);
    if (!isNaN(val)) {
      components.push({
        code: { text: 'HR' },
        valueQuantity: { value: val, unit: 'bpm', system: 'http://unitsofmeasure.org', code: '/min' },
      });
    }
  }

  if (v.bp.trim()) {
    components.push({
      code: { text: 'BP' },
      valueString: v.bp.trim(),
      unit: 'mmHg',
      location: v.bpLocation.trim() || undefined,
      orientation: v.bpOrientation.trim() || undefined,
    });
  }

  if (v.rr.trim()) {
    const val = parseFloat(v.rr);
    if (!isNaN(val)) {
      components.push({
        code: { text: 'RR' },
        valueQuantity: { value: val, unit: 'breaths/min', system: 'http://unitsofmeasure.org', code: '/min' },
      });
    }
  }

  if (v.spo2.trim()) {
    const val = parseFloat(v.spo2);
    if (!isNaN(val)) {
      const flowRate = parseFloat(v.spo2FlowRate);
      components.push({
        code: { text: 'SpO2' },
        valueQuantity: { value: val, unit: '%', system: 'http://unitsofmeasure.org', code: '%' },
        device: v.spo2Device.trim() || undefined,
        flowRate: !isNaN(flowRate) ? flowRate : undefined,
      });
    }
  }

  if (v.temp.trim()) {
    const val = parseFloat(v.temp);
    if (!isNaN(val)) {
      components.push({
        code: { text: 'Temp' },
        valueQuantity: { value: val, unit: '°F', system: 'http://unitsofmeasure.org', code: '[degF]' },
        location: v.tempLocation.trim() || undefined,
      });
    }
  }

  if (v.sugar.trim()) {
    const val = parseFloat(v.sugar);
    if (!isNaN(val)) {
      components.push({
        code: { text: 'Sugar' },
        valueQuantity: { value: val, unit: 'mg/dL' },
      });
    }
  }

  return components;
}

// ---------------------------------------------------------------------------
// Sprint 3.3: History Entry Builders
// ---------------------------------------------------------------------------

/**
 * Builds a VitalSignEntry for a new en-route update from the *Current form fields.
 * Used by the inline "Add Vitals Update" form in LiveHandoffView.
 *
 * For the initial entry (vitalHistory[0]), buildFHIRBundle uses the *Initial
 * fields directly — this helper is only for subsequent updates.
 */
export function buildVitalSignEntry(formData: PatientFormData, label: string): VitalSignEntry {
  const painParsed = parseInt(formData.painCurrent, 10);
  const painVal: number | undefined =
    formData.painCurrent.trim() !== '' && !isNaN(painParsed) && painParsed >= 0 && painParsed <= 10
      ? painParsed
      : undefined;

  return {
    timestamp: new Date().toISOString(),
    label,
    hr: formData.hrCurrent.trim() || undefined,
    bp: formData.bpCurrent.trim() || undefined,
    rr: formData.rrCurrent.trim() || undefined,
    spo2: formData.spo2Current.trim() || undefined,
    spo2Device: formData.spo2DeviceCurrent.trim() || undefined,
    spo2FlowRate: formData.spo2FlowRateCurrent.trim() || undefined,
    temp: formData.tempCurrent.trim() || undefined,
    tempLocation: formData.tempLocationCurrent.trim() || undefined,
    gcs: formData.gcsCurrent.trim() || undefined,
    sugar: formData.sugarCurrent.trim() || undefined,
    height: formData.heightCurrent.trim() || undefined,
    weight: formData.weightCurrent.trim() || undefined,
    pain: painVal,
  };
}

/**
 * Builds an AssessmentEntry snapshot from the assessment form fields.
 * Used by both the initial build (from assessment section) and the inline
 * "Add Assessment Update" form in LiveHandoffView.
 */
export function buildAssessmentEntry(formData: PatientFormData, label: string): AssessmentEntry {
  return {
    timestamp: new Date().toISOString(),
    label,
    avpu: formData.mentalStatus || undefined,
    orientation: formData.orientation.length > 0 ? formData.orientation : undefined,
    pupils: formData.pupils.trim() || undefined,
    motorLeft: formData.motorLeft || undefined,
    motorRight: formData.motorRight || undefined,
    speech: formData.speech || undefined,
    airway: formData.airway || undefined,
    lungSounds: formData.lungSounds.length > 0 ? formData.lungSounds : undefined,
    skin: formData.skin.length > 0 ? formData.skin : undefined,
    pertinentNegatives: formData.pertinentNegatives.length > 0 ? formData.pertinentNegatives : undefined,
  };
}

/**
 * Generates a compact, pipe-delimited auto-summary string from a VitalSignEntry.
 * Used as TransportLogEntry.autoSummary for vitals_update entries.
 * e.g. "HR 88 | BP 160/95 | SpO2 98%"
 */
/**
 * Fix 7: Generates compact pipe-delimited auto-summary from VitalSignEntry.
 * Abnormal vitals are prefixed with "(!) " so the transport log render
 * can split on " | " and colorize flagged segments in red.
 * Thresholds match getAbnormalVitals() and computeAbnormalVitals() helpers.
 */
export function buildVitalsAutoSummary(entry: VitalSignEntry): string {
  const parts: string[] = [];
  if (entry.hr) {
    const v = parseFloat(entry.hr);
    const flag = !isNaN(v) && (v < 60 || v > 100);
    parts.push(`${flag ? '(!) ' : ''}HR: ${entry.hr} bpm`);
  }
  if (entry.bp) {
    const m = entry.bp.match(/^(\d+)/);
    const flag = m ? (parseInt(m[1]) < 90 || parseInt(m[1]) > 180) : false;
    parts.push(`${flag ? '(!) ' : ''}BP: ${entry.bp} mmHg`);
  }
  if (entry.rr) {
    const v = parseFloat(entry.rr);
    const flag = !isNaN(v) && (v < 12 || v > 20);
    parts.push(`${flag ? '(!) ' : ''}RR: ${entry.rr} /min`);
  }
  if (entry.spo2) {
    const v = parseFloat(entry.spo2);
    const flag = !isNaN(v) && v < 95;
    parts.push(`${flag ? '(!) ' : ''}SpO₂: ${entry.spo2}%`);
  }
  if (entry.temp) {
    const v = parseFloat(entry.temp);
    const flag = !isNaN(v) && (v < 97 || v > 99.5);
    parts.push(`${flag ? '(!) ' : ''}Temp: ${entry.temp}°F`);
  }
  if (entry.sugar) {
    const v = parseFloat(entry.sugar);
    const flag = !isNaN(v) && (v < 70 || v > 180);
    parts.push(`${flag ? '(!) ' : ''}Sugar: ${entry.sugar} mg/dL`);
  }
  return parts.join(' | ');
}

/**
 * Generates a compact auto-summary string from an AssessmentEntry.
 * Used as TransportLogEntry.autoSummary for assessment_update entries.
 * e.g. "AVPU: Alert | AxO x4 | Airway: Patent"
 */
export function buildAssessmentAutoSummary(entry: AssessmentEntry): string {
  const parts: string[] = [];
  if (entry.avpu) parts.push(`AVPU: ${entry.avpu}`);
  if (entry.orientation?.length) parts.push(`AxO x${entry.orientation.length}`);
  if (entry.airway) parts.push(`Airway: ${entry.airway}`);
  if (entry.lungSounds?.length) parts.push(`Lungs: ${entry.lungSounds.join(', ')}`);
  if (entry.skin?.length) parts.push(`Skin: ${entry.skin.join(', ')}`);
  return parts.join(' | ');
}

// ---------------------------------------------------------------------------
// buildFHIRBundle — Main assembly function
// ---------------------------------------------------------------------------

/**
 * Assembles a complete FHIRBundle from raw form state + medic session.
 *
 * FHIR entry resources:
 *   entry[0] → PatientResource   (demographics, codeStatus, alertBadges,
 *                                  medications, extensions, emergency contact)
 *   entry[1] → EncounterResource (ESI, chief complaint, ETA, interventions,
 *                                  resourceRequirements, sceneNotes, extensions)
 *   entry[2] → ObservationResource (observationType: "initial") — initial vitals
 *   entry[3] → AssessmentResource  — CONDITIONAL:
 *                only included when at least one assessment field is non-empty
 *
 * Sprint 3.3 changes:
 *   - No currentObservation entry (observationType:"current") in entries
 *   - No transportNotes on EncounterResource
 *   - Populates vitalHistory[0], assessmentHistory[0], transportLog[0] at bundle root
 *
 * Unknown patient sentinel: isUnknownPatient=true overrides demographics with
 *   familyName="Unknown", givenName="Patient", birthDate="1880-01-01", gender="unknown"
 *
 * Empty-string guard: all optional fields with empty string → undefined (not in JSON)
 */
export function buildFHIRBundle(
  formData: PatientFormData,
  session: EmsSession,
  bundleId: string,
): FHIRBundle {

  // ── Unknown patient override ──────────────────────────────────────────────
  const familyName = formData.isUnknownPatient ? 'Unknown' : formData.familyName.trim();
  const givenName = formData.isUnknownPatient ? 'Patient' : formData.givenName.trim();
  const birthDate = formData.isUnknownPatient ? '1880-01-01' : (formData.birthDate.trim() || undefined);
  const gender = formData.isUnknownPatient ? 'unknown' : (formData.gender ? formData.gender.toLowerCase() : undefined);

  // ── Patient Resource ──────────────────────────────────────────────────────
  const patientExtensions: FHIRExtension[] = [];

  if (formData.knownHistory.length > 0) {
    patientExtensions.push({ url: 'known-history', valueString: formData.knownHistory.join(', ') });
  }
  if (formData.isolation.trim()) {
    patientExtensions.push({ url: 'isolation', valueString: formData.isolation.trim() });
  }
  if (formData.allergies.length > 0) {
    patientExtensions.push({ url: 'allergies', valueString: formData.allergies.join(', ') });
  }
  if (formData.lastOralIntake.trim()) {
    patientExtensions.push({ url: 'last-oral-intake', valueString: formData.lastOralIntake.trim() });
  }

  // Emergency contact — structured family/given + phone + relationship
  const hasContact =
    formData.emergencyContactFamily.trim() ||
    formData.emergencyContactGiven.trim() ||
    formData.emergencyContactPhone.trim() ||
    formData.emergencyContactRelationship.trim();

  const contact: PatientContact[] = hasContact
    ? [
        {
          name: (formData.emergencyContactFamily.trim() || formData.emergencyContactGiven.trim())
            ? {
                family: formData.emergencyContactFamily.trim() || undefined,
                given: formData.emergencyContactGiven.trim() || undefined,
              }
            : undefined,
          telecom: formData.emergencyContactPhone.trim()
            ? [{ system: 'phone', value: formData.emergencyContactPhone.trim() }]
            : undefined,
          relationship: formData.emergencyContactRelationship.trim()
            ? [{ text: formData.emergencyContactRelationship.trim() }]
            : undefined,
        },
      ]
    : [];

  const patientResource: PatientResource = {
    resourceType: 'Patient',
    name:
      familyName || givenName
        ? [{ family: familyName || undefined, given: givenName ? [givenName] : undefined }]
        : undefined,
    gender,
    birthDate,
    extension: patientExtensions.length > 0 ? patientExtensions : undefined,
    contact: contact.length > 0 ? contact : undefined,
    medications: formData.medications.length > 0 ? formData.medications : undefined,
    codeStatus: (formData.codeStatus as PatientResource['codeStatus']) || undefined,
    alertBadges: formData.alertBadges.length > 0 ? formData.alertBadges : undefined,
  };

  // ── Encounter Resource ────────────────────────────────────────────────────
  const encounterExtensions: FHIRExtension[] = [];

  if (formData.lastKnownWell.trim()) {
    encounterExtensions.push({ url: 'lkw', valueDateTime: formData.lastKnownWell.trim() });
  }
  if (formData.onsetTime.trim()) {
    encounterExtensions.push({ url: 'onset-time', valueDateTime: formData.onsetTime.trim() });
  }
  if (formData.emsContactTime.trim()) {
    encounterExtensions.push({ url: 'ems-contact-time', valueDateTime: formData.emsContactTime.trim() });
  }
  if (formData.events.trim()) {
    encounterExtensions.push({ url: 'events', valueString: formData.events.trim() });
  }

  const encounterResource: EncounterResource = {
    resourceType: 'Encounter',
    status: 'in-progress',
    priority: formData.esiLevel ? { text: formData.esiLevel } : undefined,
    reasonCode: formData.chiefComplaint.trim()
      ? [{ text: formData.chiefComplaint.trim() }]
      : undefined,
    period: formData.arrivalEta.trim() ? { end: formData.arrivalEta.trim() } : undefined,
    extension: encounterExtensions.length > 0 ? encounterExtensions : undefined,
    resourceRequirements:
      formData.resourceRequirements.length > 0 ? formData.resourceRequirements : undefined,
    interventions: formData.interventions.length > 0 ? formData.interventions : undefined,
    sceneNotes: formData.sceneNotes.length > 0 ? formData.sceneNotes : undefined,
    // Phase 4 Sprint 2.75: multi-select encounterTypes drives team activation pathway
    encounterTypes: formData.encounterTypes.length > 0
      ? (formData.encounterTypes as EncounterResource['encounterTypes'])
      : undefined,
    // Sprint 3.3: transportNotes REMOVED — replaced by transportLog[] at bundle root
  };

  // ── Initial Observation Resource ──────────────────────────────────────────
  const initialComponents = buildVitalComponents({
    hr: formData.hrInitial,
    bp: formData.bpInitial,
    bpLocation: formData.bpLocationInitial,
    bpOrientation: formData.bpOrientationInitial,
    rr: formData.rrInitial,
    spo2: formData.spo2Initial,
    spo2Device: formData.spo2DeviceInitial,
    spo2FlowRate: formData.spo2FlowRateInitial,
    temp: formData.tempInitial,
    tempLocation: formData.tempLocationInitial,
    sugar: formData.sugarInitial,
  });

  const heightVal = parseFloat(formData.height);
  const weightVal = parseFloat(formData.weight);

  // Replace abnormal vitals placeholder in triage note
  const abnormalVitals = getAbnormalVitals(formData);
  const resolvedTriageNote = formData.triageNote
    .replace('[ABNORMAL_VITALS_PLACEHOLDER]', abnormalVitals || '')
    .trim();

  // Phase 4 Sprint 2.75: pain score (NRS 0-10) — only include when valid int in range
  const painParsed = parseInt(formData.painInitial, 10);
  const painVal: number | undefined =
    formData.painInitial.trim() !== '' && !isNaN(painParsed) && painParsed >= 0 && painParsed <= 10
      ? painParsed
      : undefined;

  // Phase 4 Sprint 3: vital timestamps as observation extensions
  const initialObsExtensions: FHIRExtension[] = [];
  if (formData.vitalInitialTime?.trim()) {
    initialObsExtensions.push({ url: 'vital-initial-time', valueDateTime: formData.vitalInitialTime.trim() });
  }

  const initialObservation: ObservationResource = {
    resourceType: 'Observation',
    observationType: 'initial',
    status: 'final',
    code: { text: 'Vital Signs - Initial' },
    component: initialComponents.length > 0 ? initialComponents : undefined,
    note: resolvedTriageNote ? [{ text: resolvedTriageNote }] : undefined,
    height: !isNaN(heightVal) ? heightVal : undefined,
    weight: !isNaN(weightVal) ? weightVal : undefined,
    pain: painVal,
    extension: initialObsExtensions.length > 0 ? initialObsExtensions : undefined,
  };

  // Sprint 3.3: No currentObservation entry — en-route vitals go into vitalHistory[]

  // ── Assessment Resource (conditional) ─────────────────────────────────────
  const hasAssessment =
    formData.mentalStatus ||
    formData.gcs.trim() ||
    formData.orientation.length > 0 ||
    formData.pupils.trim() ||
    formData.motorLeft ||
    formData.motorRight ||
    formData.speech ||
    formData.airway ||
    formData.lungSounds.length > 0 ||
    formData.skin.length > 0 ||
    formData.pertinentNegatives.length > 0;

  let assessmentResource: AssessmentResource | null = null;
  if (hasAssessment) {
    const gcsVal = parseInt(formData.gcs, 10);
    assessmentResource = {
      resourceType: 'Assessment',
      mentalStatus: (formData.mentalStatus as AssessmentResource['mentalStatus']) || undefined,
      gcs: !isNaN(gcsVal) && formData.gcs.trim() ? gcsVal : undefined,
      orientation: formData.orientation.length > 0 ? formData.orientation : undefined,
      pupils: formData.pupils.trim() || undefined,
      motorLeft: formData.motorLeft || undefined,
      motorRight: formData.motorRight || undefined,
      speech: (formData.speech as AssessmentResource['speech']) || undefined,
      airway: (formData.airway as AssessmentResource['airway']) || undefined,
      lungSounds: formData.lungSounds.length > 0 ? formData.lungSounds : undefined,
      skin: formData.skin.length > 0 ? formData.skin : undefined,
      pertinentNegatives: formData.pertinentNegatives.length > 0 ? formData.pertinentNegatives : undefined,
    };
  }

  // ── Build entry array ─────────────────────────────────────────────────────
  // Sprint 3.3: Only initial vitals + assessment go in entry[].
  // No currentObservation entry — those go in vitalHistory[] at bundle root.
  const entries: FHIRBundle['entry'] = [
    { resource: patientResource },
    { resource: encounterResource },
    { resource: initialObservation },
  ];
  if (assessmentResource) entries.push({ resource: assessmentResource });

  // ── Sprint 3.3: Populate initial history arrays ───────────────────────────
  const now = new Date().toISOString();

  // vitalHistory[0] — Initial on-scene vitals snapshot (locked)
  const initialVitalEntry: VitalSignEntry = {
    timestamp: formData.vitalInitialTime?.trim() || now,
    label: 'Initial',
    hr: formData.hrInitial.trim() || undefined,
    bp: formData.bpInitial.trim() || undefined,
    rr: formData.rrInitial.trim() || undefined,
    spo2: formData.spo2Initial.trim() || undefined,
    spo2Device: formData.spo2DeviceInitial.trim() || undefined,
    spo2FlowRate: formData.spo2FlowRateInitial.trim() || undefined,
    temp: formData.tempInitial.trim() || undefined,
    tempLocation: formData.tempLocationInitial.trim() || undefined,
    gcs: formData.gcs.trim() || undefined,
    sugar: formData.sugarInitial.trim() || undefined,
    height: formData.height.trim() || undefined,
    weight: formData.weight.trim() || undefined,
    pain: painVal,
  };
  const hasInitialVitals = Object.entries(initialVitalEntry).some(
    ([k, v]) => k !== 'timestamp' && k !== 'label' && v !== undefined,
  );

  // assessmentHistory[0] — Initial assessment snapshot (locked)
  const initialAssessEntry: AssessmentEntry = {
    timestamp: now,
    label: 'Initial',
    avpu: formData.mentalStatus || undefined,
    orientation: formData.orientation.length > 0 ? formData.orientation : undefined,
    pupils: formData.pupils.trim() || undefined,
    motorLeft: formData.motorLeft || undefined,
    motorRight: formData.motorRight || undefined,
    speech: formData.speech || undefined,
    airway: formData.airway || undefined,
    lungSounds: formData.lungSounds.length > 0 ? formData.lungSounds : undefined,
    skin: formData.skin.length > 0 ? formData.skin : undefined,
    pertinentNegatives: formData.pertinentNegatives.length > 0 ? formData.pertinentNegatives : undefined,
  };
  const hasInitialAssess = Object.entries(initialAssessEntry).some(
    ([k, v]) => k !== 'timestamp' && k !== 'label' && v !== undefined,
  );

  // transportLog[0] — Initial documentation note
  const initialLog: TransportLogEntry[] = [
    {
      timestamp: now,
      type: 'note',
      medicComment: 'Initial vitals documented.',
    },
  ];

  // ── FHIRBundle Root ───────────────────────────────────────────────────────
  const bundle: FHIRBundle = {
    resourceType: 'Bundle',
    id: bundleId,
    hospitalId: formData.hospitalId,
    timestamp: now,
    handoffStatus: 'inbound',

    // Medic session fields
    medicUnit: session.medicUnit,
    medicUnitType: session.medicUnitType,
    medicName: session.medicName,
    medicPhone: session.medicPhone,

    // Point of origin
    fromOrigin:
      formData.originSource.trim() || formData.originAddress.trim()
        ? {
            source: formData.originSource.trim() || undefined,
            address: formData.originAddress.trim() || undefined,
          }
        : undefined,

    // Edit tracking defaults (backend overwrites on re-submission)
    editCount: 0,
    isEdited: false,

    // Phase 4 Sprint 2.75: ECG serial list
    ecgRecords: [],

    // Sprint 3.3: History arrays — seeded from initial form data
    vitalHistory: hasInitialVitals ? [initialVitalEntry] : undefined,
    assessmentHistory: hasInitialAssess ? [initialAssessEntry] : undefined,
    transportLog: initialLog,

    entry: entries,
  };

  return bundle;
}
