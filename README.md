# EMS Handoff Dashboard

> **A proactive, real-time PHI visibility platform for EMS-to-ED patient handoffs.**
> Built on Azure serverless infrastructure: FHIR-validated data pipeline, Cosmos DB Change Feed streaming, bidirectional EMS ↔ Hospital chat, and serial ECG management.

---

## The Problem

Emergency Medical Services (EMS) crews routinely transport critically ill patients to receiving Emergency Departments with no structured, real-time channel to communicate patient data ahead of arrival. The handoff happens verbally — at the bedside, under pressure — after the patient is already in the department. ED staff have no advance visibility into ESI triage level, vital signs, administered interventions, or required resources until the gurney rolls through the door.

This gap creates intake bottlenecks, delays resource activation (Cath Lab, LVAD specialist, trauma team), and forces nurses to gather clinical information reactively rather than proactively.

---

## Solution Architecture

```
  EMS Medic PWA                          Hospital Dashboard PWA
  ─────────────                          ─────────────────────
  FHIR Bundle submit                     WebSocket (SignalR)
        │                                       ▲
        ▼                                       │
  POST /api/ems-to-db                  Cosmos DB Change Feed
        │                                streaming_bp.py
        ▼                                       │
  Pydantic Bouncer ──────────────────► Cosmos DB (handoffs)
  (models.py)             hospitalId partition
        │
        ├──► Blob Storage (ecg-uploads)        ECG serial viewer
        │
        └──► POST /api/ems-arrival             PHI lifecycle complete
                    │
                    ├──► SignalR broadcast    → Dashboard removes patient card
                    ├──► Blob archive        → handoff-archive/{hospitalId}/{date}/{bundleId}/
                    └──► Cosmos delete       → Hot partition cleared
```

**Key principle:** The Cosmos DB Change Feed is the synchronization backbone. Every Cosmos INSERT or UPDATE automatically triggers a broadcast to all connected hospital dashboard sessions scoped to that `hospitalId`. The dashboard never polls; it receives.

---

## Features

### EMS-Facing PWA (`src/frontend/ems-ingestion/`)
- **Shift Check-In** — Non-dismissible session gate with ALS/BLS unit type, unit number, name, and phone. 12-hour session with auto-expiry.
- **FHIR Patient Form** — 7-section collapsible form mapping 52+ clinical fields to a validated FHIR Bundle: demographics, chief complaint, vitals, assessment, history, interventions, ECG upload, and resource requirements.
- **Live Handoff View** — Post-submission medic command center. 8 editable sections. Server-side edit detection tracks revision count; each re-submission increments `editCount` on the backend.
- **Serial ECG Management** — Upload, label, preview, and delete ECGs with a 3-state serial viewer and side-by-side comparison overlay.
- **Bidirectional Chat** — Real-time EMS ↔ Hospital messaging via Azure SignalR Service. Mini-bar in Live View + full overlay. Optimistic send, stale-connection indicator.
- **Divert Flow** — Cross-partition patient migration with Write-Before-Delete safety: upsert to new hospital partition, SignalR dual fan-out, then delete from old partition.
- **History Tab** — All patients delivered this shift, queryable across all three hospital destinations.

### Hospital-Facing PWA (`src/frontend/hospital-dashboard/`)
- **Live Patient Queue** — Real-time table updated via WebSocket. Columns: ETA, Unit, Status, Patient, Age, ESI, Chief Complaint, 7 vital signs, Required Resources, Comments, Actions. OVERDUE patients flagged with red background and `OVERDUE +Nmin` badge.
- **Abnormal Vital Flagging** — Clinical threshold rules per vital (HR, BP, SpO₂, Temp, Sugar). Abnormal values rendered `(!) {value}` in red bold in the row and detail modal.
- **Patient Detail Modal** — 6-section structured clinical view following the ED nurse cognitive workflow: header, demographics, clinical narrative, vital grid, contextual data, medical background. Read-only ECG serial viewer with comparison overlay.
- **Bidirectional Chat Panel** — Right pane of the detail modal. CHARGE role compose access. EMS messages visually distinct from hospital messages by author source.
- **Staff Comments** — Dedicated `Comments` column. In-row optimistic updates, full thread in edit dialog, real-time broadcast via `commentUpdate` SignalR channel.
- **History Tab** — Arrived patients with full detail access via Blob Storage proxy. Restore button (CHARGE/PFC only) recovers erroneously arrived patients to the live queue.
- **Role-Based Gating** — Five roles: CHARGE, PFC, INTAKE, GENERAL-1, GENERAL-2. Arrive and Restore actions are structurally absent from the DOM for non-privileged roles (not disabled — absent).
- **Connection Status Indicator** — Live/Connecting/Reconnecting/Disconnected with stale-data guard (amber >30s, red >60s).

---

## Tech Stack

| Layer | Technology | Role in This Project |
|-------|-----------|---------------------|
| Frontend | React 18 + TypeScript + Vite | Both PWAs — strict TypeScript, CSS Modules, PWA manifest |
| Real-Time | Azure SignalR Service (Serverless) | WebSocket push from backend to both PWAs |
| Backend | Azure Functions v4 (Python 3.11) | 13 serverless HTTP + Change Feed trigger functions |
| Validation | Pydantic v2 | "Bouncer" — all PHI validated before touching the DB |
| Primary DB | Azure Cosmos DB (Core API) | FHIR bundles, chat, comments — partitioned by `hospitalId` or `bundleId` |
| Cold Storage | Azure Blob Storage | PHI archive, ECG images, chat companion blobs |
| Identity | Azure DefaultAzureCredential | Service Principal (local) → Managed Identity (Azure) |
| Hosting | Azure Static Web Apps | Both frontends with SPA routing and CSP headers |
| Package Mgmt | uv (Python), npm (Node) | Dependency management |

---

## Project Structure

```
ems-handoff-app/
├── README.md                           ← This file
├── ARCHITECTURE.md                     ← Azure topology, data flows, design decisions
├── .gitignore                          ← Secrets, build artifacts, environment files
├── pyproject.toml                      ← Python project metadata + audited dependencies
│
├── src/
│   ├── api/                            ← Azure Functions App (Python)
│   │   ├── function_app.py             ← Entry point — Blueprint registry only
│   │   ├── models.py                   ← Pydantic FHIR data contracts ("The Bouncer")
│   │   ├── shared_clients.py           ← SDK singletons (Cosmos, Blob, Credential)
│   │   ├── requirements.txt            ← Azure Functions runtime dependencies
│   │   ├── host.json                   ← Azure Functions host configuration
│   │   └── blueprints/                 ← One file per route group
│   │       ├── ingestion_bp.py         ← POST /api/ems-to-db
│   │       ├── arrival_bp.py           ← POST /api/ems-arrival
│   │       ├── streaming_bp.py         ← Cosmos Change Feed → SignalR
│   │       ├── negotiate_bp.py         ← GET  /api/negotiate (hospital token)
│   │       ├── ems_negotiate_bp.py     ← GET  /api/ems-negotiate (EMS token)
│   │       ├── active_handoffs_bp.py   ← GET  /api/active-handoffs
│   │       ├── fetch_archive_bp.py     ← GET  /api/fetch-archive
│   │       ├── recover_handoff_bp.py   ← POST /api/recover-handoff
│   │       ├── comment_bp.py           ← GET + POST /api/*-comment
│   │       ├── chat_bp.py              ← GET + POST /api/*-chat
│   │       ├── divert_handoff_bp.py    ← POST /api/divert-handoff
│   │       └── ecg_bp.py               ← POST/GET/DELETE /api/*-ecg
│   │
│   ├── frontend/
│   │   ├── ems-ingestion/              ← EMS medic PWA (React/TypeScript/Vite)
│   │   └── hospital-dashboard/         ← ED staff dashboard (React/TypeScript/Vite)
│   │
│   └── shared/
│       └── schemas/
│           └── FHIR-patient-schema-v1.json   ← Canonical FHIR Bundle schema
│
├── tests/                              ← Integration test payloads and result logs
│   ├── ems-to-db-ingestion/            ← Clean, unknown, and dirty payload fixtures
│   ├── ems-arrival-archival/           ← Archival and idempotency test payloads
│   ├── ems-signalr-streaming/          ← Change Feed + streaming test payloads
│   └── hospital-dashboard/             ← Multi-hospital FHIR Bundle fixtures
│
└── docs/
    ├── ENGINEERING_LOG.md              ← Technical case study — what was built and why
    └── TECHNICAL_REFERENCE.md         ← Architecture decisions, service topology, env vars
```

---

## Key Engineering Decisions

### 1. Discriminated Union Validation (Pydantic v2)
Rather than validating the `entry[]` array as a generic list, `models.py` uses a `discriminated union` on `resourceType`. Pydantic routes each entry to `PatientResource`, `EncounterResource`, `ObservationResource`, or `AssessmentResource` based on the discriminator field. Invalid entries produce surgical, resource-specific error messages — not a generic "union match failed."

### 2. Write-Before-Delete PHI Lifecycle (arrival_bp.py)
The archival sequence is structurally enforced:

```
Cosmos READ → Status PATCH + upsert → Blob UPLOAD → Cosmos DELETE
```

The Cosmos delete is unreachable if the Blob upload raises an exception. PHI exists in at least one durable store at all times. The failure matrix is exhaustive — every failure scenario leaves data recoverable.

### 3. Cosmos DB Partition Key = hospitalId
All FHIR bundles are partitioned by `hospitalId`. This means:
- All queries are single-partition (no cross-partition fan-out, no RU waste)
- The SignalR `userId` target matches the partition key — data isolation is enforced at the DB layer, not just the UI

### 4. Comments in a Separate Container (not embedded on the FHIR bundle)
Hospital staff comments live in `handoff-comments` — a dedicated Cosmos container partitioned by `hospitalId`. They are **not** embedded on the FHIR Bundle. Reasons:
1. Comments are operational metadata, not PHI. They must not pollute the clinical record.
2. PHI is archived at patient arrival; comments are deleted at the same time. If comments were embedded, the archived blob would contain operational staff notes that have no clinical value post-handoff.
3. Comment access patterns differ: the dashboard reads all comments for a hospital in one query on load, not by individual `bundleId`.

### 5. inbound-chat Partitioned by bundleId (not hospitalId)
The chat container is partitioned by `bundleId` because chat belongs to one patient encounter, not one hospital. If a patient is diverted from HUP-PAV to HUP-CEDAR mid-transport, the Cosmos partition key cannot change — you would have to delete and recreate the document, risking data loss during a live clinical event. Partitioning by `bundleId` means the chat document survives diversion unchanged.

---

## Local Development Setup

### Prerequisites
- Python 3.11
- Node.js 18+
- Azure Functions Core Tools v4 (`npm install -g azure-functions-core-tools@4`)
- `uv` package manager (`pip install uv`)
- An Azure subscription with: Cosmos DB account, Blob Storage account, Azure SignalR Service instance

### Backend

```bash
# 1. Activate the virtual environment
./.venv/Scripts/Activate.ps1   # Windows PowerShell
source ./.venv/bin/activate    # macOS/Linux

# 2. Install dependencies
uv pip install -r src/api/requirements.txt

# 3. Create local.settings.json (NEVER commit this file)
# Copy the template below and fill in your Azure resource values

# 4. Start the Function App
cd src/api
func start
```

**`src/api/local.settings.json` template** (gitignored — never commit):
```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "python",
    "COSMOS_DB_ENDPOINT": "https://<your-cosmos-account>.documents.azure.com:443/",
    "BLOB_SERVICE_ENDPOINT": "https://<your-storage-account>.blob.core.windows.net",
    "ARCHIVE_CONTAINER_NAME": "handoff-archive",
    "COMMENTS_CONTAINER_NAME": "handoff-comments",
    "CHAT_CONTAINER_NAME": "inbound-chat",
    "ECG_CONTAINER_NAME": "ecg-uploads",
    "AzureSignalRConnectionString": "Endpoint=https://<signalr>.service.signalr.net;AuthType=azure.app;ClientId=<id>;ClientSecret=<secret>;TenantId=<tenant>",
    "EmsDb__accountEndpoint": "https://<your-cosmos-account>.documents.azure.com:443/",
    "EmsDb__credential": "clientsecret",
    "EmsDb__clientId": "<service-principal-client-id>",
    "EmsDb__clientSecret": "<service-principal-client-secret>",
    "EmsDb__tenantId": "<azure-ad-tenant-id>",
    "AZURE_CLIENT_ID": "<service-principal-client-id>",
    "AZURE_CLIENT_SECRET": "<service-principal-client-secret>",
    "AZURE_TENANT_ID": "<azure-ad-tenant-id>"
  }
}
```

### Hospital Dashboard Frontend

```bash
cd src/frontend/hospital-dashboard
npm install
npm run dev
# Opens at http://localhost:3000
# Vite proxies /api/* → http://localhost:7071 (Azure Functions)
```

### EMS Ingestion Frontend

```bash
cd src/frontend/ems-ingestion
npm install
npm run dev
# Opens at http://localhost:5173
```

---

## Deployment (Azure)

### Live Demo

| App | URL | Access |
|-----|-----|--------|
| **EMS Medic PWA** | `https://red-cliff-065686a0f.4.azurestaticapps.net` | Entra ID login required |
| **Hospital Dashboard** | `https://gray-river-0aac47b0f.2.azurestaticapps.net` | Entra ID login required |

Demo credentials are available on request. Both apps require a Microsoft account or a guest invitation to the project's Entra ID tenant.

### Architecture

Both frontends deploy to **Azure Static Web Apps (Free tier)** with built-in Entra ID authentication. The backend is a single **Azure Functions App** (Python 3.11, Consumption plan) shared by both SWAs via CORS — not the SWA "managed backend link", which restricts a Function App to one SWA.

```
Both SWAs ──(CORS, direct HTTPS)──► Azure Functions App (ems-handoff-api)
                                              │
                                     Managed Identity
                                              │
                              ┌───────────────┼──────────────┐
                        Cosmos DB       Blob Storage    SignalR Service
```

The Function App URL is baked into the frontend bundles at build time via `VITE_API_BASE_URL`, injected by the GitHub Actions workflow `env:` block. In local development, this variable is unset and the fallback `'/api'` path routes through the Vite dev proxy to `localhost:7071`.

### Backend Deployment

```bash
cd src/api
func azure functionapp publish ems-handoff-api --python
```

### Required Azure App Settings (Function App)

| Setting | Value |
|---------|-------|
| `COSMOS_DB_ENDPOINT` | Cosmos DB account URI |
| `BLOB_SERVICE_ENDPOINT` | Storage account blob endpoint |
| `ARCHIVE_CONTAINER_NAME` | `handoff-archive` |
| `COMMENTS_CONTAINER_NAME` | `handoff-comments` |
| `CHAT_CONTAINER_NAME` | `inbound-chat` |
| `ECG_CONTAINER_NAME` | `ecg-uploads` |
| `AzureSignalRConnectionString` | `Endpoint=https://[signalr].service.signalr.net;AuthType=azure.msi` |
| `EmsDb__accountEndpoint` | Cosmos DB account URI |
| `EmsDb__credential` | `managedidentity` |
| `EmsDb__clientId` | Function App Managed Identity client ID |

### Managed Identity RBAC

The Function App's System-Assigned Managed Identity must be granted:
- Cosmos DB: `Cosmos DB Built-in Data Contributor`
- Blob Storage: `Storage Blob Data Contributor`
- SignalR: `SignalR App Server`

### SWA Authentication (Entra ID)

Each SWA requires two Application Settings:
- `AZURE_CLIENT_ID` — App Registration (client) ID
- `AZURE_CLIENT_SECRET` — App Registration client secret

These reference a single App Registration in Entra ID with Redirect URIs:
- `https://red-cliff-065686a0f.4.azurestaticapps.net/.auth/login/aad/callback`
- `https://gray-river-0aac47b0f.2.azurestaticapps.net/.auth/login/aad/callback`

---

## Security Design

| Concern | Implementation |
|---------|---------------|
| **No hardcoded secrets** | All SDK clients use `DefaultAzureCredential`. Zero key strings in code. |
| **PHI never logged** | Only `bundleId` (a non-PHI identifier) appears in all log statements. |
| **Hospital data isolation** | Cosmos partition key = SignalR `userId` = `hospitalId`. One boundary enforces both DB and transport isolation. |
| **Chat PHI guard** | `chatMap` is explicitly excluded from `localStorage`. Chat data is session-only. |
| **Input validation** | Every HTTP entry point runs through a Pydantic `BaseModel` Bouncer before any I/O. |
| **Token scoping** | SignalR tokens issued with `userId=hospitalId` by `negotiate_bp.py` after allowlist validation. Invalid `hospitalId` → 400, no token issued. |
| **Blob path injection** | Blob paths constructed exclusively from Pydantic-validated `hospitalId` literals — no user-controlled path segments. |
| **Arrival timestamp** | `arrivedAt` is server-injected in `arrival_bp.py`. Never trusted from the client payload. |

---

## Author

**James Youm** — Cloud Computing Senior  
Portfolio project demonstrating Azure serverless architecture, HIPAA-aware data design, real-time streaming, and React/TypeScript PWA development.
