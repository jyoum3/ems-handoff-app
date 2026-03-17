# Architecture Reference Document

**EMS Handoff Dashboard** — Azure Serverless PHI Pipeline

---

## Azure Service Topology

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Azure Subscription                                 │
│                                                                             │
│  ┌──────────────────────┐    ┌──────────────────────────────────────────┐  │
│  │  Azure Static Web    │    │  Azure Static Web Apps                   │  │
│  │  Apps (EMS PWA)      │    │  (Hospital Dashboard PWA)                │  │
│  │  ems-ingestion/      │    │  hospital-dashboard/                     │  │
│  └──────────┬───────────┘    └──────────────────────┬───────────────────┘  │
│             │  HTTPS /api/*                          │ HTTPS /api/*         │
│             ▼                                        │                      │
│  ┌──────────────────────────────────────────────────▼───────────────────┐  │
│  │                     Azure Functions App (Python 3.11)                │  │
│  │                        src/api/function_app.py                       │  │
│  │                                                                      │  │
│  │  HTTP Triggers                    Change Feed Trigger                │  │
│  │  ─────────────                    ────────────────────               │  │
│  │  ingestion_bp    ─────────────►   streaming_bp                       │  │
│  │  arrival_bp      ─────────────►   (listens on handoffs container)    │  │
│  │  negotiate_bp                                                        │  │
│  │  ems_negotiate_bp                                                    │  │
│  │  active_handoffs_bp                                                  │  │
│  │  fetch_archive_bp                                                    │  │
│  │  recover_handoff_bp                                                  │  │
│  │  comment_bp                                                          │  │
│  │  chat_bp                                                             │  │
│  │  divert_handoff_bp                                                   │  │
│  │  ecg_bp                                                              │  │
│  └──────┬──────────────┬─────────────────────┬────────────────┬────────┘  │
│         │              │                     │                │            │
│         ▼              ▼                     ▼                ▼            │
│  ┌─────────────┐ ┌──────────────┐ ┌────────────────┐ ┌────────────────┐  │
│  │  Azure      │ │  Azure Blob  │ │  Azure SignalR  │ │  Azure AD      │  │
│  │  Cosmos DB  │ │  Storage     │ │  Service        │ │  (Entra ID)    │  │
│  │  (Core API) │ │              │ │  (Serverless)   │ │                │  │
│  │             │ │  handoff-    │ │                 │ │  Service       │  │
│  │  handoffs   │ │  archive/    │ │  Hub: EmsHandoff│ │  Principal     │  │
│  │  comments   │ │  ecg-uploads/│ │                 │ │  (local dev)   │  │
│  │  inbound-   │ │              │ │  WS → Hospital  │ │                │  │
│  │  chat       │ │              │ │  WS → EMS PWA   │ │  Managed       │  │
│  │  leases     │ │              │ │                 │ │  Identity      │  │
│  └─────────────┘ └──────────────┘ └────────────────┘ │  (production)  │  │
│                                                        └────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow — End to End

### Flow 1: EMS Handoff Submission

```
EMS Medic (PWA)
    │
    │  POST /api/ems-to-db
    │  { FHIR Bundle JSON }
    ▼
ingestion_bp.py
    ├─ [1] JSON parse
    ├─ [2] FHIRBundle.model_validate(payload)    ← Pydantic Bouncer
    │       hospitalId: Literal["HUP-PAV", ...]  ← Allowlist enforced
    │       entry[].resource discriminated union ← Surgical validation
    ├─ [3] Cosmos READ (check for existing doc → editCount tracking)
    ├─ [4] cosmos_container.upsert_item(bundle)  ← Idempotent, retry-safe
    │
    ▼
Cosmos DB: handoffs container
    │  partition key: hospitalId = "HUP-PAV"
    │
    ▼  (Change Feed fires on INSERT/UPDATE)
streaming_bp.py
    ├─ Extract hospitalId from document
    └─ SignalR broadcast → userId="HUP-PAV"
              │
              ▼
    Hospital Dashboard WebSocket
    ├─ HANDOFF_UPDATE action dispatched
    └─ Patient card appears in live queue
```

### Flow 2: PHI Lifecycle — Arrival / Archival

```
EMS Medic or Hospital Staff
    │
    │  POST /api/ems-arrival
    │  { bundle_id, hospitalId }
    ▼
arrival_bp.py
    ├─ [1] ArrivalRequest Bouncer
    ├─ [2] Cosmos READ  → fetch bundle document
    ├─ [3] PATCH: handoffStatus="arrived", arrivedAt=UTC_NOW
    │       Cosmos UPSERT → Change Feed fires (secondary notification)
    ├─ [4] SignalR OUTPUT BINDING (direct, sub-100ms)
    │       userId=hospitalId → "arrived" event → dashboard removes card
    │       userId=bundleId  → EMS PWA notified
    ├─ [5] Blob UPLOAD → handoff-archive/{hospitalId}/{date}/{bundleId}/handoff.json
    │       └─ 500 if fails → Cosmos record UNTOUCHED (safe to retry)
    ├─ [6] Cosmos DELETE  ← only reached after confirmed Blob write
    ├─ [7] Chat companion ARCHIVE (best-effort)
    │       inbound-chat doc → Blob archive/{...}/chat.json
    └─ [8] Comment doc CLEANUP (best-effort)
            handoff-comments doc deleted

Failure Safety Matrix:
    Blob upload fails  → 500, Cosmos record intact, retry safe
    Cosmos delete fails → 500, PHI safe in Blob, retry safe
    Chat archive fails  → non-fatal, logged, lifecycle continues
    Comment cleanup fails → non-fatal, logged, lifecycle continues
```

### Flow 3: Bidirectional Chat

```
EMS Medic or Hospital Staff
    │
    │  POST /api/send-chat
    │  { bundleId, hospitalId, messageText, authorRole, authorName, authorSource }
    ▼
chat_bp.py
    ├─ [1] SendChatRequest Bouncer
    ├─ [2] Cosmos READ: inbound-chat/{bundleId}
    │       └─ 404 → create new chat document
    ├─ [3] Append ChatMessage { messageId, text, role, source, createdAt }
    ├─ [4] Cosmos UPSERT: inbound-chat/{bundleId}
    └─ [5] Dual SignalR fan-out:
            userId=hospitalId → "chatUpdate" → Hospital Dashboard
            userId=bundleId   → "chatUpdate" → EMS PWA ChatHub
```

### Flow 4: Patient Diversion (Cross-Partition Migration)

```
EMS Medic
    │
    │  POST /api/divert-handoff
    │  { bundle_id, old_hospital_id: "HUP-PAV", new_hospital_id: "HUP-CEDAR" }
    ▼
divert_handoff_bp.py
    ├─ [1] DivertRequest Bouncer
    │       @model_validator ensures old != new
    ├─ [2] Cosmos READ: handoffs/{bundle_id} (old partition)
    ├─ [3] Mutate: hospitalId = new_hospital_id
    ├─ [4] Cosmos UPSERT: new partition (HUP-CEDAR)
    │       Change Feed fires → HUP-CEDAR dashboard adds patient
    ├─ [5] Cosmos DELETE: old partition (HUP-PAV)
    │       (best-effort comment + chat cleanup)
    └─ [6] Dual SignalR broadcast:
            userId=HUP-PAV   → "diverted" action → PAV dashboard removes card
            userId=HUP-CEDAR → "inbound" action  → Cedar dashboard adds card
            userId=bundleId  → "diverted" action → EMS PWA updates destination
```

### Flow 5: Patient Recovery (Archive → Live Queue Restore)

```
Hospital Staff (CHARGE or PFC role only)
    │
    │  POST /api/recover-handoff
    │  { bundle_id, hospitalId }
    ▼
recover_handoff_bp.py
    ├─ [1] RecoverRequest Bouncer
    ├─ [2] Blob LISTING: find blob path (new nested or legacy flat format)
    ├─ [3] Blob DOWNLOAD: handoff-archive/{hospitalId}/.../{bundle_id}/handoff.json
    ├─ [4] FHIRBundle re-validation (defensive — schema may have evolved)
    ├─ [5] PATCH: handoffStatus="inbound", arrivedAt=None
    ├─ [6] Cosmos UPSERT ← CRITICAL: triggers Change Feed
    │       All dashboards: patient moves from history → live queue
    ├─ [7] SignalR broadcast → userId=bundleId
    │       EMS PWA: "restored" action
    ├─ [8] Blob UPDATE: overwrite with handoffStatus="inbound"
    │       Prevents stale "arrived" entry in history on refresh
    │       (non-fatal if fails — Cosmos already succeeded)
    └─ [9] Chat companion RESTORE (best-effort)
            Blob chat doc → re-upsert to inbound-chat container
```

---

## Cosmos DB Container Design

| Container | Partition Key | Purpose | Notes |
|-----------|--------------|---------|-------|
| `handoffs` | `/hospitalId` | Active FHIR Bundles | Hot partition. Change Feed enabled. |
| `handoff-comments` | `/hospitalId` | Hospital staff notes | NOT PHI. Separate schema. |
| `inbound-chat` | `/bundleId` | EMS ↔ Hospital chat | Partitioned by bundleId — survives diversion |
| `leases` | `/id` | Change Feed bookmarks | Auto-created by streaming_bp trigger |

**Why `handoffs` partitions by `hospitalId` and not `bundleId`:**

The hospital dashboard's primary access pattern is "give me all active handoffs for HUP-PAV." If partitioned by `bundleId`, this query would scatter across all physical partitions — a cross-partition fan-out that wastes RU/s and adds latency. Partitioning by `hospitalId` collocates all documents for one hospital on the same physical partition, making the dashboard hydration query a single-partition O(N) read.

**Why `inbound-chat` partitions by `bundleId` and not `hospitalId`:**

Chat belongs to one patient encounter, not one hospital. If a patient diverts from HUP-PAV to HUP-CEDAR, the Cosmos DB partition key on the chat document **cannot change** — you would have to delete and recreate the document. During a live clinical handoff, that window of data absence is unacceptable. Partitioning by `bundleId` means the chat document is immovable and always accessible by its natural key.

---

## Blob Storage Structure

### `handoff-archive` container

```
handoff-archive/
└── {hospitalId}/                        e.g., HUP-PAV/
    └── {YYYY-MM-DD}/                    e.g., 2026-03-15/
        └── {bundleId}/                  e.g., EMS-HANDOFF-MAX-001/
            ├── handoff.json             ← Full FHIR Bundle at time of arrival
            └── chat.json                ← Chat companion (if any messages)
```

The date subfolder was chosen over a flat `{hospitalId}/{bundleId}.json` structure to enable:
1. Date-range queries without scanning the entire container
2. Same-patient re-visit separation (same patient, different encounter, different date)
3. Azure Blob lifecycle policy rules targeting specific date ranges

### `ecg-uploads` container

```
ecg-uploads/
└── {hospitalId}/                        e.g., HUP-PAV/
    └── {bundleId}/                      e.g., EMS-HANDOFF-MAX-001/
        ├── ecg-1710000000001.jpg        ← ecg-{epoch_ms}.{ext}
        └── ecg-1710000000512.png
```

Each ECG upload gets a unique millisecond-epoch filename to prevent overwrites between serial uploads. The `EcgRecord` list in the FHIR Bundle document tracks the full serial history (timestamps, labels, rhythm interpretations, blobKeys). Blob Storage holds the binary images; Cosmos holds the structured metadata.

---

## SignalR Architecture

### Serverless Mode

The Function App does NOT act as the WebSocket hub. Clients connect directly to Azure SignalR Service. The Function App only:
1. Issues signed tokens via `/api/negotiate` and `/api/ems-negotiate` (once per connection)
2. POSTs messages to SignalR Service via output bindings (once per DB write)

This means idle WebSocket connections consume zero Function App execution time. The Functions are only invoked when data changes or a new client connects.

### Data Isolation via userId Targeting

```
negotiate_bp.py:
    issues JWT with userId = "HUP-PAV"

streaming_bp.py:
    targets userId = document["hospitalId"]    ← "HUP-PAV"
    SignalR delivers ONLY to connections with sub="HUP-PAV"

A HUP-CEDAR session NEVER receives a HUP-PAV broadcast.
Enforcement is at the SignalR Service transport layer — not in JS.
```

### Dual Fan-Out Pattern

Several operations require broadcasting to two audiences simultaneously:
- **Hospital Dashboard** (`userId=hospitalId`) — for queue updates
- **EMS PWA** (`userId=bundleId`) — for the originating medic's device

Functions that implement this pattern: `arrival_bp.py`, `chat_bp.py`, `divert_handoff_bp.py`, `ecg_bp.py`, `recover_handoff_bp.py`.

The two messages are built as a JSON array and set in a single call to the output binding, which POSTs them to SignalR Service in one request.

---

## Authentication & Identity Model

### Credential Chain (DefaultAzureCredential)

```
Local Development:                    Azure Production:
─────────────────                     ────────────────
AZURE_CLIENT_ID    ┐                  Function App
AZURE_CLIENT_SECRET├─► Service        Managed Identity ──► All Azure services
AZURE_TENANT_ID    ┘   Principal      (no credentials needed)
  (in local.settings.json,
   gitignored)
```

One `DefaultAzureCredential` instance in `shared_clients.py` is shared across ALL SDK clients. The underlying token cache is shared — a token acquired for Cosmos is reused by Blob Storage and SignalR within the same expiry window.

### Change Feed Trigger — Separate Credential Prefix

The Cosmos DB Change Feed trigger (`streaming_bp.py`) requires credentials in the `EmsDb__*` env var family (Azure Functions host convention for identity-based trigger connections). These are separate from the `AZURE_*` vars used by the shared SDK clients but resolve to the same Service Principal in local dev.

---

## Environment Variables Reference

| Variable | Used By | Description |
|----------|---------|-------------|
| `COSMOS_DB_ENDPOINT` | `shared_clients.py` | Cosmos DB account URI |
| `BLOB_SERVICE_ENDPOINT` | `shared_clients.py` | Blob Storage account URI |
| `ARCHIVE_CONTAINER_NAME` | `arrival_bp`, `recover_handoff_bp`, `fetch_archive_bp` | Blob container for PHI archive |
| `COMMENTS_CONTAINER_NAME` | `shared_clients.py` | Cosmos container for staff comments |
| `CHAT_CONTAINER_NAME` | `shared_clients.py` | Cosmos container for EMS ↔ Hospital chat |
| `ECG_CONTAINER_NAME` | `shared_clients.py` | Blob container for ECG images (default: `ecg-uploads`) |
| `AzureSignalRConnectionString` | All SignalR output bindings + negotiate bindings | SignalR Service connection (SP format for local, MSI for Azure) |
| `EmsDb__accountEndpoint` | `streaming_bp.py` (Change Feed trigger) | Cosmos account URI for Change Feed auth prefix |
| `EmsDb__credential` | `streaming_bp.py` | `"clientsecret"` for SP-based local dev |
| `EmsDb__clientId` | `streaming_bp.py` | Service Principal client ID |
| `EmsDb__clientSecret` | `streaming_bp.py` | Service Principal client secret |
| `EmsDb__tenantId` | `streaming_bp.py` | Azure AD tenant ID |
| `AZURE_CLIENT_ID` | `DefaultAzureCredential` | Service Principal client ID |
| `AZURE_CLIENT_SECRET` | `DefaultAzureCredential` | Service Principal client secret |
| `AZURE_TENANT_ID` | `DefaultAzureCredential` | Azure AD tenant ID |

**All of the above are set in `local.settings.json` for local development and in Azure App Settings for production. `local.settings.json` is gitignored and must never be committed.**

---

## Frontend Architecture

Both PWAs share the same stack and build toolchain:

```
React 18 + TypeScript + Vite
    │
    ├── src/types/fhir.ts          ← TypeScript interfaces mirroring Pydantic models
    ├── src/services/api.ts         ← All HTTP calls, typed return types
    ├── src/hooks/                  ← Custom hooks (SignalR, state, session)
    ├── src/components/             ← UI components (CSS Modules, no global styles)
    └── src/utils/                  ← Pure, side-effect-free helper functions
```

**API Contract Alignment:** The TypeScript `FHIRBundle` interface in `src/types/fhir.ts` must mirror the Python `FHIRBundle` Pydantic model in `src/api/models.py`. When a new field is added to the Pydantic model, the corresponding TypeScript interface must be updated in both frontend projects.

**Vite Dev Proxy:** The `vite.config.ts` in each frontend proxies `/api/*` to `http://localhost:7071` (Azure Functions Core Tools default port) during local development. No CORS configuration is needed — the proxy appears as the same origin to the browser.

**PWA Configuration:** Both apps include `public/manifest.json` and `public/staticwebapp.config.json`. The SWA config enforces SPA routing (all paths → `index.html`), sets `X-Frame-Options: DENY`, and configures a Content Security Policy.

---

## RBAC Summary (Role-Based Access Control)

| Role | Can Arrive Patient | Can Restore Patient | Can Send Chat | Can Add Comment |
|------|:-----------------:|:-------------------:|:-------------:|:---------------:|
| CHARGE | ✅ | ✅ | ✅ | ✅ |
| PFC | ✅ | ✅ | — | ✅ |
| INTAKE | ✅ | — | — | ✅ |
| GENERAL-1 | — | — | — | — |
| GENERAL-2 | — | — | — | — |

Role state is stored in `sessionStorage` (not `localStorage`) and carries a 12-hour expiry timestamp. Expired sessions are cleared on next page load, requiring re-check-in. Role is checked in the reducer and conditionally renders action buttons — privileged actions are structurally absent from the DOM for non-privileged roles (not disabled, absent).

**Note:** Role enforcement in this portfolio implementation is client-side session state. In a production HIPAA environment, roles would be derived from Entra ID token claims issued by the identity provider, validated by the backend on every API call.
