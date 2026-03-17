"""
models.py — Pydantic Data Models for EMS Handoff Dashboard
===========================================================
Purpose:
    These models serve as the strict data contract — the "Bouncer" — for
    all PHI submitted through the EMS Handoff ingestion pipeline. Every
    incoming FHIR Bundle payload is validated against this schema BEFORE
    any data is written to Cosmos DB. Malformed or unauthorized payloads
    are rejected at this boundary and never enter the VNet.

Schema Source:
    src/shared/schemas/FHIR-patient-schema-v1.json

Architecture — Discriminated Union:
    The `entry[].resource` field resolves to one of four concrete models
    (Patient, Encounter, Observation, Assessment) using `resourceType` as
    the discriminator key. This produces precise, resource-specific
    validation errors rather than a generic "union match failed" message.

HIPAA Guardrail:
    PHI values are NEVER logged. Only Bundle `id` fields are used for
    operational debugging and tracing.

Models in this file:
    ┌─────────────────────────────────────────────────────────────────┐
    │  FHIRBundle       — Root Bouncer for POST /api/ems-to-db        │
    │  ArrivalRequest   — Bouncer for POST /api/ems-arrival           │
    │  RecoverRequest   — Bouncer for POST /api/recover-handoff       │
    │  DivertRequest    — Bouncer for POST /api/divert-handoff        │
    │  SendChatRequest  — Bouncer for POST /api/send-chat             │
    │  EcgUploadRequest — Bouncer for POST /api/upload-ecg            │
    │  (+ all FHIR sub-models FHIRBundle depends on)                  │
    └─────────────────────────────────────────────────────────────────┘
"""

import re
from datetime import date
from typing import Annotated, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator, model_validator


# =============================================================================
# Shared / Primitive Sub-models
# =============================================================================


class FHIRExtension(BaseModel):
    """
    Represents a single FHIR extension object.

    Used across Patient and Encounter resources for custom clinical fields
    defined in our schema:
      Patient   → age, known-history, isolation, allergies
      Encounter → scene-safety, lkw (last known well), onset-time, ems-contact-time

    Both `valueString` and `valueDateTime` are Optional because different
    extension types use different value fields. A missing value key will
    simply resolve to None rather than causing a validation failure.
    """

    url: str
    valueString: Optional[str] = None
    valueDateTime: Optional[str] = None


class ValueQuantity(BaseModel):
    """
    Models the FHIR `valueQuantity` object used in Observation components.

    The `value` field is strictly typed as Optional[float].
    ┌─────────────────────────────────────────────────────────────────┐
    │  BOUNCER CHECKPOINT                                             │
    │  Pydantic will REJECT any non-numeric value here.              │
    │  e.g., valueQuantity.value = "CRITICAL" → ValidationError      │
    │  This is the primary guard against garbled vital sign data.    │
    └─────────────────────────────────────────────────────────────────┘
    Using `float` covers both integer vitals (HR: 92) and decimal values
    (SpO2: 98.6). Pydantic v2 will coerce int → float automatically.
    """

    value: Optional[float] = None
    unit: Optional[str] = None
    system: Optional[str] = None
    code: Optional[str] = None


class CodeableConcept(BaseModel):
    """
    Generic FHIR CodeableConcept — a reusable wrapper around a display
    text string. Used for ESI priority, chief complaint, vital sign codes,
    and observation codes throughout the Bundle.
    """

    text: Optional[str] = None


# =============================================================================
# Patient Resource Sub-models
# =============================================================================


class HumanName(BaseModel):
    """
    FHIR HumanName — represents the patient's name.

    Both `family` and `given` are Optional to support the "Unknown" patient
    scenario (e.g., unresponsive ACLS arrest with no identification). When
    identity is unknown, these fields arrive as "Unknown" strings or are
    omitted entirely — both cases are accepted by this model.
    """

    family: Optional[str] = None
    given: Optional[List[str]] = None


class ContactTelecom(BaseModel):
    """FHIR ContactPoint — a phone number or other channel for a contact."""

    system: Optional[str] = None
    value: Optional[str] = None


class ContactName(BaseModel):
    """
    Display name for a patient's emergency contact.

    Both `family`/`given` (structured) and `text` (legacy full-name) are
    supported for backward compatibility with existing payloads.
    """

    text: Optional[str] = None       # legacy full-name field
    family: Optional[str] = None     # emergency contact last name
    given: Optional[str] = None      # emergency contact first name


class ContactRelationship(BaseModel):
    """Describes the relationship of the contact to the patient."""

    text: Optional[str] = None


class PatientContact(BaseModel):
    """
    Models the patient's emergency contact block.
    All fields are Optional — contact information is frequently unavailable
    in urgent pre-hospital scenarios.
    """

    name: Optional[ContactName] = None
    telecom: Optional[List[ContactTelecom]] = None
    relationship: Optional[List[ContactRelationship]] = None


# =============================================================================
# Encounter Resource Sub-models
# =============================================================================


class EncounterPeriod(BaseModel):
    """
    FHIR Period scoped to an Encounter.
    In our schema, `end` captures the medic's ETA to the receiving ED.
    """

    end: Optional[str] = None


# =============================================================================
# Observation Resource Sub-models
# =============================================================================


class ObservationComponent(BaseModel):
    """
    Models a single vital sign reading within the Observation resource.

    A component uses either:
      - `valueQuantity` (structured) → HR, RR, SpO2, Temp, Sugar
      - `valueString`   (free-text)  → BP (e.g., "158/94 mmHg")

    Both are Optional to support partial vital sign reporting. The `code`
    field (a CodeableConcept) identifies which vital sign this component
    represents (e.g., {"text": "HR"}).

    ┌─────────────────────────────────────────────────────────────────┐
    │  BOUNCER CHECKPOINT                                             │
    │  `valueQuantity.value` is typed as Optional[float].            │
    │  A payload with value="CRITICAL" will fail here with a clear   │
    │  validation error pinpointing the exact component path.        │
    └─────────────────────────────────────────────────────────────────┘

    Contextual metadata fields for clinical precision:
      location    — BP: "Right Arm"/"Left Arm" | Temp: "Oral"/"Axillary"
      orientation — BP patient position: "Lying"/"Sitting"/"Standing"
      device      — SpO2 delivery device: "Nasal Cannula"/"Non-Rebreather"
      flowRate    — SpO2 O2 delivery rate: 0–16 L/min
    """

    code: CodeableConcept
    valueQuantity: Optional[ValueQuantity] = None
    valueString: Optional[str] = None
    unit: Optional[str] = None
    location: Optional[str] = None
    orientation: Optional[str] = None
    device: Optional[str] = None
    flowRate: Optional[float] = None


class ObservationNote(BaseModel):
    """
    Free-text triage note appended to the Observation resource.
    Carries the narrative note including assessment findings and
    medications administered in the field.
    """

    text: Optional[str] = None


# =============================================================================
# Point of Origin Sub-model
# =============================================================================


class FromOrigin(BaseModel):
    """
    Structured point-of-origin data for the EMS handoff.

    WHY this is at Bundle root, NOT inside EncounterResource:
    ─────────────────────────────────────────────────────────
    EncounterResource holds CLINICAL encounter attributes — ESI level,
    chief complaint, ETA, scene safety. These describe the patient's
    condition and the encounter context.

    `fromOrigin` describes WHERE THE PATIENT IS COMING FROM — a dispatch
    and logistics concern, not a clinical assessment. It belongs alongside
    the other operational metadata at the Bundle root (e.g., `medicUnit`,
    `medicName`, `hospitalId`), not embedded inside the clinical resource.

    Fields:
    -------
    source  : Optional[str]
        Type/category of origin, e.g.:
          "Scene"                    → field response
          "Skilled Nursing Facility" → inter-facility transfer
          "Residence"                → home call
          "Motor Vehicle Accident"   → trauma dispatch

    address : Optional[str]
        Street-level address of the origin location.
        e.g., "1234 Market St, Philadelphia, PA 19103"
    """

    source: Optional[str] = None
    address: Optional[str] = None


# =============================================================================
# FHIR Resource Models — Discriminated Union Members
# =============================================================================


class PatientResource(BaseModel):
    """
    FHIR Patient resource — the primary PHI container in the Bundle.

    Flexible PHI Design:
    --------------------
    `birthDate`, `gender`, and `name` sub-fields are all typed as
    Optional[str] = None. This means three states are accepted:

      State 1 — Known:    birthDate="1980-01-01", gender="male"
      State 2 — Unknown:  birthDate="Unknown",    gender="Unknown"
      State 3 — Absent:   field omitted → resolves to None

    This flexibility is medically necessary. For unidentifiable patients
    (e.g., a STEMI arrest found unresponsive at scene), demographics are
    unavailable. The Bouncer MUST NOT reject these handoffs — the clinical
    data in Encounter and Observation is still actionable for the ED.

    computed_age:
    -------------
    A `@computed_field` that derives the patient's age in integer years
    from `birthDate` at ingestion validation time. Read-only — callers
    cannot inject a false age via the payload. Always consistent with
    birthDate. Automatically included in model_dump() → persisted to DB.

    Discriminator:
    --------------
    The `resourceType: Literal["Patient"]` field is the discriminator key.
    Pydantic inspects this value in each BundleEntry to select this model.
    """

    resourceType: Literal["Patient"]
    name: Optional[List[HumanName]] = None
    gender: Optional[str] = None
    birthDate: Optional[str] = None
    extension: Optional[List[FHIRExtension]] = None
    contact: Optional[List[PatientContact]] = None
    medications: Optional[List[str]] = Field(
        default=None,
        description="Pre-hospital medications the patient takes regularly.",
    )
    codeStatus: Optional[Literal["Full Code", "DNR", "DNI", "DNR/DNI"]] = Field(
        default=None,
        description="Patient's advance directive / resuscitation status."
    )
    alertBadges: Optional[List[str]] = Field(
        default=None,
        description="High-priority clinical alerts. e.g. ['STEMI', 'Stroke Alert', 'Trauma Activation']"
    )

    @computed_field
    @property
    def computed_age(self) -> Optional[int]:
        """
        Derives patient age from birthDate at Pydantic validation time.

        Why @computed_field over a @model_validator?
        ─────────────────────────────────────────────
        A `@computed_field` is a pure read-only derived property — it
        cannot be set externally. The Bouncer computes it; the caller
        has zero influence over the result. This is the correct pattern
        for derived, trust-critical clinical data.

        Three-state handling:
        ─────────────────────
          State 1 — Valid ISO 8601 date ("1985-04-12"):
              Computes exact age in years.

          State 2 — "Unknown" string literal or None:
              Returns None. Dashboard renders "Unknown".

          State 3 — Sentinel placeholder DOB ("1880-01-01"):
              Returns the computed integer (e.g., 145). The dashboard
              detects age > 120 as the "Unknown / Unidentified" sentinel.

          State 4 — Malformed / unparseable string:
              Returns None gracefully. Never blocks a valid handoff.
        """
        if not self.birthDate:
            return None
        if self.birthDate.strip().lower() == "unknown":
            return None
        try:
            dob = date.fromisoformat(self.birthDate)
            today = date.today()
            return (
                today.year
                - dob.year
                - ((today.month, today.day) < (dob.month, dob.day))
            )
        except (ValueError, TypeError):
            return None


class EncounterResource(BaseModel):
    """
    FHIR Encounter resource — the clinical context for the EMS event.

    Captures:
      - ESI triage level          → priority.text (e.g., "ESI-1 (CRITICAL)")
      - Chief complaint           → reasonCode[0].text
      - Estimated time of arrival → period.end (ISO 8601)
      - Last known well           → extension[url=lkw].valueDateTime
      - Onset time                → extension[url=onset-time].valueDateTime
      - EMS contact time          → extension[url=ems-contact-time].valueDateTime
      - Events narrative          → extension[url=events].valueString
      - Resource requirements     → resourceRequirements (List[str])
      - Scene notes               → sceneNotes (List[str])
      - Encounter classifications → encounterTypes (List[str])

    Discriminator:
    --------------
    The `resourceType: Literal["Encounter"]` field is the discriminator key.
    """

    resourceType: Literal["Encounter"]
    status: Optional[str] = None
    priority: Optional[CodeableConcept] = None
    reasonCode: Optional[List[CodeableConcept]] = None
    period: Optional[EncounterPeriod] = None
    extension: Optional[List[FHIRExtension]] = None
    resourceRequirements: Optional[List[str]] = Field(
        default=None,
        description=(
            "Free-text list of resources required on patient arrival. "
            "Each element is a discrete requirement string. "
            "Examples: ['Oxygen - 15L NRB', 'LVAD Specialist', "
            "'Bariatric Bed', 'Isolation Room - Contact Precautions']"
        ),
    )
    interventions: Optional[List[str]] = Field(
        default=None,
        description=(
            "Pre-hospital interventions performed by EMS. "
            "Examples: ['12-Lead EKG', 'IV Access x2', 'RSI Intubation', "
            "'Needle Decompression R Chest', 'Tourniquet Right Leg']"
        ),
    )
    sceneNotes: Optional[List[str]] = Field(
        default=None,
        description="Free-form scene context chips. e.g. ['Empty pill bottles found', 'No seatbelt used']"
    )
    encounterTypes: Optional[List[Literal["Medical", "Trauma", "Behavioral", "OB-GYN", "Pediatric"]]] = Field(
        default=None,
        description="Encounter type classifications — multi-select. Drives team activation pathway."
    )


class ObservationResource(BaseModel):
    """
    FHIR Observation resource — the vital signs snapshot.

    The `component` list holds individual vital sign readings. Each
    component is validated by ObservationComponent, which enforces
    numeric types on valueQuantity fields.

    Supported vital sign components:
      HR    → valueQuantity (bpm)
      BP    → valueString   ("158/94 mmHg")
      RR    → valueQuantity (breaths/min)
      SpO2  → valueQuantity (%)
      Temp  → valueQuantity (°F)
      Sugar → valueQuantity (mg/dL)

    The `note` list carries the free-text triage narrative.

    observationType : Literal["initial" | "current"]
        Discriminator for the dual vitals snapshot pattern.
        "initial" = on-scene baseline; "current" = updated en route.

    Discriminator:
    --------------
    The `resourceType: Literal["Observation"]` field is the discriminator key.
    """

    resourceType: Literal["Observation"]
    observationType: Optional[Literal["initial", "current"]] = Field(
        default="initial",
        description="Distinguishes initial vitals snapshot from updated current vitals."
    )
    status: Optional[str] = None
    code: Optional[CodeableConcept] = None
    component: Optional[List[ObservationComponent]] = None
    note: Optional[List[ObservationNote]] = None
    height: Optional[float] = Field(default=None, description="Estimated height in inches.")
    weight: Optional[float] = Field(default=None, description="Estimated weight in lbs.")
    pain: Optional[int] = Field(
        default=None,
        ge=0, le=10,
        description="Numeric Rating Scale pain score (0=no pain, 10=worst pain).",
    )


# =============================================================================
# Assessment Resource
# =============================================================================


class AssessmentResource(BaseModel):
    """
    Custom EMS Assessment resource capturing pre-hospital neurological
    and physical exam findings. Not a standard FHIR resource type —
    this is a domain-specific extension of the FHIR Bundle pattern used
    throughout this project.

    Discriminator: resourceType = "Assessment"

    Neuro fields follow the standard EMS assessment flow:
      AVPU → GCS (trauma only) → Orientation AxO → Pupils → Motor/Sensory/Speech

    Physical fields follow the primary survey flow:
      Airway → Lung Sounds → Skin Assessment → Pertinent Negatives
    """

    resourceType: Literal["Assessment"]

    # ── Neuro ──────────────────────────────────────────────────────────────
    mentalStatus: Optional[Literal["Alert", "Voice", "Pain", "Unresponsive"]] = Field(
        default=None,
        description="AVPU scale: Alert / Voice (responds to) / Pain (responds to) / Unresponsive"
    )
    gcs: Optional[int] = Field(
        default=None,
        ge=3, le=15,
        description="Glasgow Coma Scale score (3–15). Primarily used for trauma patients."
    )
    orientation: Optional[List[str]] = Field(
        default=None,
        description="AxO domains patient is oriented to. Subset of ['Person','Place','Time','Situation']"
    )
    pupils: Optional[str] = Field(
        default=None,
        description="Pupil assessment narrative. e.g. 'PERRL 3mm', 'Pinpoint bilateral', 'Unequal L>R'"
    )
    motorLeft: Optional[str] = Field(
        default=None,
        description="Left-side motor/grip strength. e.g. 'Equal', 'Weak', 'Absent'"
    )
    motorRight: Optional[str] = Field(
        default=None,
        description="Right-side motor/grip strength. e.g. 'Equal', 'Weak', 'Absent'"
    )
    speech: Optional[Literal["Clear", "Slurred", "Aphasic", "Non-verbal"]] = Field(
        default=None,
        description="Speech quality assessment."
    )

    # ── Physical ───────────────────────────────────────────────────────────
    airway: Optional[Literal["Patent", "Obstructed", "Managed"]] = Field(
        default=None,
        description="Airway status. 'Managed' = intubated/supraglottic airway in place."
    )
    lungSounds: Optional[List[str]] = Field(
        default=None,
        description="Auscultated lung sounds. e.g. ['Clear', 'Wheeze R', 'Crackles bilateral']"
    )
    skin: Optional[List[str]] = Field(
        default=None,
        description="Skin assessment descriptors. e.g. ['Warm', 'Dry', 'Pale', 'Diaphoretic']"
    )
    pertinentNegatives: Optional[List[str]] = Field(
        default=None,
        description="Clinically significant negatives. e.g. ['No chest pain', 'No LOC', 'No focal deficits']"
    )


# =============================================================================
# Discriminated Union — The Polymorphic Resource Resolver
# =============================================================================

# When Pydantic encounters a BundleEntry, it inspects `resource.resourceType`
# and routes validation to the correct model:
#
#   "Patient"     → PatientResource
#   "Encounter"   → EncounterResource
#   "Observation" → ObservationResource
#   "Assessment"  → AssessmentResource
#   anything else → ValidationError (discriminator_value_not_found)
#
# This produces surgical, resource-specific error messages instead of
# a generic "union match failed" error.
FHIRResource = Annotated[
    Union[PatientResource, EncounterResource, ObservationResource, AssessmentResource],
    Field(discriminator="resourceType"),
]


class BundleEntry(BaseModel):
    """
    Wrapper model for each item in the FHIR Bundle `entry` array.

    The `resource` field uses the FHIRResource discriminated union,
    enabling Pydantic to select and validate the correct resource model
    for each entry based on its `resourceType` value.
    """

    resource: FHIRResource


# =============================================================================
# EcgRecord Sub-model
# =============================================================================


class EcgRecord(BaseModel):
    """
    Single ECG upload entry in the ecgRecords serial list.

    WHY a list instead of a single ecgBlobUrl field:
    ─────────────────────────────────────────────────
    Pre-hospital EKGs evolve during transport. A STEMI patient may have:
      1. An "Initial" EKG captured on scene (baseline rhythm)
      2. An "Update" EKG 8 minutes later showing new ST changes
    Both records are clinically significant and must be available to the ED
    for comparison. The serial list preserves the temporal record.

    Label logic (set by POST /api/upload-ecg):
      First record in list  → label = "Initial"
      Subsequent records    → label = "Update {HH:MM}" (time of upload)
    "Current" is always derived by the frontend as ecgRecords[-1].

    blobKey stores the unique filename (ecg-{epoch_ms}.{ext}) for each upload,
    enabling GET and DELETE to reconstruct the exact blob path regardless
    of array index changes after deletions.
    """

    url: str = Field(..., description="Blob Storage URL for the ECG image.")
    timestamp: str = Field(..., description="ISO8601 UTC timestamp of upload.")
    label: str = Field(..., description="'Initial' or 'Update HH:MM' — derived by backend.")
    rhythmInterpretation: Optional[str] = Field(
        default=None,
        description="Medic's rhythm read. e.g. 'Normal Sinus', 'ST Elevation V1-V4', 'A-Fib RVR'",
    )
    blobKey: Optional[str] = Field(
        default=None,
        description=(
            "Unique blob filename for this upload. "
            "Format: 'ecg-{epoch_ms}.{ext}'. None for legacy records."
        ),
    )


# =============================================================================
# History Entry Sub-models
# =============================================================================


class VitalSignEntry(BaseModel):
    """
    Immutable timestamped vital sign snapshot.

    Appended on each EMS reassessment — index 0 = Initial (locked on-scene
    baseline), index 1+ = Update N (en-route reassessments). Stored at
    FHIRBundle root as vitalHistory[].
    """

    timestamp: str
    label: str
    hr: Optional[str] = None
    bp: Optional[str] = None
    rr: Optional[str] = None
    spo2: Optional[str] = None
    spo2Device: Optional[str] = None
    spo2FlowRate: Optional[str] = None
    temp: Optional[str] = None
    tempLocation: Optional[str] = None
    gcs: Optional[str] = None
    sugar: Optional[str] = None
    height: Optional[str] = None
    weight: Optional[str] = None
    pain: Optional[int] = Field(None, ge=0, le=10)


class AssessmentEntry(BaseModel):
    """
    Immutable timestamped assessment snapshot.

    Appended on each EMS reassessment — same index pattern as VitalSignEntry.
    Stored at FHIRBundle root as assessmentHistory[].
    """

    timestamp: str
    label: str
    avpu: Optional[str] = None
    orientation: Optional[List[str]] = None
    pupils: Optional[str] = None
    motorLeft: Optional[str] = None
    motorRight: Optional[str] = None
    speech: Optional[str] = None
    airway: Optional[str] = None
    lungSounds: Optional[List[str]] = None
    skin: Optional[List[str]] = None
    pertinentNegatives: Optional[List[str]] = None


class TransportLogEntry(BaseModel):
    """
    Typed, append-only transport log entry stored at FHIRBundle root.

    type values:
      'note'               — medic free-text note
      'vitals_update'      — system entry for new vital sign history entry
      'assessment_update'  — system entry for new assessment history entry
      'ecg_upload'         — system entry for ECG upload event

    autoSummary   : system-generated human-readable summary (e.g. "HR 88 | BP 160/95")
    medicComment  : optional medic free-text attached to the system entry
    refIndex      : index into vitalHistory / assessmentHistory / ecgRecords
    """

    timestamp: str
    type: Literal["note", "vitals_update", "assessment_update", "ecg_upload"]
    autoSummary: Optional[str] = None
    medicComment: Optional[str] = None
    refIndex: Optional[int] = None


# =============================================================================
# Root Model — FHIRBundle
# =============================================================================


class FHIRBundle(BaseModel):
    """
    Root Pydantic model — the complete EMS Handoff FHIR Bundle.

    This is THE validation boundary for POST /api/ems-to-db. Every FHIR
    payload submitted by a field medic is run through this model before any
    data persistence. Invalid payloads are rejected here with a structured
    error; they never reach Cosmos DB or traverse the VNet.

    Key design decisions:
    ─────────────────────
    hospitalId — Cosmos DB partition key. Enforces an explicit allowlist
    of three hospitals; also serves as the SignalR userId target for
    data isolation. Only HUP-PAV documents reach HUP-PAV dashboards.

    handoffStatus — PHI lifecycle sentinel at the Bundle root (not nested
    in EncounterResource). Placed at root so arrival_bp.py can patch it
    with a single dict key before upsert_item(), triggering the Change Feed.

    editCount / isEdited / lastEditedAt — Backend-controlled edit tracking.
    Never trusted from the client. Set exclusively by read-before-write
    logic in ingestion_bp.py. Drives the amber "(Edited xN)" badge on the
    hospital dashboard.

    arrivedAt — Server-injected UTC ISO 8601 timestamp set by arrival_bp.py
    at archival time. Never submitted by medics. The server timestamp is the
    authoritative legal record.

    ecgRecords — Ordered list of ECG uploads. Empty list = no ECG uploaded.
    Frontend always renders ecgRecords[-1] as the "Current" ECG.

    vitalHistory / assessmentHistory / transportLog — Immutable append-only
    history arrays for en-route reassessments. index 0 = Initial (locked).
    """

    model_config = ConfigDict(populate_by_name=True)

    resourceType: Literal["Bundle"]
    hospitalId: Literal["HUP-PAV", "HUP-PRESBY", "HUP-CEDAR"]
    id: str
    timestamp: str
    handoffStatus: Literal["inbound", "arrived"] = Field(
        default="inbound",
        description=(
            "PHI lifecycle state. 'inbound' = active patient en route. "
            "'arrived' = patient delivered, archival in progress."
        ),
    )

    # ── Medic Profile Fields ────────────────────────────────────────────────
    medicUnit: Optional[int] = Field(
        default=None,
        description="EMS unit number of the responding crew (e.g., 42).",
    )
    medicName: Optional[str] = Field(
        default=None,
        description="Full name of the primary/lead medic on this call.",
    )
    medicPhone: Optional[str] = Field(
        default=None,
        description="Direct callback number for the crew. Format: XXX-XXX-XXXX.",
    )
    medicUnitType: Optional[Literal["ALS", "BLS"]] = Field(
        default=None,
        description="ALS (Advanced Life Support) or BLS (Basic Life Support) unit designation."
    )

    # ── Point of Origin ─────────────────────────────────────────────────────
    fromOrigin: Optional[FromOrigin] = Field(
        default=None,
        description="Structured point-of-origin: source type (e.g., 'Scene', 'SNF') and street address.",
    )

    # ── Server-Side Timestamps ──────────────────────────────────────────────
    arrivedAt: Optional[str] = Field(
        default=None,
        description="Server-injected ISO 8601 UTC timestamp set by arrival_bp.py. Never submitted by medics.",
    )

    # ── Edit Tracking (backend-controlled) ─────────────────────────────────
    editCount: int = Field(
        default=0,
        description="Backend-incremented counter tracking re-submissions. Never trusted from client payload.",
    )
    isEdited: bool = Field(
        default=False,
        description="True when editCount > 0. Drives the amber '(Edited xN)' badge on the hospital dashboard.",
    )
    lastEditedAt: Optional[str] = Field(
        default=None,
        description="Server-injected UTC timestamp of the most recent edit. Never submitted by medics.",
    )

    # ── ECG Serial List ─────────────────────────────────────────────────────
    ecgRecords: List[EcgRecord] = Field(
        default_factory=list,
        description=(
            "Ordered list of ECG uploads for this encounter. "
            "First entry is 'Initial', subsequent are 'Update HH:MM'. "
            "Frontend always displays ecgRecords[-1] as 'Current'. "
            "Empty list means no ECG uploaded."
        ),
    )

    # ── History Arrays ──────────────────────────────────────────────────────
    vitalHistory: Optional[List[VitalSignEntry]] = Field(
        default=None,
        description="Ordered list of timestamped vital sign snapshots. index 0 = Initial (locked).",
    )
    assessmentHistory: Optional[List[AssessmentEntry]] = Field(
        default=None,
        description="Ordered list of timestamped assessment snapshots. Same index pattern as vitalHistory.",
    )
    transportLog: Optional[List[TransportLogEntry]] = Field(
        default=None,
        description="Append-only typed transport log. Types: note | vitals_update | assessment_update | ecg_upload.",
    )

    entry: List[BundleEntry]

    # ── Field Validator: medicPhone ─────────────────────────────────────────
    @field_validator("medicPhone")
    @classmethod
    def validate_phone_format(cls, v: Optional[str]) -> Optional[str]:
        """
        Enforces XXX-XXX-XXXX format on medicPhone when present.

        WHY @field_validator OVER a Pydantic regex Field constraint:
        ─────────────────────────────────────────────────────────────
        A Field(pattern=...) constraint produces a generic "String should
        match pattern" error message. A @field_validator produces a
        custom, human-readable message that tells the medic's PWA exactly
        what format is expected. In an operational EMS context, error
        messages must be actionable — not cryptic regex strings.
        """
        if v is None:
            return v
        _PHONE_PATTERN = re.compile(r"^\d{3}-\d{3}-\d{4}$")
        if not _PHONE_PATTERN.match(v):
            raise ValueError(
                f"medicPhone '{v}' does not match required format XXX-XXX-XXXX. "
                "Example: '215-555-0199'. Dashes are required."
            )
        return v


# =============================================================================
# Request Bouncers — HTTP Entry Point Validation Models
# =============================================================================


class ArrivalRequest(BaseModel):
    """
    Pydantic Bouncer for POST /api/ems-arrival.

    Validates the minimal payload required to trigger the PHI archival
    lifecycle. The arrival function uses these two fields to:
      1. Perform a single-partition point read from Cosmos DB
      2. Upload the bundle to Blob Storage
      3. Delete the hot Cosmos record

    hospitalId re-enforces the hospital allowlist at the arrival boundary,
    ensuring the blob path is constructed only from validated values.
    """

    bundle_id: str
    hospitalId: Literal["HUP-PAV", "HUP-PRESBY", "HUP-CEDAR"]


class RecoverRequest(BaseModel):
    """
    Pydantic Bouncer for POST /api/recover-handoff.

    Validates the payload required to restore an archived patient to the
    live queue. The hospitalId allowlist ensures the blob path used for
    the archive read is constructed only from validated values — preventing
    cross-hospital archive access via a crafted bundle_id + wrong hospitalId.
    """

    bundle_id: str
    hospitalId: Literal["HUP-PAV", "HUP-PRESBY", "HUP-CEDAR"]


class ChatMessage(BaseModel):
    """
    Represents a single message in the bidirectional EMS <-> Hospital chat log.

    Used for serialization only — NOT a Pydantic Bouncer at an HTTP boundary.
    Messages are validated via SendChatRequest and stored as dicts within the
    inbound-chat Cosmos document's `messages` array.

    authorSource distinguishes the originating side of the conversation,
    enabling the frontend to apply different visual treatments per sender.
    """

    messageId: str
    text: str
    authorRole: str
    authorName: str
    authorSource: Literal["EMS", "HOSPITAL"]
    createdAt: str  # ISO 8601 UTC


class SendChatRequest(BaseModel):
    """
    Pydantic Bouncer for POST /api/send-chat.

    Validates bidirectional chat messages from either the EMS PWA
    (authorSource='EMS') or the Hospital Dashboard (authorSource='HOSPITAL').

    hospitalId is required for two reasons:
      1. Authorization — only messages targeting a valid hospital are accepted.
      2. SignalR dual fan-out — the backend broadcasts to userId=hospitalId
         AND userId=bundleId simultaneously. Both targets are needed.

    bundleId is the inbound-chat Cosmos document id AND partition key.
    """

    bundleId: str
    hospitalId: str
    messageText: str
    authorRole: str
    authorName: str
    authorSource: Literal["EMS", "HOSPITAL"]

    @field_validator("hospitalId")
    @classmethod
    def validate_hospital(cls, v: str) -> str:
        _VALID = {"HUP-PAV", "HUP-PRESBY", "HUP-CEDAR"}
        if v not in _VALID:
            raise ValueError(f"Invalid hospitalId '{v}'.")
        return v

    @field_validator("messageText")
    @classmethod
    def validate_text(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("messageText cannot be blank.")
        if len(v) > 1000:
            raise ValueError(f"messageText too long ({len(v)} chars). Maximum is 1000.")
        return v

    @field_validator("authorRole", "authorName")
    @classmethod
    def validate_non_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Field cannot be blank.")
        return v


class DivertRequest(BaseModel):
    """
    Pydantic Bouncer for POST /api/divert-handoff.

    Validates a cross-partition patient migration from one hospital's Cosmos
    partition to another.

    WHY a @model_validator for the old == new check:
    A @field_validator only sees one field at a time. Comparing two fields
    requires a @model_validator that runs after both are individually validated.
    Without this guard, a medic could "divert" a patient to the same hospital,
    creating a delete-then-reinsert cycle with no clinical purpose.
    """

    bundle_id: str
    old_hospital_id: Literal["HUP-PAV", "HUP-PRESBY", "HUP-CEDAR"]
    new_hospital_id: Literal["HUP-PAV", "HUP-PRESBY", "HUP-CEDAR"]

    @model_validator(mode="after")
    def validate_different_hospitals(self) -> "DivertRequest":
        if self.old_hospital_id == self.new_hospital_id:
            raise ValueError(
                f"old_hospital_id and new_hospital_id cannot be the same "
                f"('{self.old_hospital_id}'). Diversion requires a different destination."
            )
        return self


class EcgUploadRequest(BaseModel):
    """
    Pydantic Bouncer for POST /api/upload-ecg.
    Validates the non-file metadata fields before processing the binary upload.

    WHY a separate Bouncer for the metadata:
    ─────────────────────────────────────────
    The ECG endpoint receives a multipart/form-data request containing both
    a binary image file and metadata fields. Pydantic cannot validate the
    entire multipart body in one pass (file bytes are not a Pydantic field).
    Validating metadata first means invalid requests are rejected with 400
    before any Blob Storage I/O is attempted — fast fail, zero wasted I/O.
    """

    bundle_id: str
    hospitalId: Literal["HUP-PAV", "HUP-PRESBY", "HUP-CEDAR"]
    rhythmInterpretation: Optional[str] = None

    @field_validator("bundle_id")
    @classmethod
    def validate_bundle_id(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("bundle_id cannot be blank.")
        return v
