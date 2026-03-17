// fhir.ts — FHIR Type Definitions for Hospital Dashboard
// ========================================================
// Phase 4 Sprint 2.5: Added AssessmentResource, new fields on all resources.
// All changes additive — zero breaking changes to existing display logic.

// ---------------------------------------------------------------------------
// Hospital / App-specific types
// ---------------------------------------------------------------------------

export type HospitalId = 'HUP-PAV' | 'HUP-PRESBY' | 'HUP-CEDAR';

// Role color map used by CommentCell, HospitalBanner, PatientDetailModal, etc.
// Keys MUST match UserRole values defined in hooks/useUser.ts
export const ROLE_COLORS: Record<string, string> = {
  'CHARGE':    '#C084FC', // violet     — highest clinical authority
  'PFC':       '#60A5FA', // cornflower — patient flow coordinator
  'INTAKE':    '#34D399', // emerald    — actively processing patients
  'GENERAL-1': '#94A3B8', // slate      — read-only access
  'GENERAL-2': '#94A3B8', // slate      — read-only access
}

// keyed by bundleId
export type CommentMap = Record<string, HospitalComment[]>

export interface HospitalComment {
  commentId: string;
  bundleId: string;
  hospitalId: string;
  text: string;
  authorRole: string;
  authorName: string;
  createdAt: string;   // ISO 8601 UTC
  isEdited?: boolean;
  editedAt?: string;
}

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
  location?: string;       // BP location or Temp location
  orientation?: string;    // BP orientation
  device?: string;         // SpO2 device
  flowRate?: number;       // SpO2 flow rate L/min
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
}

// ---------------------------------------------------------------------------
// Assessment Resource — Phase 4 Sprint 2.5
// ---------------------------------------------------------------------------

export interface AssessmentResource {
  resourceType: 'Assessment';
  // Neuro
  mentalStatus?: 'Alert' | 'Voice' | 'Pain' | 'Unresponsive';
  gcs?: number;
  orientation?: string[];
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

// ── Phase 4 Sprint 4.1: Bidirectional Chat ────────────────────────────────────
export interface ChatMessage {
  messageId: string;
  text: string;
  authorRole: string;        // e.g., "MEDIC-55", "CHARGE", "PFC"
  authorName: string;
  authorSource: 'EMS' | 'HOSPITAL';
  createdAt: string;         // ISO8601 UTC
}

export type ChatThread = ChatMessage[];

/** keyed by bundleId → ChatMessage[] */
export type ChatMap = Record<string, ChatMessage[]>;

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
