# Engineering Log — EMS Handoff Dashboard

**Project:** Azure Serverless PHI Pipeline  
**Engineer:** James Youm

This document is a technical case study covering the key phases of this project:
what was built, the engineering decisions behind it, and the test results that
validated each layer.

---

## Phase 1 — Data Contract & Ingestion Pipeline

### What Was Built

**`src/shared/schemas/FHIR-patient-schema-v1.json`** — The canonical FHIR Bundle schema
for an EMS handoff. Defines three resource types per Bundle entry:
- **Patient** — demographics, extensions (age, history, isolation, allergies), emergency contact
- **Encounter** — ESI triage level, chief complaint, ETA, scene safety, last known well
- **Observation** — vital signs (HR, BP, RR, SpO₂, GCS) and a free-text triage note

**`src/api/models.py` — The Pydantic Bouncer**  
Model-first development: the data contract was defined before any function logic was
written. No payload enters the system without passing through this model.

- `hospitalId: Literal["HUP-PAV", "HUP-PRESBY", "HUP-CEDAR"]` — The most critical field.
  Enforces an explicit hospital allowlist and serves as the Cosmos DB partition key.
- Discriminated Union on `resourceType` — Routes each Bundle entry to `PatientResource`,
  `EncounterResource`, or `ObservationResource` for resource-specific error messages.
- `valueQuantity.value: Optional[float]` — Enforces numeric types on vital signs.
  Rejects strings like `"CRITICAL"` submitted for heart rate with a precise field-path error.
- All demographic fields (`name`, `gender`, `birthDate`) are `Optional` to support
  unidentified emergency patients (e.g., a STEMI arrest with no ID).

**`src/api/shared_clients.py` — SDK Singletons**  
Initializes `DefaultAzureCredential`, `CosmosClient`, and `BlobServiceClient` once at
module load. Python's import cache guarantees a single initialization regardless of how
many blueprints import the module — one credential token, one HTTPS connection pool,
shared across all warm invocations.

**`src/api/blueprints/ingestion_bp.py` — `POST /api/ems-to-db`**  
Parse JSON → Pydantic validation → Cosmos DB `upsert_item()`. The upsert is idempotent —
repeated submissions of the same `bundle_id` overwrite the existing document rather than
producing a 409 Conflict. On success (201), returns `bundle_id` and `hospitalId` for PWA
session storage persistence (consumed by the arrival trigger).

### Test Results

| Test | Payload | Result |
|------|---------|--------|
| Clean handoff | `cleanhandoff-ems-to-db-v1.json` | 201 Created — Cosmos write confirmed in HUP-PAV partition |
| Unknown patient | `unknownhandoff-ems-to-db-v1.json` | 201 Created — "Unknown" demographics accepted |
| Dirty payload | `dirtyhandoff-ems-to-db-v1.json` | 400 Bad Request — missing `hospitalId` + type-mismatched vital sign both caught in one response |

---

## Phase 2 — PHI Lifecycle & Write-Before-Delete Architecture

### What Was Built

**`src/api/blueprints/arrival_bp.py` — `POST /api/ems-arrival`**  
Implements the **Write-Before-Delete** pattern:

```
[1] Validate ArrivalRequest
[2] READ bundle from Cosmos DB
[3] PATCH handoffStatus="arrived" + arrivedAt timestamp → UPSERT
[4] BROADCAST "arrived" directly to SignalR (sub-100ms)
[5] UPLOAD bundle JSON → Blob Storage
        └─ If upload FAILS → 500, Cosmos UNTOUCHED, safe to retry
[6] DELETE bundle from Cosmos DB (only after confirmed Blob write)
[7-9] Best-effort: archive chat, clean up comments → 200
```

**Safety guarantee:** The Python control flow structurally enforces that `delete_item()`
is unreachable if `upload_blob()` raises an exception. This is not a comment or convention —
it is a hard code-path guarantee. The failure matrix:

| Scenario | Blob | Cosmos | PHI Safe? |
|----------|------|--------|-----------|
| Upload fails | ❌ | ✅ Intact | ✅ Retry safe |
| Upload OK, Delete fails | ✅ | ✅ Still present | ✅ Retry safe |
| Both succeed | ✅ | ✅ Deleted | ✅ Lifecycle complete |

**Stateless design:** Both `bundle_id` and `hospitalId` are provided by the caller
(from PWA session storage). Any Function App instance handles the request identically.

### Test Results

| Test | Input | Result |
|------|-------|--------|
| Clean archival | `EMS-HANDOFF-CLEAN-TEST-V1` / HUP-PAV | 200 OK — Blob written at `handoff-archive/HUP-PAV/...`, Cosmos deleted |
| Unknown patient | `EMS-HANDOFF-UNKNOWN-TEST-V1` / HUP-PRESBY | 200 OK — Write-Before-Delete confirmed |
| Idempotency check | Re-submit same IDs post-archival | 404 Not Found — hot partition clean, graceful handling |

---

## Phase 3 — Real-Time Hospital Dashboard

### What Was Built

**Backend Extensions:**
- `PatientResource.computed_age` — `@computed_field` derived from `birthDate` at validation
  time. Read-only: callers cannot inject a false age via payload.
- `FHIRBundle.handoffStatus` — Placed at Bundle root (not nested in `EncounterResource`)
  so `arrival_bp.py` patches it with a single dict key before `upsert_item()`.
- `streaming_bp.py` — Cosmos DB Change Feed trigger. On every INSERT/UPDATE to `handoffs`,
  extracts `hospitalId` and broadcasts a `handoffUpdate` SignalR message targeted by
  `userId=hospitalId`. Data isolation enforced at the transport layer.
- `negotiate_bp.py` — Issues signed SignalR JWTs with `userId=hospitalId` after allowlist
  validation. Invalid `hospitalId` → 400, no token issued.
- `active_handoffs_bp.py` — Single-partition query for `handoffStatus="inbound"` documents.
  Populates the dashboard on page load before the WebSocket connection is established.
- `fetch_archive_bp.py` — Blob Storage proxy. Reads archived PHI via `DefaultAzureCredential`
  — the credential never reaches the browser.
- `comment_bp.py` — Staff comment system using a **separate** `handoff-comments` Cosmos
  container. Comments are not PHI and must not pollute the FHIR schema or the archive.

**Hospital Dashboard PWA:**  
React 18 + TypeScript + Vite with a `useReducer`-based state manager (`usePatientQueue`)
and a WebSocket lifecycle hook (`useSignalR`). Key design decisions:

- `state.liveQueue: Record<string, FHIRBundle>` — O(1) upsert/lookup by `bundleId`
- `state.comments: CommentMap` — `Record<string, HospitalComment[]>` — isolated from FHIR state
- Recovery-aware reducer: when `HANDOFF_UPDATE` with `handoffStatus="inbound"` arrives for
  a `bundleId` that exists in `history[]`, the reducer moves it back to `liveQueue`
- Role-based gating: Arrive/Restore buttons are structurally absent from DOM for GENERAL roles

### Test Results

| Test | Feature | Result |
|------|---------|--------|
| SignalR negotiate | `GET /api/negotiate?hospitalId=HUP-PAV` | 200 OK — JWT issued, WebSocket live |
| Queue hydration | `GET /api/active-handoffs?hospitalId=HUP-PAV` | All inbound bundles returned on load |
| Real-time ingest | POST to `ems-to-db` with dashboard open | Patient row appeared via Change Feed → SignalR in ~1s |
| Arrive patient | Two-step confirm modal | Ghost-card eliminated — row removed on calling browser before SignalR round-trip |
| OVERDUE display | Past-ETA fixture | Red row, `OVERDUE +Nmin` badge correct |
| Abnormal vitals | ESI-1 fixture (HR 112, BP 188/108) | `(!) 112 bpm`, `(!) 188/108 mmHg` in red bold |
| Hospital isolation | HUP-PAV + HUP-PRESBY open simultaneously | No cross-hospital document leakage confirmed |

---

## Phase 4 — Full-Stack Bidirectional Platform

### What Was Built

**Backend — New Endpoints:**

- **`chat_bp.py`** — `GET /api/get-chat` + `POST /api/send-chat`. Bidirectional EMS ↔ Hospital
  chat in the `inbound-chat` Cosmos container (partitioned by `/bundleId`). Dual SignalR
  fan-out to both `userId=hospitalId` and `userId=bundleId` on every message.

- **`ems_negotiate_bp.py`** — `GET /api/ems-negotiate`. Patient-scoped SignalR JWT with
  `userId=bundleId`. The EMS PWA connects as the specific patient encounter rather than
  as a hospital — enabling bidirectional message delivery to the correct device.

- **`divert_handoff_bp.py`** — `POST /api/divert-handoff`. Cross-partition patient migration.
  9-step lifecycle: Pydantic Bouncer → READ → UPSERT new partition → DELETE old partition →
  best-effort comment/chat cleanup → dual SignalR broadcast. A `@model_validator` ensures
  `old_hospital_id != new_hospital_id` before any I/O is attempted.

- **`ecg_bp.py`** — `POST /api/upload-ecg` + `GET /api/get-ecg` + `DELETE /api/delete-ecg`.
  Unique blob paths per upload (`ecg-{epoch_ms}.{ext}`), `blobKey` per `EcgRecord`,
  dual SignalR broadcast. Serial ECG list on the FHIR Bundle supports temporal comparison.

- **`ingestion_bp.py` (updated)** — Server-side edit detection via read-before-write.
  `editCount`, `isEdited`, `lastEditedAt` are never trusted from the client payload —
  computed by the backend exclusively.

- **`recover_handoff_bp.py` (updated)** — Fixed to return the full `FHIRBundle` document
  on success. Returning only metadata would produce `bundle.id = undefined` on the EMS PWA,
  causing the SignalR connection to close and the Live View to render blank.

**EMS PWA — Built from Scratch:**

- `ShiftCheckIn` — ALS/BLS unit type, unit number, phone validation, 12-hour session expiry
- `PatientForm` — 7-section collapsible FHIR form, ECG staging with lightbox preview,
  52+ field `buildFHIRBundle()` function
- `LiveHandoffView` — Post-submission medic command center, 8 editable sections,
  server-side immutable history arrays preserved on every section save
- `EcgViewer` — 3-state serial viewer, History Rail, `ComparisonOverlay` with pan/zoom
  and locked merged canvas mode, two-step delete
- `ChatHub` — Mini-bar (compose + last 3 messages) + full overlay, EMS messages LEFT/orange,
  Hospital messages RIGHT/role-colored, optimistic send
- `DivertModal`, `HospitalArrivedNotification`, `EmsHistoryTab` — Full lifecycle with
  two-step confirms and stale-data guard (amber >30s, red >60s)

**Hospital Dashboard Extensions:**

- `vitalHistory[-1]` live row updates — Dashboard rows always show the most recent
  EMS vital snapshot rather than the original submission values
- Notification dots — Sticky leftmost column with pulsing `dotBlue` (unread chat) +
  `dotAmber` (PHI edit). Cleared on Details modal open. Edit detection is server-authoritative
  via `editCount` comparison in the reducer.
- Two-pane Details modal — 65% clinical / 33% chat. Independent scroll panes.
  `@media (max-width: 1024px)` vertical stack fallback.
- `ChatPanel` — Bidirectional chat right pane. CHARGE-only compose. EMS RIGHT/orange,
  Hospital LEFT/role-color.
- Sticky Arrive bar — `position: sticky; bottom: 0` on modal left pane. 3-state:
  idle → confirm → arriving.
- Read-only `EcgViewer` — Separate file from EMS version. No upload, edit, or delete.
- Section flash animation — `@keyframes sectionFlash` applied inline (not CSS class)
  to guarantee restart from frame 0 on every SignalR-pushed update.

### Test Results

| Test | Feature | Result |
|------|---------|--------|
| Chat — real-time | Hospital CHARGE reply | EMS ChatHub received right-aligned reply within 1s |
| Chat — dual fan-out | Send message during active divert | Both HUP-PAV dashboard + EMS PWA received message |
| ECG — serial upload | Upload 2 ECGs for same patient | Both records in `ecgRecords[]`, History Rail populated |
| ECG — delete | Delete second ECG | `blobKey` path resolved, blob deleted, record removed from array |
| ECG — comparison | Select two ECGs in overlay | Side-by-side with pan/zoom and merge canvas |
| Divert — full flow | Divert HUP-PAV → HUP-CEDAR | PAV dashboard removed card, Cedar dashboard added card, EMS PWA updated destination |
| Edit detection | Medic re-submits FHIR bundle | `editCount` incremented server-side, amber badge shown on hospital dashboard |
| Notification dots | Hospital staff unread chat | Blue dot appeared on patient row, cleared on modal open |
| Restore from archive | Hospital clicks Restore | Full FHIRBundle returned, EMS LiveView reloaded, all dashboards updated via Change Feed |
| TypeScript build | `npx tsc --noEmit` | ✅ 0 errors on both frontends |

---

## Architecture Principles Applied

| Principle | Implementation |
|-----------|---------------|
| **Model-First Development** | `models.py` defined before any route logic. Data contract drives everything. |
| **Write-Before-Delete** | PHI never has a window of zero durable copies during archival. |
| **Singleton Clients** | SDK clients initialized once per process — not once per request. |
| **Open/Closed (Blueprints)** | Adding a route requires zero changes to existing files. |
| **Server-Authoritative Fields** | `editCount`, `arrivedAt`, `lastEditedAt` never trusted from client. |
| **Change Feed as Event Source** | No polling. Database writes ARE the events. |
| **Partition Key = SignalR userId** | One boundary enforces both DB isolation and transport isolation. |
| **Idempotent Operations** | All Cosmos writes use `upsert_item()`. Safe to retry on network failure. |
