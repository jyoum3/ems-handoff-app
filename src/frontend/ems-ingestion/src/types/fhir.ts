// fhir.ts — FHIR Type Definitions for EMS Ingestion PWA
// =======================================================
// Base: mirrors hospital-dashboard/src/types/fhir.ts.
// Additions: EMS-specific session, chat, app-state types (Phase 4).
// Phase 4 Sprint 2.5: AssessmentResource, new fields on all resource types.

// ---------------------------------------------------------------------------
// Hospital ID Type
// ---------------------------------------------------------------------------
export type HospitalId = 'HUP-PAV' | 'HUP-PRESBY' | 'HUP-CEDAR';

// ---------------------------------------------------------------------------
// FHIR Primitives
// ---------------------------------------------------------------------------

export interface FHIRExtension {
  url: string;
  valueString?: string;
  valueDateTime?: string;
}

export interface ValueQuantity {
  value?: number;
  unit?: string;
  system?: string;
  code?: string;
}

export interface CodeableConcept {
  text?: string;
}

// ---------------------------------------------------------------------------
// Patient Resource
// ---------------------------------------------------------------------------

export interface HumanName {
  family?: string;
  given?: string[];
}

export interface ContactTelecom {
  system?: string;
  value?: string;
}

export interface ContactName {
  text?: string;          // legacy full-name field (backward compat)
  family?: string;        // Phase 4 Sprint 2.5: emergency contact last name
  given?: string;         // Phase 4 Sprint 2.5: emergency contact first name
}

export interface ContactRelationship {
  text?: string;
}

export interface PatientContact {
  name?: ContactName;
  telecom?: ContactTelecom[];
  relationship?: ContactRelationship[];
}

export interface PatientResource {
  resourceType: 'Patient';
  name?: HumanName[];
  gender?: string;
  birthDate?: string;
  computed_age?: number;
  extension?: FHIRExtension[];
  contact?: PatientContact[];
  medications?: string[];
  // Phase 4 Sprint 2.5
  codeStatus?: 'Full Code' | 'DNR' | 'DNI' | 'DNR/DNI';
  alertBadges?: string[];
}

// ---------------------------------------------------------------------------
// Encounter Resource
// ---------------------------------------------------------------------------

export interface EncounterPeriod {
  end?: string;
}

export interface EncounterResource {
  resourceType: 'Encounter';
  status?: string;
  priority?: CodeableConcept;
  reasonCode?: CodeableConcept[];
  period?: EncounterPeriod;
  extension?: FHIRExtension[];
  resourceRequirements?: string[];
  interventions?: string[];
  // Phase 4 Sprint 2.5
  sceneNotes?: string[];
  // Phase 4 Sprint 2.75
  encounterTypes?: Array<'Medical' | 'Trauma' | 'Behavioral' | 'OB-GYN' | 'Pediatric'>;
  // Sprint 3.3: transportNotes removed — replaced by FHIRBundle.transportLog[]
}

// ---------------------------------------------------------------------------
// Observation Resource
// ---------------------------------------------------------------------------

export interface ObservationComponent {
  code: CodeableConcept;
  valueQuantity?: ValueQuantity;
  valueString?: string;
  unit?: string;
  // Phase 4 Sprint 2.5: contextual metadata
  location?: string;       // BP: "Right Arm"/"Left Arm"/etc. | Temp: "Oral"/"Axillary"/etc.
  orientation?: string;    // BP: "Lying"/"Sitting"/"Standing"
  device?: string;         // SpO2: "Nasal Cannula"/"Non-Rebreather"/"Room Air"/etc.
  flowRate?: number;       // SpO2 O2 flow rate L/min
}

export interface ObservationNote {
  text?: string;
}

export interface ObservationResource {
  resourceType: 'Observation';
  status?: string;
  code?: CodeableConcept;
  component?: ObservationComponent[];
  note?: ObservationNote[];
  // Phase 4 Sprint 2.5
  observationType?: 'initial' | 'current';
  height?: number;         // estimated inches
  weight?: number;         // estimated lbs
  // Phase 4 Sprint 2.75
  pain?: number;           // NRS 0-10
  // Phase 4 Sprint 3: vital timestamps stored as extensions
  extension?: FHIRExtension[];
}

// ---------------------------------------------------------------------------
// Assessment Resource — Phase 4 Sprint 2.5
// ---------------------------------------------------------------------------

export interface AssessmentResource {
  resourceType: 'Assessment';
  // Neuro
  mentalStatus?: 'Alert' | 'Voice' | 'Pain' | 'Unresponsive';
  gcs?: number;
  orientation?: string[];           // subset of ['Person','Place','Time','Situation']
  pupils?: string;
  motorLeft?: string;
  motorRight?: string;
  speech?: 'Clear' | 'Slurred' | 'Aphasic' | 'Non-verbal';
  // Physical
  airway?: 'Patent' | 'Obstructed' | 'Managed';
  lungSounds?: string[];
  skin?: string[];
  pertinentNegatives?: string[];
}

// ---------------------------------------------------------------------------
// Bundle Entry / Root Bundle
// ---------------------------------------------------------------------------

export type FHIRResource = PatientResource | EncounterResource | ObservationResource | AssessmentResource;

export interface BundleEntry {
  resource: FHIRResource;
}

export interface FromOrigin {
  source?: string;
  address?: string;
}

// ── Phase 4 Sprint 2.75: EcgRecord ───────────────────────────────────────────
export interface EcgRecord {
  url: string;
  timestamp: string;                    // ISO8601 UTC
  label: string;                        // "Initial" | "Update HH:MM"
  rhythmInterpretation?: string;        // e.g. "Normal Sinus", "ST Elevation V1-V4"
  blobKey?: string;                     // Sprint 3.2 — "ecg-{epoch_ms}.{ext}" — unique blob filename
}

export interface FHIRBundle {
  resourceType: 'Bundle';
  id: string;
  hospitalId: string;
  timestamp: string;
  handoffStatus: 'inbound' | 'arrived' | 'diverted';
  medicUnit?: number;
  medicUnitType?: 'ALS' | 'BLS';   // Phase 4 Sprint 2.5
  medicName?: string;
  medicPhone?: string;
  fromOrigin?: FromOrigin;
  arrivedAt?: string;
  entry: BundleEntry[];
  // Phase 4 Sprint 1: edit tracking
  editCount?: number;
  isEdited?: boolean;
  lastEditedAt?: string;
  // Phase 4 Sprint 2.75: ECG serial list (replaces ecgUploaded + ecgBlobUrl)
  ecgRecords?: EcgRecord[];             // ordered list; [] means no ECG uploaded
  // Phase 4 Sprint 3.3: immutable history arrays
  vitalHistory?: VitalSignEntry[];       // replaces current Observation entry
  assessmentHistory?: AssessmentEntry[]; // replaces Assessment bundle entry
  transportLog?: TransportLogEntry[];    // replaces EncounterResource.transportNotes
}

// ── Phase 4 Sprint 3.3: History Entry Types ──────────────────────────────────

// Each EMS reassessment appends one immutable VitalSignEntry.
// index 0 = Initial (locked), index 1+ = Update N.
export interface VitalSignEntry {
  timestamp: string;       // ISO string — "HH:MM:SS · Mon DD" for display
  label: string;           // "Initial" | "Update 1" | "Update 2" ...
  hr?: string;
  bp?: string;
  rr?: string;
  spo2?: string;
  spo2Device?: string;
  spo2FlowRate?: string;
  temp?: string;
  tempLocation?: string;
  gcs?: string;
  sugar?: string;
  height?: string;
  weight?: string;
  pain?: number;           // NRS 0–10
}

// Each EMS reassessment appends one immutable AssessmentEntry.
export interface AssessmentEntry {
  timestamp: string;       // ISO string
  label: string;           // "Initial" | "Update 1" ...
  avpu?: string;
  orientation?: string[];
  pupils?: string;
  motorLeft?: string;
  motorRight?: string;
  speech?: string;
  airway?: string;
  lungSounds?: string[];
  skin?: string[];
  pertinentNegatives?: string[];
}

// Typed, append-only transport log replacing the plain string transportNotes.
export type TransportLogEntryType =
  | 'note'
  | 'vitals_update'
  | 'assessment_update'
  | 'ecg_upload';

export interface TransportLogEntry {
  timestamp: string;            // ISO string — displayed as HH:MM:SS
  type: TransportLogEntryType;
  autoSummary?: string;         // System-generated: "HR 88 | BP 160/95 | SpO₂ 99%"
  medicComment?: string;        // Optional free text from medic
  refIndex?: number;            // Which vitalHistory / assessmentHistory / ecgRecord this references
}

// ---------------------------------------------------------------------------
// EMS-specific types (Phase 4)
// ---------------------------------------------------------------------------

export interface EmsSession {
  medicUnit: number;
  medicUnitType: 'ALS' | 'BLS';   // Phase 4 Sprint 2.5
  medicName: string;
  medicPhone: string;      // XXX-XXX-XXXX format
  shiftStartedAt: string;  // ISO 8601 — for 12hr expiry check
}

export interface ChatMessage {
  messageId: string;
  text: string;
  authorRole: string;      // e.g., "MEDIC-55", "CHARGE"
  authorName: string;
  authorSource: 'EMS' | 'HOSPITAL';
  createdAt: string;       // ISO 8601 UTC
}

export type ChatThread = ChatMessage[];

export type AppState = 'idle' | 'submitted' | 'arrived';

// ---------------------------------------------------------------------------
// Chat color constants
// ---------------------------------------------------------------------------
export const EMS_COLOR = '#F97316';       // EMS orange — all medic messages
export const HOSPITAL_COLORS: Record<string, string> = {
  CHARGE: '#C084FC',
  PFC: '#60A5FA',
  INTAKE: '#34D399',
};
