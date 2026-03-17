/**
 * LiveHandoffView.tsx — Post-Submission Medic Command Center
 * ===========================================================
 * Phase 4 Sprint 3.3 — History Array Architecture
 *
 * Key changes from Sprint 3.3:
 *   - vitalHistory[], assessmentHistory[], transportLog[] replace
 *     the single-overwrite currentObservation / transportNotes pattern
 *   - Section 3: renders full vitalHistory[] with 🔒 Initial + ● CURRENT
 *   - Section 5: renders full assessmentHistory[] with same pattern
 *   - Section 2: Transport Log displays typed TransportLogEntry[] with
 *     type-prefixed labels (vitals_update, assessment_update, ecg_upload, note)
 *   - handleSectionSave preserves all three history arrays from currentBundle
 *   - handleAddVitals / handleAddAssessment / handleAddFreeNote replace
 *     the old handleAddTransportNote pattern
 *
 * Real-time architecture:
 *   Medic taps [Save] → buildFHIRBundle → POST /api/ems-to-db (upsert)
 *   → Cosmos Change Feed → SignalR broadcast → hospital dashboard updates
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import type {
  FHIRBundle, EmsSession, EcgRecord, ChatMessage,
  PatientResource, EncounterResource, ObservationResource, AssessmentResource,
  VitalSignEntry, AssessmentEntry, TransportLogEntry,
} from '../../types/fhir';
import {
  buildFHIRBundle,
  buildVitalSignEntry,
  buildAssessmentEntry,
  buildVitalsAutoSummary,
  buildAssessmentAutoSummary,
  type PatientFormData,
} from '../../utils/fhirBuilder';
import { submitHandoff, arrivePatient } from '../../services/api';
import { useEmsSignalR } from '../../hooks/useEmsSignalR';
import type { SignalRConnectionState } from '../../hooks/useEmsSignalR';

import EditableSection from './EditableSection';
import EcgViewer from '../EcgViewer/EcgViewer';
import ChatHub from '../ChatHub/ChatHub';
import DivertModal from '../DivertModal/DivertModal';
import HospitalArrivedNotification from '../HospitalArrivedNotification/HospitalArrivedNotification';

import IdentificationSection from '../PatientForm/IdentificationSection';
import ChiefComplaintSection from '../PatientForm/ChiefComplaintSection';
import VitalsSection from '../PatientForm/VitalsSection';
import AssessmentSection from '../PatientForm/AssessmentSection';
import InterventionsSection from '../PatientForm/InterventionsSection';
import HistorySection from '../PatientForm/HistorySection';
import OriginSection from '../PatientForm/OriginSection';

import styles from './LiveHandoffView.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface LiveHandoffViewProps {
  bundle: FHIRBundle;
  bundleId: string;
  hospitalId: string;
  session: EmsSession;
  onVitalsUpdated: (updatedBundle: FHIRBundle) => void;
  onArrived: () => void;
  onDiverted: (newBundle: FHIRBundle) => void;
  /** Callback so App.tsx can bubble real connection state up to EmsBanner */
  onConnectionStateChange?: (state: SignalRConnectionState) => void;
  /** Sprint 4.1: Callback so App.tsx can bubble lastSyncAt up to EmsBanner for stale guard */
  onLastSyncChange?: (t: Date | null) => void;
}

// ---------------------------------------------------------------------------
// Bundle extraction helpers
// ---------------------------------------------------------------------------

function getPatient(bundle: FHIRBundle): PatientResource | null {
  return (bundle.entry.map((e) => e.resource).find((r) => r.resourceType === 'Patient') as PatientResource) ?? null;
}
function getEncounter(bundle: FHIRBundle): EncounterResource | null {
  return (bundle.entry.map((e) => e.resource).find((r) => r.resourceType === 'Encounter') as EncounterResource) ?? null;
}
function getInitialObs(bundle: FHIRBundle): ObservationResource | null {
  return (bundle.entry.map((e) => e.resource).find(
    (r) => r.resourceType === 'Observation' && (r as ObservationResource).observationType === 'initial',
  ) as ObservationResource) ?? null;
}
function getAssessmentRes(bundle: FHIRBundle): AssessmentResource | null {
  return (bundle.entry.map((e) => e.resource).find((r) => r.resourceType === 'Assessment') as AssessmentResource) ?? null;
}

function getVitalComponent(obs: ObservationResource | null, code: string): string {
  if (!obs?.component) return '';
  const comp = obs.component.find((c) => c.code?.text === code);
  if (!comp) return '';
  if (comp.valueString) return comp.valueString;
  if (comp.valueQuantity?.value !== undefined) return String(comp.valueQuantity.value);
  return '';
}

function getExtension(extensions: { url: string; valueString?: string; valueDateTime?: string }[] | undefined, url: string): string {
  return extensions?.find((e) => e.url === url)?.valueString
    ?? extensions?.find((e) => e.url === url)?.valueDateTime
    ?? '';
}

function getVitalSub(obs: ObservationResource | null, code: string, key: 'device' | 'location' | 'orientation' | 'flowRate'): string {
  if (!obs?.component) return '';
  const comp = obs.component.find((c) => c.code?.text === code);
  if (!comp) return '';
  const val = comp[key];
  return val !== undefined ? String(val) : '';
}

/** Compute abnormal vitals text from initial observation */
/**
 * Standardized vital sign abnormal thresholds — must match fhirHelpers.isVitalAbnormal().
 * HR <50/>120 | BP systolic <90/>179 | RR <11/>21 | SpO2 <90% | Temp <96.8/>100.4 | Sugar <70/>200
 */
function computeAbnormalVitals(obs: ObservationResource | null): string {
  if (!obs) return '';
  const flags: string[] = [];
  const hr = parseFloat(getVitalComponent(obs, 'HR'));
  if (!isNaN(hr) && (hr < 50 || hr > 120)) flags.push(`(!) HR: ${hr} bpm`);
  const bp = getVitalComponent(obs, 'BP');
  if (bp) { const m = bp.match(/^(\d+)/); if (m) { const s = parseInt(m[1]); if (s < 90 || s > 179) flags.push(`(!) BP: ${bp} mmHg`); } }
  const rr = parseFloat(getVitalComponent(obs, 'RR'));
  if (!isNaN(rr) && (rr < 11 || rr > 21)) flags.push(`(!) RR: ${rr} br/min`);
  const spo2 = parseFloat(getVitalComponent(obs, 'SpO2'));
  if (!isNaN(spo2) && spo2 < 90) flags.push(`(!) SpO2: ${spo2}%`);
  const temp = parseFloat(getVitalComponent(obs, 'Temp'));
  if (!isNaN(temp) && (temp < 96.8 || temp > 100.4)) flags.push(`(!) Temp: ${temp}°F`);
  const sugar = parseFloat(getVitalComponent(obs, 'Sugar'));
  if (!isNaN(sugar) && (sugar < 70 || sugar > 200)) flags.push(`(!) Sugar: ${sugar} mg/dL`);
  return flags.join(' | ');
}

function formatDate(iso: string): string {
  if (!iso || iso === 'Unknown') return iso || '—';
  try {
    const d = new Date(iso);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${mm}/${dd}/${yyyy} ${hh}:${min}`;
  } catch { return iso; }
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch { return iso; }
}

function formatPatientName(patient: PatientResource | null): string {
  if (!patient?.name?.[0]) return 'Unknown Patient';
  const n = patient.name[0];
  const family = (n.family ?? '').toUpperCase();
  const given = n.given?.[0] ?? '';
  if (family && given) return `${family}, ${given}`;
  return family || given || 'Unknown Patient';
}

function formatETA(iso: string | undefined): { text: string; minutesText: string; overdue: boolean } {
  if (!iso) return { text: '—', minutesText: '', overdue: false };
  try {
    const d = new Date(iso);
    const now = new Date();
    const overdue = d < now;
    const diffMs = d.getTime() - now.getTime();
    const diffMin = Math.round(Math.abs(diffMs) / 60000);
    const minutesText = overdue ? `${diffMin} min ago` : `~${diffMin} min`;
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return { text: `${mm}/${dd} ${hh}:${min}`, minutesText, overdue };
  } catch { return { text: '—', minutesText: '', overdue: false }; }
}

// ---------------------------------------------------------------------------
// bundleToFormData — reverse map bundle → PatientFormData for edit pre-pop
// Sprint 3.3: removed transportNotes; *Current fields default to '' since
// there is no longer a currentObservation in the bundle.
// ---------------------------------------------------------------------------

function bundleToFormData(bundle: FHIRBundle): PatientFormData {
  const patient = getPatient(bundle);
  const encounter = getEncounter(bundle);
  const initialObs = getInitialObs(bundle);
  const assessment = getAssessmentRes(bundle);

  const pExt = patient?.extension ?? [];
  const eExt = encounter?.extension ?? [];

  const contact = patient?.contact?.[0];

  return {
    // Identification
    isUnknownPatient: patient?.name?.[0]?.family === 'Unknown',
    familyName: patient?.name?.[0]?.family ?? '',
    givenName: patient?.name?.[0]?.given?.[0] ?? '',
    birthDate: patient?.birthDate ?? '',
    gender: patient?.gender ?? '',
    codeStatus: patient?.codeStatus ?? '',
    alertBadges: patient?.alertBadges ?? [],
    emergencyContactFamily: contact?.name?.family ?? '',
    emergencyContactGiven: contact?.name?.given ?? '',
    emergencyContactPhone: contact?.telecom?.[0]?.value ?? '',
    emergencyContactRelationship: contact?.relationship?.[0]?.text ?? '',
    // Chief Complaint
    chiefComplaint: encounter?.reasonCode?.[0]?.text ?? '',
    esiLevel: encounter?.priority?.text ?? '',
    triageNote: initialObs?.note?.[0]?.text ?? '',
    lastKnownWell: getExtension(eExt, 'lkw') || 'Unknown',
    onsetTime: getExtension(eExt, 'onset-time') || 'Unknown',
    emsContactTime: getExtension(eExt, 'ems-contact-time'),
    arrivalEta: encounter?.period?.end ?? '',
    encounterTypes: (encounter?.encounterTypes ?? []) as string[],
    // Initial Vitals (locked baseline — pre-populated for form reference, not editable in Section 3)
    hrInitial: getVitalComponent(initialObs, 'HR'),
    bpInitial: getVitalComponent(initialObs, 'BP'),
    bpLocationInitial: getVitalSub(initialObs, 'BP', 'location'),
    bpOrientationInitial: getVitalSub(initialObs, 'BP', 'orientation'),
    rrInitial: getVitalComponent(initialObs, 'RR'),
    spo2Initial: getVitalComponent(initialObs, 'SpO2'),
    spo2DeviceInitial: getVitalSub(initialObs, 'SpO2', 'device'),
    spo2FlowRateInitial: getVitalSub(initialObs, 'SpO2', 'flowRate'),
    tempInitial: getVitalComponent(initialObs, 'Temp'),
    tempLocationInitial: getVitalSub(initialObs, 'Temp', 'location'),
    sugarInitial: getVitalComponent(initialObs, 'Sugar'),
    height: initialObs?.height !== undefined ? String(initialObs.height) : '',
    weight: initialObs?.weight !== undefined ? String(initialObs.weight) : '',
    painInitial: initialObs?.pain !== undefined ? String(initialObs.pain) : '',
    // Current (Sprint 3.3: no currentObservation in bundle — always blank for add-entry form)
    hrCurrent: '',
    bpCurrent: '',
    bpLocationCurrent: '',
    bpOrientationCurrent: '',
    rrCurrent: '',
    spo2Current: '',
    spo2DeviceCurrent: '',
    spo2FlowRateCurrent: '',
    tempCurrent: '',
    tempLocationCurrent: '',
    sugarCurrent: '',
    heightCurrent: '',
    weightCurrent: '',
    painCurrent: '',
    gcsCurrent: '',
    // Assessment
    mentalStatus: assessment?.mentalStatus ?? '',
    gcs: assessment?.gcs !== undefined ? String(assessment.gcs) : '',
    orientation: assessment?.orientation ?? [],
    pupils: assessment?.pupils ?? '',
    motorLeft: assessment?.motorLeft ?? '',
    motorRight: assessment?.motorRight ?? '',
    speech: assessment?.speech ?? '',
    airway: assessment?.airway ?? '',
    lungSounds: assessment?.lungSounds ?? [],
    skin: assessment?.skin ?? [],
    pertinentNegatives: assessment?.pertinentNegatives ?? [],
    // Interventions
    interventions: encounter?.interventions ?? [],
    resourceRequirements: encounter?.resourceRequirements ?? [],
    // History
    allergies: getExtension(pExt, 'allergies').split(', ').filter(Boolean),
    medications: patient?.medications ?? [],
    knownHistory: getExtension(pExt, 'known-history').split(', ').filter(Boolean),
    lastOralIntake: getExtension(pExt, 'last-oral-intake'),
    events: getExtension(eExt, 'events'),
    // Origin
    originSource: bundle.fromOrigin?.source ?? '',
    originAddress: bundle.fromOrigin?.address ?? '',
    sceneNotes: encounter?.sceneNotes ?? [],
    // Top-level
    hospitalId: bundle.hospitalId,
    isolation: getExtension(pExt, 'isolation'),
    // Sprint 3.3: vital timestamps still preserved for display
    vitalInitialTime: getExtension(initialObs?.extension, 'vital-initial-time'),
    vitalCurrentTime: '',
    // Sprint 3.3: transportNotes REMOVED — transport log is bundle.transportLog[]
  };
}

/**
 * parseTriageNote — mirrors PatientDetailModal.
 * Splits the stored triage note into HPI text and custom clinical text.
 */
function parseTriageNote(note: string | null): { hpiText: string; customClinical: string } {
  if (!note) return { hpiText: '', customClinical: '' };
  const clinicalMarker = 'Clinical Findings/Assessment:';
  const clinicalIdx = note.indexOf(clinicalMarker);
  const hpiBlock = clinicalIdx !== -1 ? note.slice(0, clinicalIdx) : note;
  const hpiMatch = hpiBlock.match(/HPI:\s*([\s\S]*)/);
  const hpiText = hpiMatch ? hpiMatch[1].trim() : hpiBlock.trim();
  if (clinicalIdx === -1) return { hpiText, customClinical: '' };
  const afterClinical = note.slice(clinicalIdx + clinicalMarker.length);
  const customLines: string[] = [];
  for (const line of afterClinical.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('(!)')) continue;
    if (t === 'History:' || /^[AMPLE]\s*-/.test(t)) break;
    customLines.push(line);
  }
  return { hpiText, customClinical: customLines.join('\n').trim() };
}

// ---------------------------------------------------------------------------
// Encounter type styling
// ---------------------------------------------------------------------------

const ENC_TYPE_STYLES: Record<string, { bg: string; border: string; text: string }> = {
  Medical:    { bg: 'rgba(59,130,246,0.15)',  border: '#3b82f6', text: '#60a5fa' },
  Trauma:     { bg: 'rgba(239,68,68,0.15)',   border: '#ef4444', text: '#f87171' },
  Behavioral: { bg: 'rgba(168,85,247,0.15)',  border: '#a855f7', text: '#c084fc' },
  'OB-GYN':   { bg: 'rgba(236,72,153,0.15)',  border: '#ec4899', text: '#f472b6' },
  Pediatric:  { bg: 'rgba(20,184,166,0.15)',  border: '#14b8a6', text: '#2dd4bf' },
};

// ---------------------------------------------------------------------------
// Transport log type styling
// ---------------------------------------------------------------------------

const LOG_TYPE_STYLES: Record<string, { label: string; color: string }> = {
  note:               { label: '📝 Note',             color: '#94a3b8' },
  vitals_update:      { label: '💉 Vitals Update',    color: '#38bdf8' },
  assessment_update:  { label: '🧠 Assessment Update', color: '#c084fc' },
  ecg_upload:         { label: '🫀 ECG Upload',       color: '#fb923c' },
};


// ---------------------------------------------------------------------------
// LiveHandoffView
// ---------------------------------------------------------------------------

export default function LiveHandoffView({
  bundle,
  bundleId,
  hospitalId,
  session,
  onVitalsUpdated,
  onArrived,
  onDiverted,
  onConnectionStateChange,
  onLastSyncChange,
}: LiveHandoffViewProps) {
  const [currentBundle, setCurrentBundle] = useState(bundle);
  const [ecgRecords, setEcgRecords] = useState<EcgRecord[]>(bundle.ecgRecords ?? []);

  // ── Sprint 3.3: History array state ─────────────────────────────────────
  const [vitalHistory, setVitalHistory]       = useState<VitalSignEntry[]>(bundle.vitalHistory ?? []);
  const [assessmentHistory, setAssessmentHistory] = useState<AssessmentEntry[]>(bundle.assessmentHistory ?? []);
  const [transportLog, setTransportLog]       = useState<TransportLogEntry[]>(bundle.transportLog ?? []);

  // ── Sprint 3.3: Add-entry form state ────────────────────────────────────
  const [showAddVitalsForm, setShowAddVitalsForm]   = useState(false);
  const [showAddAssessForm, setShowAddAssessForm]   = useState(false);
  const [addVitalsComment, setAddVitalsComment]     = useState('');
  const [addAssessComment, setAddAssessComment]     = useState('');

  // ── Section edit form state (must be declared before the useCallback handlers
  //    that reference editVitalsForm / editAssessForm) ─────────────────────
  const baseFormData = bundleToFormData(bundle);
  const [editIdForm, setEditIdForm]           = useState<PatientFormData>(baseFormData);
  const [editCcForm, setEditCcForm]           = useState<PatientFormData>(baseFormData);
  const [editVitalsForm, setEditVitalsForm]   = useState<PatientFormData>(baseFormData);
  const [editAssessForm, setEditAssessForm]   = useState<PatientFormData>(baseFormData);
  const [editIntervForm, setEditIntervForm]   = useState<PatientFormData>(baseFormData);
  const [editHistoryForm, setEditHistoryForm] = useState<PatientFormData>(baseFormData);
  const [editOriginForm, setEditOriginForm]   = useState<PatientFormData>(baseFormData);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatExpanded, setIsChatExpanded] = useState(false);
  const [showDivertModal, setShowDivertModal] = useState(false);
  const [showArriveConfirm, setShowArriveConfirm] = useState(false);
  const [showHospitalArrived, setShowHospitalArrived] = useState(false);
  const [flashTarget, setFlashTarget] = useState<{ sectionId: string; fieldId: string } | null>(null);
  const [transportInput, setTransportInput] = useState('');
  const [isArrivingPatient, setIsArrivingPatient] = useState(false);

  // Section-level saving states
  const [savingSection, setSavingSection] = useState<string | null>(null);
  const [isAddingNote, setIsAddingNote] = useState(false);

  // Refs for scroll-to navigation
  const sectionRefs = useRef<Record<string, React.RefObject<HTMLDivElement | null>>>({});
  function getSectionRef(id: string): React.RefObject<HTMLDivElement | null> {
    if (!sectionRefs.current[id]) {
      sectionRefs.current[id] = { current: null };
    }
    return sectionRefs.current[id];
  }

  // Refs for auto-scroll to Add Vitals / Add Assessment forms when they open
  const addVitalsFormRef = useRef<HTMLDivElement>(null);
  const addAssessFormRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showAddVitalsForm) {
      const t = setTimeout(() => {
        addVitalsFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
      return () => clearTimeout(t);
    }
  }, [showAddVitalsForm]);

  useEffect(() => {
    if (showAddAssessForm) {
      const t = setTimeout(() => {
        addAssessFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
      return () => clearTimeout(t);
    }
  }, [showAddAssessForm]);

  // ── SignalR ──────────────────────────────────────────────────────────────
  const { connectionState, reconnect, lastSyncAt } = useEmsSignalR(
    bundleId,
    useCallback((data) => {
      if (data.action === 'arrived_by_hospital') setShowHospitalArrived(true);
      if (data.action === 'restored') setShowHospitalArrived(false);
    }, []),
    useCallback((data) => {
      if (data.bundleId === bundleId) setChatMessages(data.allMessages);
    }, [bundleId]),
  );

  // Bubble connection state up to App.tsx → EmsBanner (replaces hardcoded placeholder)
  useEffect(() => {
    onConnectionStateChange?.(connectionState);
  }, [connectionState, onConnectionStateChange]);

  // Sprint 4.1: Bubble lastSyncAt up to App.tsx → EmsBanner for stale data guard
  useEffect(() => {
    onLastSyncChange?.(lastSyncAt);
  }, [lastSyncAt, onLastSyncChange]);

  // ── Section save helper ──────────────────────────────────────────────────
  // Sprint 3.3: Preserves all three history arrays + ecgRecords from currentBundle.
  // These are NOT rebuilt from formData — only the FHIR entry resources are rebuilt.
  const handleSectionSave = useCallback(async (
    updatedFormData: PatientFormData,
    sectionId: string,
  ): Promise<void> => {
    setSavingSection(sectionId);
    try {
      // Always use currentBundle.hospitalId — updatedFormData.hospitalId may be stale
      // (edit form states initialize once at mount; after a divert the old hospitalId
      // persists, causing a second Cosmos document in the wrong partition).
      const safeFormData = { ...updatedFormData, hospitalId: currentBundle.hospitalId };
      const updated = buildFHIRBundle(safeFormData, session, bundleId);
      // Restore all array state from the live bundle — never rebuild from formData
      updated.ecgRecords = ecgRecords;
      updated.vitalHistory = currentBundle.vitalHistory;
      updated.assessmentHistory = currentBundle.assessmentHistory;
      updated.transportLog = currentBundle.transportLog;
      // Preserve edit tracking
      updated.editCount = (currentBundle.editCount ?? 0) + 1;
      updated.isEdited = true;
      await submitHandoff(updated);
      setCurrentBundle(updated);
      onVitalsUpdated(updated);
    } finally {
      setSavingSection(null);
    }
  }, [session, bundleId, ecgRecords, currentBundle, onVitalsUpdated]);

  // ── Sprint 3.3: Add free-text transport note ─────────────────────────────
  // Replaces old handleAddTransportNote. Appends a typed TransportLogEntry
  // of type "note" to transportLog[].
  const handleAddFreeNote = useCallback(async () => {
    if (isAddingNote || !transportInput.trim()) return;
    setIsAddingNote(true);

    const logEntry: TransportLogEntry = {
      timestamp: new Date().toISOString(),
      type: 'note',
      medicComment: transportInput.trim(),
    };
    const newLog = [...transportLog, logEntry];

    try {
      const fd = bundleToFormData(currentBundle);
      const updated = buildFHIRBundle(fd, session, bundleId);
      updated.ecgRecords = ecgRecords;
      updated.vitalHistory = currentBundle.vitalHistory;
      updated.assessmentHistory = currentBundle.assessmentHistory;
      updated.transportLog = newLog;
      updated.editCount = (currentBundle.editCount ?? 0) + 1;
      updated.isEdited = true;

      await submitHandoff(updated);
      setCurrentBundle(updated);
      setTransportLog(newLog);
      setTransportInput('');
      onVitalsUpdated(updated);
    } catch {
      // Non-blocking
    } finally {
      setTimeout(() => setIsAddingNote(false), 3000);
    }
  }, [isAddingNote, transportInput, transportLog, ecgRecords, currentBundle, session, bundleId, onVitalsUpdated]);

  // ── Sprint 3.3: Add Vitals Update ────────────────────────────────────────
  // Builds new VitalSignEntry from editVitalsForm (current fields),
  // appends to vitalHistory[], auto-generates transport log entry.
  const handleAddVitals = useCallback(async () => {
    setSavingSection('vitals');
    try {
      const timeLabel = new Date().toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const newEntry = buildVitalSignEntry(editVitalsForm, `Update ${timeLabel}`);
      const autoSummary = buildVitalsAutoSummary(newEntry);
      const newHistory = [...vitalHistory, newEntry];
      const refIndex = newHistory.length - 1;

      const logEntry: TransportLogEntry = {
        timestamp: newEntry.timestamp,
        type: 'vitals_update',
        autoSummary: autoSummary || undefined,
        medicComment: addVitalsComment.trim() || undefined,
        refIndex,
      };
      const newLog = [...transportLog, logEntry];

      const fd = bundleToFormData(currentBundle);
      const updated = buildFHIRBundle(fd, session, bundleId);
      updated.ecgRecords = ecgRecords;
      updated.vitalHistory = newHistory;
      updated.assessmentHistory = currentBundle.assessmentHistory;
      updated.transportLog = newLog;
      updated.editCount = (currentBundle.editCount ?? 0) + 1;
      updated.isEdited = true;

      await submitHandoff(updated);
      setCurrentBundle(updated);
      setVitalHistory(newHistory);
      setTransportLog(newLog);
      setShowAddVitalsForm(false);
      setAddVitalsComment('');
      // Reset current vitals form fields
      setEditVitalsForm((prev) => ({
        ...prev,
        hrCurrent: '', bpCurrent: '', bpLocationCurrent: '', bpOrientationCurrent: '',
        rrCurrent: '', spo2Current: '', spo2DeviceCurrent: '', spo2FlowRateCurrent: '',
        tempCurrent: '', tempLocationCurrent: '', sugarCurrent: '',
        heightCurrent: '', weightCurrent: '', painCurrent: '', gcsCurrent: '',
      }));
      onVitalsUpdated(updated);
    } finally {
      setSavingSection(null);
    }
  }, [editVitalsForm, addVitalsComment, vitalHistory, assessmentHistory, transportLog, ecgRecords, currentBundle, session, bundleId, onVitalsUpdated]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sprint 3.3: Add Assessment Update ───────────────────────────────────
  // Builds new AssessmentEntry from editAssessForm,
  // appends to assessmentHistory[], auto-generates transport log entry.
  const handleAddAssessment = useCallback(async () => {
    setSavingSection('assessment');
    try {
      const timeLabel = new Date().toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const newEntry = buildAssessmentEntry(editAssessForm, `Update ${timeLabel}`);
      const autoSummary = buildAssessmentAutoSummary(newEntry);
      const newHistory = [...assessmentHistory, newEntry];
      const refIndex = newHistory.length - 1;

      const logEntry: TransportLogEntry = {
        timestamp: newEntry.timestamp,
        type: 'assessment_update',
        autoSummary: autoSummary || undefined,
        medicComment: addAssessComment.trim() || undefined,
        refIndex,
      };
      const newLog = [...transportLog, logEntry];

      const fd = bundleToFormData(currentBundle);
      const updated = buildFHIRBundle(fd, session, bundleId);
      updated.ecgRecords = ecgRecords;
      updated.vitalHistory = currentBundle.vitalHistory;
      updated.assessmentHistory = newHistory;
      updated.transportLog = newLog;
      updated.editCount = (currentBundle.editCount ?? 0) + 1;
      updated.isEdited = true;

      await submitHandoff(updated);
      setCurrentBundle(updated);
      setAssessmentHistory(newHistory);
      setTransportLog(newLog);
      setShowAddAssessForm(false);
      setAddAssessComment('');
      onVitalsUpdated(updated);
    } finally {
      setSavingSection(null);
    }
  }, [editAssessForm, addAssessComment, vitalHistory, assessmentHistory, transportLog, ecgRecords, currentBundle, session, bundleId, onVitalsUpdated]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── ECG rhythm save ──────────────────────────────────────────────────────
  // Sprint 3.3: preserves transportLog (not transportNotes)
  const handleEcgRhythmSave = useCallback(async (updatedRecords: EcgRecord[]) => {
    setEcgRecords(updatedRecords);
    const formData = bundleToFormData(currentBundle);
    const updated = buildFHIRBundle(formData, session, bundleId);
    updated.ecgRecords = updatedRecords;
    updated.vitalHistory = currentBundle.vitalHistory;
    updated.assessmentHistory = currentBundle.assessmentHistory;
    updated.transportLog = currentBundle.transportLog;
    await submitHandoff(updated);
    setCurrentBundle(updated);
    onVitalsUpdated(updated);
  }, [currentBundle, session, bundleId, onVitalsUpdated]);

  // ── ECG upload ───────────────────────────────────────────────────────────
  const handleEcgUploaded = useCallback(async (rec: EcgRecord) => {
    const updated = [...ecgRecords, rec];
    setEcgRecords(updated);
    // Auto-append ecg_upload transport log entry
    const logEntry: TransportLogEntry = {
      timestamp: rec.timestamp,
      type: 'ecg_upload',
      autoSummary: `ECG uploaded: ${rec.label}`,
      medicComment: rec.rhythmInterpretation || undefined,
      refIndex: updated.length - 1,
    };
    const newLog = [...transportLog, logEntry];
    setTransportLog(newLog);
    const updatedBundle = {
      ...currentBundle,
      ecgRecords: updated,
      transportLog: newLog,
    };
    // Persist transport log entry to Cosmos so hospital dashboard reflects it.
    // ECG blob is already committed at this point — failure here is non-blocking.
    try {
      await submitHandoff(updatedBundle);
    } catch {
      // Non-blocking: transport log persists locally even if persist fails
    }
    setCurrentBundle(updatedBundle);
    onVitalsUpdated(updatedBundle);
  }, [ecgRecords, transportLog, currentBundle, onVitalsUpdated]);

  // ── ECG delete ───────────────────────────────────────────────────────────
  const handleEcgDelete = useCallback((idx: number) => {
    const updated = ecgRecords.filter((_, i) => i !== idx);
    setEcgRecords(updated);
    const updatedBundle = { ...currentBundle, ecgRecords: updated };
    setCurrentBundle(updatedBundle);
    onVitalsUpdated(updatedBundle);
  }, [ecgRecords, currentBundle, onVitalsUpdated]);

  // ── Arrive patient ───────────────────────────────────────────────────────
  const handleConfirmArrive = useCallback(async () => {
    setIsArrivingPatient(true);
    try {
      await arrivePatient(bundleId, hospitalId);
      onArrived();
    } catch {
      setIsArrivingPatient(false);
      setShowArriveConfirm(false);
    }
  }, [bundleId, hospitalId, onArrived]);

  // ── Divert success ───────────────────────────────────────────────────────
  const handleDiverted = useCallback((newBundle: FHIRBundle) => {
    setShowDivertModal(false);
    setCurrentBundle(newBundle);
    onDiverted(newBundle);
    reconnect(bundleId);
  }, [onDiverted, reconnect, bundleId]);

  // ── Data extraction (from current live bundle) ───────────────────────────
  const patient = getPatient(currentBundle);
  const encounter = getEncounter(currentBundle);
  const initialObs = getInitialObs(currentBundle);
  const assessment = getAssessmentRes(currentBundle);

  const patientName = formatPatientName(patient);
  const eta = formatETA(encounter?.period?.end);
  const abnormalInitial = computeAbnormalVitals(initialObs);
  const { hpiText, customClinical } = parseTriageNote(initialObs?.note?.[0]?.text ?? null);
  const pertinentNegatives = assessment?.pertinentNegatives ?? [];

  // ── Base form data for edits ─────────────────────────────────────────────
  function makeEditHandler(setter: React.Dispatch<React.SetStateAction<PatientFormData>>) {
    return (field: keyof PatientFormData, value: PatientFormData[keyof PatientFormData]) => {
      setter((prev) => ({ ...prev, [field]: value }));
    };
  }

  // Fix 8: Section 2 onChange — block triageNote edits.
  const handleCcFieldChange = useCallback((
    field: keyof PatientFormData,
    value: PatientFormData[keyof PatientFormData],
  ) => {
    if (field === 'triageNote') return;
    setEditCcForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.container}>
      {/* ── Header Bar ───────────────────────────────────────────── */}
      {/* Flat flex row: [ALS/BLS] [Unit #N] [SMITH, John] → [HUP-CEDAR] [ETA date time ~Xmin] [🔴 Inbound] */}
      {/* patientName has no flex:1 so the cluster sits immediately after the name.                           */}
      {/* connectionDot removed — EmsBanner already shows connection status.                                  */}
      <div className={styles.headerBar}>
        <span className={`${styles.alsPill} ${session.medicUnitType === 'ALS' ? styles.alsPillAls : styles.alsPillBls}`}>
          {session.medicUnitType}
        </span>
        <span className={styles.unitName}>Unit #{session.medicUnit}</span>
        <span className={styles.patientName}>{patientName}</span>
        <span className={styles.arrow}>→</span>
        <span className={styles.hospitalLabel}>{currentBundle.hospitalId}</span>
        <span className={`${styles.etaLabel} ${eta.overdue ? styles.etaOverdue : styles.etaNormal}`}>
          ETA: {eta.text}{eta.minutesText ? ` · ${eta.minutesText}` : ''}
        </span>
        <span className={styles.statusPill}>🔴 Inbound</span>
      </div>

      {/* ── Scrollable Sections ──────────────────────────────────── */}
      <div className={styles.scrollContent}>

        {/* ── Section 1: Identification & Alerts ─────────────────── */}
        <EditableSection
          sectionId="identification"
          title="1. Identification & Alerts"
          sectionRef={getSectionRef('identification')}
          onSave={async () => {
            await handleSectionSave({ ...editIdForm }, 'identification');
            setEditIdForm(bundleToFormData(currentBundle));
          }}
          onEditOpen={() => setEditIdForm(bundleToFormData(currentBundle))}
          isSaving={savingSection === 'identification'}
          editForm={<IdentificationSection data={editIdForm} onChange={makeEditHandler(setEditIdForm)} />}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div className={styles.fieldReadRow}>
              <span className={styles.fieldReadLabel}>Name:</span>
              <span className={styles.fieldReadValue}>{patientName}</span>
            </div>
            {patient?.birthDate && patient.birthDate !== '1880-01-01' && (
              <div className={styles.fieldReadRow}>
                <span className={styles.fieldReadLabel}>DOB:</span>
                <span className={styles.fieldReadValue}>
                  {patient.birthDate}
                  {patient.computed_age !== undefined ? ` · Age: ${patient.computed_age}` : ''}
                </span>
              </div>
            )}
            <div className={styles.fieldReadRow}>
              <span className={styles.fieldReadLabel}>Gender:</span>
              <span className={styles.fieldReadValue}>{patient?.gender ?? '—'}</span>
            </div>
            {patient?.codeStatus && (
              <div className={styles.fieldReadRow}>
                <span className={styles.fieldReadLabel}>Code Status:</span>
                <span className={styles.fieldReadValue}>
                  <span className={`${styles.codeStatusBadge} ${patient.codeStatus === 'Full Code' ? styles.codeStatusFull : styles.codeStatusDnr}`}>
                    {patient.codeStatus === 'Full Code' ? '🟢' : '🔴'} {patient.codeStatus}
                  </span>
                </span>
              </div>
            )}
            {patient?.alertBadges && patient.alertBadges.length > 0 && (
              <div className={styles.fieldReadRow}>
                <span className={styles.fieldReadLabel}>Alerts:</span>
                <span className={styles.fieldReadValue}>
                  <div className={styles.chipList}>
                    {patient.alertBadges.map((a, i) => (
                      <span key={i} className={styles.alertChip}>⚡ {a}</span>
                    ))}
                  </div>
                </span>
              </div>
            )}
            {patient?.contact?.[0] && (
              <div className={styles.fieldReadRow}>
                <span className={styles.fieldReadLabel}>Emergency Contact:</span>
                <span className={styles.fieldReadValue}>
                  {[patient.contact[0].name?.family, patient.contact[0].name?.given].filter(Boolean).join(', ')}
                  {patient.contact[0].relationship?.[0]?.text ? ` · ${patient.contact[0].relationship[0].text}` : ''}
                  {patient.contact[0].telecom?.[0]?.value ? ` · ${patient.contact[0].telecom[0].value}` : ''}
                </span>
              </div>
            )}
          </div>
        </EditableSection>

        {/* ── Section 2: Chief Complaint & Timeline ─────────────── */}
        <EditableSection
          sectionId="chiefComplaint"
          title="2. Chief Complaint & Timeline"
          sectionRef={getSectionRef('chiefComplaint')}
          flashFieldId={flashTarget?.sectionId === 'chiefComplaint' ? flashTarget.fieldId : null}
          onFlashComplete={() => setFlashTarget(null)}
          onSave={async () => {
            await handleSectionSave({ ...editCcForm }, 'chiefComplaint');
            setEditCcForm(bundleToFormData(currentBundle));
          }}
          onEditOpen={() => setEditCcForm(bundleToFormData(currentBundle))}
          isSaving={savingSection === 'chiefComplaint'}
          editLabel="✏️ Edit Fields"
          editForm={
            <ChiefComplaintSection data={editCcForm} onChange={handleCcFieldChange} />
          }
        >
          {/* Fields block */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '10px' }}>
            {encounter?.encounterTypes && encounter.encounterTypes.length > 0 && (
              <div className={styles.fieldReadRow}>
                <span className={styles.fieldReadLabel}>Type:</span>
                <span className={styles.fieldReadValue}>
                  {encounter.encounterTypes.map((t) => {
                    const s = ENC_TYPE_STYLES[t] ?? ENC_TYPE_STYLES['Medical'];
                    return (
                      <span key={t} className={styles.encBadge} style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.text }}>{t}</span>
                    );
                  })}
                </span>
              </div>
            )}
            {encounter?.priority?.text && (
              <div className={styles.fieldReadRow}>
                <span className={styles.fieldReadLabel}>ESI:</span>
                <span className={styles.fieldReadValue}>{encounter.priority.text}</span>
              </div>
            )}
            {encounter?.reasonCode?.[0]?.text && (
              <div className={styles.fieldReadRow}>
                <span className={styles.fieldReadLabel}>CC:</span>
                <span className={styles.fieldReadValue}>{encounter.reasonCode[0].text}</span>
              </div>
            )}
            <div className={styles.fieldReadRow}>
              <span className={styles.fieldReadLabel}>LKW:</span>
              <span className={styles.fieldReadValue}>{formatDate(baseFormData.lastKnownWell)}</span>
            </div>
            <div className={styles.fieldReadRow}>
              <span className={styles.fieldReadLabel}>Onset:</span>
              <span className={styles.fieldReadValue}>{formatDate(baseFormData.onsetTime)}</span>
            </div>
            {baseFormData.emsContactTime && (
              <div className={styles.fieldReadRow}>
                <span className={styles.fieldReadLabel}>EMS Contact:</span>
                <span className={styles.fieldReadValue}>{formatDate(baseFormData.emsContactTime)}</span>
              </div>
            )}
            {encounter?.period?.end && (
              <div className={styles.fieldReadRow}>
                <span className={styles.fieldReadLabel}>ETA:</span>
                <span className={`${styles.fieldReadValue} ${eta.overdue ? styles.etaOverdue : ''}`}>{eta.text}</span>
              </div>
            )}
          </div>

          {/* ── Triage Narrative — structured format matching hospital PatientDetailModal ── */}
          <div style={{ marginTop: '4px' }}>
            {/* HPI */}
            <div style={{ marginBottom: '10px' }}>
              <span style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>HPI: </span>
              {hpiText && <span style={{ color: '#e2e8f0', fontSize: '13px', whiteSpace: 'pre-wrap' }}>{hpiText}</span>}
            </div>
            {/* Clinical Findings/Assessment */}
            <div style={{ marginBottom: '10px' }}>
              <span style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Clinical Findings/Assessment: </span>
              {customClinical && <span style={{ color: '#e2e8f0', fontSize: '13px', whiteSpace: 'pre-wrap' }}>{customClinical}</span>}
            </div>
            {/* Abnormal vitals — red flags */}
            {abnormalInitial && (
              <div style={{ marginBottom: '10px', fontSize: '13px', lineHeight: 1.6 }}>
                {abnormalInitial.split(' | ').map((flag, i, arr) => (
                  <span key={i}>
                    <span style={{ color: '#f87171', fontWeight: 600 }}>{flag}</span>
                    {i < arr.length - 1 && <span style={{ color: '#e2e8f0' }}> | </span>}
                  </span>
                ))}
              </div>
            )}
            {/* Pertinent Negatives */}
            <div style={{ marginBottom: '10px' }}>
              <span style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Pertinent Negatives: </span>
              {pertinentNegatives.length > 0 && <span style={{ color: '#e2e8f0', fontSize: '13px' }}>{pertinentNegatives.join(', ')}</span>}
            </div>
            {/* AVPU */}
            <div style={{ marginBottom: '10px' }}>
              <span style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>AVPU: </span>
              {assessment?.mentalStatus && <span style={{ color: '#e2e8f0', fontSize: '13px' }}>{assessment.mentalStatus}</span>}
            </div>
            {/* Orientation */}
            <div style={{ marginBottom: '10px' }}>
              <span style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>ORIENTATION: </span>
              {assessment?.orientation && assessment.orientation.length > 0 && (() => {
                const orient = assessment.orientation;
                if (orient.includes('x0 (None)')) return <span style={{ color: '#e2e8f0', fontSize: '13px' }}>AxO x0</span>;
                return <span style={{ color: '#e2e8f0', fontSize: '13px' }}>AxO x{orient.length} ({orient.join(', ')})</span>;
              })()}
            </div>
            {/* Pain Score */}
            <div style={{ marginBottom: '10px' }}>
              <span style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Pain Score: </span>
              <span style={{ color: initialObs?.pain !== undefined ? '#e2e8f0' : '#64748b', fontSize: '13px' }}>
                {initialObs?.pain !== undefined ? `${initialObs.pain}/10` : 'N/A'}
              </span>
            </div>
            {/* AMPLE History */}
            <div style={{ marginTop: '8px' }}>
              <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '4px' }}>History:</div>
              {([
                { key: 'A', value: baseFormData.allergies.join(', ') || '' },
                { key: 'M', value: baseFormData.medications.join(', ') || '' },
                { key: 'P', value: baseFormData.knownHistory.join(', ') || '' },
                { key: 'L', value: baseFormData.lastOralIntake || '' },
                { key: 'E', value: baseFormData.events || '' },
              ] as { key: string; value: string }[]).map(({ key, value }) => (
                <div key={key} style={{ fontSize: '13px', lineHeight: 1.9 }}>
                  <span style={{ color: '#94a3b8', fontWeight: 600 }}>{key} - </span>
                  <span style={{ color: '#e2e8f0' }}>{value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* ── Sprint 3.3: Typed Transport Log ─────────────────── */}
          <div style={{ borderTop: '1px dashed #334155', marginTop: '10px', paddingTop: '10px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: '6px' }}>
              Transport Log
            </div>

            {/* Log entries */}
            {transportLog.length > 0 && (
              <div className={styles.transportLog}>
                {transportLog.map((entry, idx) => {
                  const style = LOG_TYPE_STYLES[entry.type] ?? LOG_TYPE_STYLES['note'];
                  return (
                    <div key={idx} className={styles.transportLogEntry}>
                      <span className={styles.transportLogTimestamp}>{formatTimestamp(entry.timestamp)}</span>
                      <span className={styles.transportLogPrefix} style={{ color: style.color }}>{style.label}</span>
                      {entry.autoSummary && (
                        <span className={styles.transportLogSummary}>
                          {entry.autoSummary.split(' | ').map((seg, si, arr) => (
                            <span key={si}>
                              <span style={{ color: seg.startsWith('(!)') ? '#f87171' : '#cbd5e1', fontWeight: seg.startsWith('(!)') ? 700 : 400 }}>{seg}</span>
                              {si < arr.length - 1 && <span style={{ color: '#475569' }}> | </span>}
                            </span>
                          ))}
                        </span>
                      )}
                      {entry.medicComment && (
                        <span className={styles.transportLogComment}>"{entry.medicComment}"</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Add free note */}
            <div className={styles.transportInput}>
              <input
                type="text"
                className={styles.transportTextInput}
                value={transportInput}
                onChange={(e) => setTransportInput(e.target.value)}
                placeholder="Add progress note…"
                onKeyDown={(e) => { if (e.key === 'Enter') void handleAddFreeNote(); }}
              />
              <button
                type="button"
                className={styles.transportAddBtn}
                onClick={() => void handleAddFreeNote()}
                disabled={isAddingNote || !transportInput.trim()}
              >
                {isAddingNote ? 'Adding…' : 'Add'}
              </button>
            </div>
          </div>
        </EditableSection>

        {/* ── Section 3: Vital Signs History ─────────────────────── */}
        <EditableSection
          sectionId="vitals"
          title="3. Vital Signs"
          sectionRef={getSectionRef('vitals')}
          flashFieldId={flashTarget?.sectionId === 'vitals' ? flashTarget.fieldId : null}
          onFlashComplete={() => setFlashTarget(null)}
          hideEdit
        >
          {/* ── Vitals: Horizontal time-column table ───────────────────── */}
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: '4px' }}>
            <table style={{ borderCollapse: 'collapse', minWidth: 'max-content', width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ position: 'sticky', left: 0, zIndex: 2, background: '#0f172a', padding: '6px 10px', textAlign: 'left', fontSize: '11px', fontWeight: 700, color: '#475569', textTransform: 'uppercase', whiteSpace: 'nowrap', minWidth: '80px', borderRight: '1px solid #1e293b', borderBottom: '1px solid #334155' }}>Vital</th>
                  {vitalHistory.map((entry, idx) => {
                    const isInitial = idx === 0;
                    const isCurrent = idx === vitalHistory.length - 1;
                    return (
                      <th key={idx} style={{ padding: '6px 12px', textAlign: 'center', fontSize: '11px', minWidth: '130px', borderBottom: '1px solid #334155', background: isCurrent && vitalHistory.length > 1 ? 'rgba(34,197,94,0.05)' : '#0f172a', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                        <div style={{ fontWeight: 700, color: '#e2e8f0' }}>{entry.label} {isInitial ? '🔒' : ''}</div>
                        <div style={{ fontSize: '10px', color: '#475569', marginTop: '2px' }}>{formatDate(entry.timestamp)}</div>
                        {isCurrent && vitalHistory.length > 1 && (
                          <div style={{ marginTop: '3px' }}>
                            <span style={{ padding: '1px 6px', borderRadius: '8px', background: 'rgba(34,197,94,0.15)', border: '1px solid #22c55e', color: '#4ade80', fontSize: '10px', fontWeight: 700 }}>● CURRENT</span>
                          </div>
                        )}
                      </th>
                    );
                  })}
                  {!showAddVitalsForm && (
                    <th style={{ padding: '6px 10px', minWidth: '140px', borderBottom: '1px solid #334155', borderLeft: '1px dashed #334155', verticalAlign: 'middle', textAlign: 'center' }}>
                      <button
                        type="button"
                        className={styles.addEntryBtn}
                        style={{ whiteSpace: 'nowrap', margin: 0 }}
                        onClick={() => {
                          // Reset all current-vitals fields to blank so medic fills only what changed
                          setEditVitalsForm((prev) => ({
                            ...prev,
                            hrCurrent: '', bpCurrent: '', bpLocationCurrent: '', bpOrientationCurrent: '',
                            rrCurrent: '', spo2Current: '', spo2DeviceCurrent: '', spo2FlowRateCurrent: '',
                            tempCurrent: '', tempLocationCurrent: '', sugarCurrent: '',
                            heightCurrent: '', weightCurrent: '', painCurrent: '', gcsCurrent: '',
                          }));
                          setShowAddVitalsForm(true);
                        }}
                      >
                        ➕ Add Update
                      </button>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {([
                  { label: 'HR',    getV: (e: VitalSignEntry) => e.hr ?? '',    unit: 'bpm',   isAbn: (v: string) => { const n = parseFloat(v); return !isNaN(n) && (n < 50 || n > 120); } },
                  { label: 'BP',    getV: (e: VitalSignEntry) => e.bp ?? '',    unit: 'mmHg',  isAbn: (v: string) => { const m = v.match(/^(\d+)/); return m ? parseInt(m[1]) < 90 || parseInt(m[1]) > 179 : false; } },
                  { label: 'RR',    getV: (e: VitalSignEntry) => e.rr ?? '',    unit: '/min',  isAbn: (v: string) => { const n = parseFloat(v); return !isNaN(n) && (n < 11 || n > 21); } },
                  { label: 'SpO₂',  getV: (e: VitalSignEntry) => e.spo2 ?? '', unit: '%',     isAbn: (v: string) => { const n = parseFloat(v); return !isNaN(n) && n < 90; } },
                  { label: 'Temp',  getV: (e: VitalSignEntry) => e.temp ?? '', unit: '°F',    isAbn: (v: string) => { const n = parseFloat(v); return !isNaN(n) && (n < 96.8 || n > 100.4); } },
                  { label: 'GCS',   getV: (e: VitalSignEntry) => e.gcs ?? '',  unit: '',      isAbn: (v: string) => { const n = parseFloat(v); return !isNaN(n) && n <= 14; } },
                  { label: 'Sugar', getV: (e: VitalSignEntry) => e.sugar ?? '',unit: 'mg/dL', isAbn: (v: string) => { const n = parseFloat(v); return !isNaN(n) && (n < 70 || n > 200); } },
                  { label: 'HT',    getV: (e: VitalSignEntry) => e.height ?? '',unit: 'in',   isAbn: null },
                  { label: 'WT',    getV: (e: VitalSignEntry) => e.weight ?? '',unit: 'lbs',  isAbn: null },
                  { label: 'Pain',  getV: (e: VitalSignEntry) => e.pain !== undefined ? String(e.pain) : '', unit: '/10', isAbn: null },
                ] as { label: string; getV: (e: VitalSignEntry) => string; unit: string; isAbn: ((v: string) => boolean) | null }[]).map(({ label, getV, unit, isAbn }) => (
                  <tr key={label}>
                    <td style={{ position: 'sticky', left: 0, zIndex: 1, background: '#0f172a', padding: '5px 10px', fontSize: '12px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', whiteSpace: 'nowrap', borderRight: '1px solid #1e293b', borderTop: '1px solid #0f1f2e' }}>{label}</td>
                    {vitalHistory.map((entry, idx) => {
                      const raw = getV(entry);
                      const val = raw !== '' ? raw : '—';
                      const abn = val !== '—' && isAbn ? isAbn(val) : false;
                      const isCurrent = idx === vitalHistory.length - 1;
                      return (
                        <td key={idx} style={{ padding: '5px 12px', textAlign: 'center', fontSize: '13px', fontWeight: abn ? 700 : 400, color: abn ? '#f87171' : '#f1f5f9', background: isCurrent && vitalHistory.length > 1 ? 'rgba(34,197,94,0.03)' : 'transparent', borderTop: '1px solid #0f1f2e', whiteSpace: 'nowrap' }}>
                          {val}{val !== '—' && unit ? ` ${unit}` : ''}{abn ? ' ⚠' : ''}
                        </td>
                      );
                    })}
                    {!showAddVitalsForm && <td style={{ borderTop: '1px solid #0f1f2e', borderLeft: '1px dashed #334155' }} />}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Add Vitals Update form — ref enables auto-scroll into view when opened */}
          {showAddVitalsForm && (
            <div className={styles.addEntryForm} ref={addVitalsFormRef}>
              <div className={styles.addEntryFormTitle}>➕ Add Vitals Update</div>
              <VitalsSection
                data={editVitalsForm}
                onChange={makeEditHandler(setEditVitalsForm)}
                stagedEcgFile={null}
                stagedEcgRhythm=""
                onStagedEcgFileChange={() => {}}
                onStagedEcgRhythmChange={() => {}}
                onDeleteEcg={() => {}}
                ecgRecords={[]}
                currentOnlyMode={true}
              />
              <label className={styles.addEntryCommentLabel}>Progress note (optional)</label>
              <textarea
                className={styles.addEntryCommentInput}
                value={addVitalsComment}
                onChange={(e) => setAddVitalsComment(e.target.value)}
                placeholder="e.g. Patient diaphoretic, BP trending up…"
                rows={2}
              />
              <div className={styles.addEntryActions}>
                <button type="button" className={styles.addEntrySubmitBtn} onClick={() => void handleAddVitals()} disabled={savingSection === 'vitals'}>
                  {savingSection === 'vitals' ? '⏳ Saving…' : '✅ Save Vitals Update'}
                </button>
                <button type="button" className={styles.addEntryCancelBtn} onClick={() => { setShowAddVitalsForm(false); setAddVitalsComment(''); }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </EditableSection>

        {/* ── Section 4: ECG Viewer ───────────────────────────────── */}
        <EditableSection
          sectionId="ecg"
          title="4. ECG"
          sectionRef={getSectionRef('ecg')}
          hideEdit
          badgeContent={ecgRecords.length > 0 ? (
            <span style={{ padding: '2px 8px', borderRadius: '10px', background: 'rgba(249,115,22,0.15)', border: '1px solid #F97316', color: '#fb923c', fontSize: '11px', fontWeight: 700 }}>
              {ecgRecords.length} ECG{ecgRecords.length !== 1 ? 's' : ''} on file 🟠
            </span>
          ) : undefined}
        >
          <EcgViewer
            records={ecgRecords}
            bundleId={bundleId}
            hospitalId={currentBundle.hospitalId}
            onUpload={handleEcgUploaded}
            onRhythmSave={handleEcgRhythmSave}
            onDelete={handleEcgDelete}
          />
        </EditableSection>

        {/* ── Section 5: Assessment History ──────────────────────── */}
        <EditableSection
          sectionId="assessment"
          title="5. Assessment"
          sectionRef={getSectionRef('assessment')}
          flashFieldId={flashTarget?.sectionId === 'assessment' ? flashTarget.fieldId : null}
          onFlashComplete={() => setFlashTarget(null)}
          hideEdit
        >
          {/* ── Assessment: Horizontal time-column table ──────────────────── */}
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: '4px' }}>
            <table style={{ borderCollapse: 'collapse', minWidth: 'max-content', width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ position: 'sticky', left: 0, zIndex: 2, background: '#0f172a', padding: '6px 10px', textAlign: 'left', fontSize: '11px', fontWeight: 700, color: '#475569', textTransform: 'uppercase', whiteSpace: 'nowrap', minWidth: '100px', borderRight: '1px solid #1e293b', borderBottom: '1px solid #334155' }}>Field</th>
                  {assessmentHistory.map((entry, idx) => {
                    const isInitial = idx === 0;
                    const isCurrent = idx === assessmentHistory.length - 1;
                    return (
                      <th key={idx} style={{ padding: '6px 12px', textAlign: 'center', fontSize: '11px', minWidth: '160px', borderBottom: '1px solid #334155', background: isCurrent && assessmentHistory.length > 1 ? 'rgba(34,197,94,0.05)' : '#0f172a', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                        <div style={{ fontWeight: 700, color: '#e2e8f0' }}>{entry.label} {isInitial ? '🔒' : ''}</div>
                        <div style={{ fontSize: '10px', color: '#475569', marginTop: '2px' }}>{formatDate(entry.timestamp)}</div>
                        {isCurrent && assessmentHistory.length > 1 && (
                          <div style={{ marginTop: '3px' }}>
                            <span style={{ padding: '1px 6px', borderRadius: '8px', background: 'rgba(34,197,94,0.15)', border: '1px solid #22c55e', color: '#4ade80', fontSize: '10px', fontWeight: 700 }}>● CURRENT</span>
                          </div>
                        )}
                      </th>
                    );
                  })}
                  {!showAddAssessForm && (
                    <th style={{ padding: '6px 10px', minWidth: '160px', borderBottom: '1px solid #334155', borderLeft: '1px dashed #334155', verticalAlign: 'middle', textAlign: 'center' }}>
                      <button
                        type="button"
                        className={styles.addEntryBtn}
                        style={{ whiteSpace: 'nowrap', margin: 0 }}
                        onClick={() => {
                          // Reset assessment form to blank so medic only fills what changed
                          setEditAssessForm((prev) => ({
                            ...prev,
                            mentalStatus: '', gcs: '', orientation: [], pupils: '',
                            motorLeft: '', motorRight: '', speech: '', airway: '',
                            lungSounds: [], skin: [], pertinentNegatives: [],
                          }));
                          setShowAddAssessForm(true);
                        }}
                      >
                        ➕ Add Update
                      </button>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {([
                  { label: 'AVPU',         getV: (e: AssessmentEntry) => e.avpu ?? '' },
                  { label: 'Orientation',  getV: (e: AssessmentEntry) => e.orientation && e.orientation.length > 0 ? (e.orientation.includes('x0 (None)') ? 'AxO x0' : `AxO x${e.orientation.length} (${e.orientation.join(', ')})`) : '' },
                  { label: 'Pupils',       getV: (e: AssessmentEntry) => e.pupils ?? '' },
                  { label: 'Speech',       getV: (e: AssessmentEntry) => e.speech ?? '' },
                  { label: 'Motor L',      getV: (e: AssessmentEntry) => e.motorLeft ?? '' },
                  { label: 'Motor R',      getV: (e: AssessmentEntry) => e.motorRight ?? '' },
                  { label: 'Airway',       getV: (e: AssessmentEntry) => e.airway ?? '' },
                  { label: 'Lung Sounds',  getV: (e: AssessmentEntry) => e.lungSounds && e.lungSounds.length > 0 ? e.lungSounds.join(', ') : '' },
                  { label: 'Skin',         getV: (e: AssessmentEntry) => e.skin && e.skin.length > 0 ? e.skin.join(', ') : '' },
                  { label: 'Pertinent Neg',getV: (e: AssessmentEntry) => e.pertinentNegatives && e.pertinentNegatives.length > 0 ? e.pertinentNegatives.join(', ') : '' },
                ] as { label: string; getV: (e: AssessmentEntry) => string }[]).map(({ label, getV }) => (
                  <tr key={label}>
                    <td style={{ position: 'sticky', left: 0, zIndex: 1, background: '#0f172a', padding: '5px 10px', fontSize: '12px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', whiteSpace: 'nowrap', borderRight: '1px solid #1e293b', borderTop: '1px solid #0f1f2e' }}>{label}</td>
                    {assessmentHistory.map((entry, idx) => {
                      const val = getV(entry) || '—';
                      const isCurrent = idx === assessmentHistory.length - 1;
                      return (
                        <td key={idx} style={{ padding: '5px 12px', textAlign: 'center', fontSize: '13px', color: '#f1f5f9', background: isCurrent && assessmentHistory.length > 1 ? 'rgba(34,197,94,0.03)' : 'transparent', borderTop: '1px solid #0f1f2e', wordBreak: 'break-word', maxWidth: '200px' }}>
                          {val}
                        </td>
                      );
                    })}
                    {!showAddAssessForm && <td style={{ borderTop: '1px solid #0f1f2e', borderLeft: '1px dashed #334155' }} />}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Add Assessment Update form — ref enables auto-scroll into view when opened */}
          {showAddAssessForm && (
            <div className={styles.addEntryForm} ref={addAssessFormRef}>
              <div className={styles.addEntryFormTitle}>➕ Add Assessment Update</div>
              <AssessmentSection data={editAssessForm} onChange={makeEditHandler(setEditAssessForm)} />
              <label className={styles.addEntryCommentLabel}>Progress note (optional)</label>
              <textarea
                className={styles.addEntryCommentInput}
                value={addAssessComment}
                onChange={(e) => setAddAssessComment(e.target.value)}
                placeholder="e.g. Patient becoming more confused, GCS decreased…"
                rows={2}
              />
              <div className={styles.addEntryActions}>
                <button type="button" className={styles.addEntrySubmitBtn} onClick={() => void handleAddAssessment()} disabled={savingSection === 'assessment'}>
                  {savingSection === 'assessment' ? '⏳ Saving…' : '✅ Save Assessment Update'}
                </button>
                <button type="button" className={styles.addEntryCancelBtn} onClick={() => { setShowAddAssessForm(false); setAddAssessComment(''); }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </EditableSection>

        {/* ── Section 6: Interventions & Resources ───────────────── */}
        <EditableSection
          sectionId="interventions"
          title="6. Interventions & Resources"
          sectionRef={getSectionRef('interventions')}
          onSave={async () => {
            await handleSectionSave({ ...editIntervForm }, 'interventions');
            setEditIntervForm(bundleToFormData(currentBundle));
          }}
          onEditOpen={() => setEditIntervForm(bundleToFormData(currentBundle))}
          isSaving={savingSection === 'interventions'}
          editForm={<InterventionsSection data={editIntervForm} onChange={makeEditHandler(setEditIntervForm)} />}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {encounter?.interventions && encounter.interventions.length > 0 && (
              <div>
                <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '4px', fontWeight: 700 }}>INTERVENTIONS</div>
                <div className={styles.chipList}>
                  {encounter.interventions.map((v, i) => <span key={i} className={styles.chip}>{v}</span>)}
                </div>
              </div>
            )}
            {encounter?.resourceRequirements && encounter.resourceRequirements.length > 0 && (
              <div>
                <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '4px', fontWeight: 700 }}>RESOURCE REQUIREMENTS</div>
                <div className={styles.chipList}>
                  {encounter.resourceRequirements.map((v, i) => <span key={i} className={styles.chip}>{v}</span>)}
                </div>
              </div>
            )}
            {(!encounter?.interventions?.length && !encounter?.resourceRequirements?.length) && (
              <div style={{ color: '#475569', fontSize: '13px' }}>No interventions recorded</div>
            )}
          </div>
        </EditableSection>

        {/* ── Section 7: History (AMPLE) ──────────────────────────── */}
        <EditableSection
          sectionId="history"
          title="7. History (AMPLE)"
          sectionRef={getSectionRef('history')}
          flashFieldId={flashTarget?.sectionId === 'history' ? flashTarget.fieldId : null}
          onFlashComplete={() => setFlashTarget(null)}
          onSave={async () => {
            await handleSectionSave({ ...editHistoryForm }, 'history');
            setEditHistoryForm(bundleToFormData(currentBundle));
          }}
          onEditOpen={() => setEditHistoryForm(bundleToFormData(currentBundle))}
          isSaving={savingSection === 'history'}
          editForm={<HistorySection data={editHistoryForm} onChange={makeEditHandler(setEditHistoryForm)} />}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }} data-field-id="historyBlock">
            <div className={styles.fieldReadRow}>
              <span className={styles.fieldReadLabel}>A — Allergies:</span>
              <span className={styles.fieldReadValue}>{baseFormData.allergies.join(', ') || 'NKDA'}</span>
            </div>
            <div className={styles.fieldReadRow}>
              <span className={styles.fieldReadLabel}>M — Medications:</span>
              <span className={styles.fieldReadValue}>{baseFormData.medications.join(', ') || '—'}</span>
            </div>
            <div className={styles.fieldReadRow}>
              <span className={styles.fieldReadLabel}>P — Past Hx:</span>
              <span className={styles.fieldReadValue}>{baseFormData.knownHistory.join(', ') || '—'}</span>
            </div>
            <div className={styles.fieldReadRow}>
              <span className={styles.fieldReadLabel}>L — Last Intake:</span>
              <span className={styles.fieldReadValue}>{baseFormData.lastOralIntake || '—'}</span>
            </div>
            <div className={styles.fieldReadRow}>
              <span className={styles.fieldReadLabel}>E — Events:</span>
              <span className={styles.fieldReadValue}>{baseFormData.events || '—'}</span>
            </div>
          </div>
        </EditableSection>

        {/* ── Section 8: Origin & Scene ────────────────────────────── */}
        <EditableSection
          sectionId="origin"
          title="8. Origin & Scene"
          sectionRef={getSectionRef('origin')}
          onSave={async () => {
            await handleSectionSave({ ...editOriginForm }, 'origin');
            setEditOriginForm(bundleToFormData(currentBundle));
          }}
          onEditOpen={() => setEditOriginForm(bundleToFormData(currentBundle))}
          isSaving={savingSection === 'origin'}
          editForm={<OriginSection data={editOriginForm} onChange={makeEditHandler(setEditOriginForm)} />}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {currentBundle.fromOrigin?.source && (
              <div className={styles.fieldReadRow}>
                <span className={styles.fieldReadLabel}>Source:</span>
                <span className={styles.fieldReadValue}>{currentBundle.fromOrigin.source}</span>
              </div>
            )}
            {currentBundle.fromOrigin?.address && (
              <div className={styles.fieldReadRow}>
                <span className={styles.fieldReadLabel}>Address:</span>
                <span className={styles.fieldReadValue}>{currentBundle.fromOrigin.address}</span>
              </div>
            )}
            {encounter?.sceneNotes && encounter.sceneNotes.length > 0 && (
              <div className={styles.fieldReadRow}>
                <span className={styles.fieldReadLabel}>Scene Notes:</span>
                <span className={styles.fieldReadValue}>{encounter.sceneNotes.join(' · ')}</span>
              </div>
            )}
          </div>
        </EditableSection>
      </div>

      {/* ── Mini ChatHub Bar ────────────────────────────────────── */}
      <ChatHub
        messages={chatMessages}
        bundleId={bundleId}
        hospitalId={currentBundle.hospitalId}
        session={session}
        isExpanded={isChatExpanded}
        onExpandToggle={() => setIsChatExpanded((v) => !v)}
        onNewMessages={setChatMessages}
      />

      {/* Fix 4: Arrive Confirmation Modal — centered full-screen overlay */}
      {showArriveConfirm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1500,
          background: 'rgba(0,0,0,0.75)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: '#1e293b', borderRadius: '14px', padding: '32px 36px',
            minWidth: '360px', maxWidth: '480px', border: '1px solid #22c55e',
            boxShadow: '0 20px 50px rgba(0,0,0,0.6)',
            display: 'flex', flexDirection: 'column', gap: '16px',
          }}>
            <div style={{ fontSize: '32px', textAlign: 'center' }}>✅</div>
            <h3 style={{ margin: 0, color: '#4ade80', fontSize: '18px', fontWeight: 700, textAlign: 'center' }}>
              Confirm Patient Arrival
            </h3>
            <p style={{ margin: 0, color: '#94a3b8', fontSize: '14px', textAlign: 'center', lineHeight: 1.5 }}>
              Arriving <strong style={{ color: '#e2e8f0' }}>{patientName}</strong> at{' '}
              <strong style={{ color: '#e2e8f0' }}>{currentBundle.hospitalId}</strong>?<br />
              This will complete the handoff and archive the record.
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', marginTop: '8px' }}>
              <button
                type="button"
                onClick={() => void handleConfirmArrive()}
                disabled={isArrivingPatient}
                style={{
                  padding: '12px 28px', borderRadius: '8px', border: 'none',
                  background: '#22c55e', color: '#fff', fontSize: '14px',
                  fontWeight: 700, cursor: 'pointer', minWidth: '160px',
                }}
              >
                {isArrivingPatient ? '⏳ Arriving…' : '✅ Yes, Arrive Patient'}
              </button>
              <button
                type="button"
                onClick={() => setShowArriveConfirm(false)}
                disabled={isArrivingPatient}
                style={{
                  padding: '12px 20px', borderRadius: '8px',
                  border: '1px solid #475569', background: 'transparent',
                  color: '#94a3b8', fontSize: '14px', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Sticky Action Bar ───────────────────────────────────── */}
      <div className={styles.actionBar}>
        <button type="button" className={`${styles.actionBtn} ${styles.divertBtn}`}
          onClick={() => setShowDivertModal(true)}>
          🔀 Change Hospital
        </button>
        <button type="button" className={`${styles.actionBtn} ${styles.arriveBtn}`}
          onClick={() => { setShowArriveConfirm(true); }}>
          ✅ Arrive Patient
        </button>
      </div>

      {/* ── Divert Modal ─────────────────────────────────────────── */}
      {showDivertModal && (
        <DivertModal
          currentHospitalId={currentBundle.hospitalId}
          bundleId={bundleId}
          onDiverted={handleDiverted}
          onClose={() => setShowDivertModal(false)}
        />
      )}

      {/* ── Hospital Arrived Notification (blocking overlay) ─────── */}
      {showHospitalArrived && (
        <HospitalArrivedNotification
          bundle={currentBundle}
          bundleId={bundleId}
          hospitalId={currentBundle.hospitalId}
          onRestore={(restoredBundle) => {
            setCurrentBundle(restoredBundle);
            setShowHospitalArrived(false);
            onVitalsUpdated(restoredBundle);
          }}
          onConfirmClear={onArrived}
        />
      )}
    </div>
  );
}
