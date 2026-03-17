# Technical Reference — EMS Handoff Dashboard

This document covers service topology rationale, key architectural decisions, data
isolation design, and environment configuration for engineers working in this codebase.

For the full Azure topology diagram, data flow sequences, and RBAC table, see
[ARCHITECTURE.md](../ARCHITECTURE.md) at the repository root.

---

## Azure Services Used

| Service | Tier / Config | Why This Service |
|---------|--------------|-----------------|
| **Azure Functions v4** | Python 3.11, Consumption Plan | Serverless compute — scales to zero between EMS incidents. No always-on infrastructure cost for a per-incident event system. |
| **Azure Cosmos DB (Core API)** | Standard serverless | NoSQL document store ideal for schema-flexible FHIR Bundles. Partition key design (hospitalId) gives O(1) single-partition reads. Change Feed is the real-time event source for the entire dashboard update pipeline. |
| **Azure Blob Storage** | LRS, standard tier | Object store for PHI archive (JSON) and ECG images (binary). Separate containers allow independent lifecycle policies and RBAC. |
| **Azure SignalR Service** | Serverless mode | Managed WebSocket infrastructure. Serverless mode means the Function App is never in the WebSocket hot path — it only pushes events. Scales to thousands of concurrent connections without backend changes. |
| **Azure Static Web Apps** | Free tier | Built-in SPA routing, CI/CD from GitHub, integrated CDN, and SWA-specific authentication support if needed in the future. |
| **Azure AD (Entra ID)** | Service Principal (dev) / Managed Identity (prod) | Identity-based access: no connection strings or keys stored anywhere in the codebase. |

---

## Pydantic "Bouncer" Pattern

Every Azure Function that accepts an HTTP payload instantiates a Pydantic `BaseModel`
**before** performing any I/O (Cosmos read, Blob read, SignalR broadcast).

```
HTTP request body
      │
      ▼
  req.get_json()            ← Catches JSON parse errors → 400
      │
      ▼
  Model.model_validate()    ← Catches schema violations → 400
      │                        (all errors collected, not short-circuited)
      ▼
  Validated, typed object
      │
      ▼
  Azure SDK calls (Cosmos, Blob, SignalR)
```

**Why "collect all errors" matters:**  
Pydantic v2 runs the full validation tree before raising. A payload with both a missing
`hospitalId` and a type-mismatched vital sign produces one response with both errors —
not two sequential round trips. In a field network under stress, minimizing round trips
to identify valid payloads is clinically meaningful.

**HIPAA note:**  
`e.errors()` returns field paths (`loc`) and type descriptions (`msg`) — it never echoes
raw PHI values from the payload. The 400 error response is safe to log and return.

---

## PHI Lifecycle State Machine

```
                          ┌─────────────────┐
                          │   handoffStatus  │
                          └────────┬────────┘
                                   │
                          POST /api/ems-to-db
                                   │
                                   ▼
                             ┌──────────┐
                             │ "inbound" │  ← Active in Cosmos, visible in Live Queue
                             └────┬─────┘
                                  │
                    ┌─────────────┴────────────────┐
                    │                              │
            POST /api/ems-arrival          POST /api/divert-handoff
            (medic or hospital)                   │
                    │                   ┌──────────┴────────────┐
                    ▼                   │  old partition DELETE  │
              ┌──────────┐              │  new partition INSERT  │
              │ "arrived" │              └──────────┬────────────┘
              └────┬─────┘                         │
                   │                          back to "inbound"
                   │                        (in new hospital partition)
                   ▼
        Blob archive write + Cosmos DELETE
                   │
          ┌────────┴────────────────────────────┐
          │ handoff-archive/{hospitalId}/...    │
          │   ├── handoff.json ("arrived")      │
          │   └── chat.json (companion)         │
          └────────┬────────────────────────────┘
                   │
                   │  POST /api/recover-handoff  ← Staff error / wrong patient
                   │  (CHARGE or PFC only)
                   ▼
              ┌──────────┐
              │ "inbound" │  ← Back in Cosmos, visible in Live Queue again
              └──────────┘  (blob updated to "inbound" to exclude from history list)
```

The `handoffStatus` field is placed at the **Bundle root** (not nested inside
`EncounterResource`) because `arrival_bp.py` patches it with a single dict key update
before `upsert_item()`. Nesting it inside an array would require loading, deserializing,
and reserializing the nested structure — a more expensive operation with more failure
surface area.

---

## Data Isolation Architecture

Three layers enforce hospital data isolation:

### Layer 1: Cosmos DB Partition Key
```
document.hospitalId = "HUP-PAV"
All reads use partition_key=hospital_id
→ Physically separated on Cosmos partitions
→ No HUP-CEDAR query can ever return HUP-PAV documents
```

### Layer 2: SignalR userId Token
```
negotiate_bp.py issues token with userId="HUP-PAV"
streaming_bp.py targets userId=document["hospitalId"]
→ HUP-CEDAR connections never receive HUP-PAV events
→ Enforcement is at Azure SignalR Service transport layer
→ Not a JS filter — enforced before the message reaches the browser
```

### Layer 3: Blob Storage Path Structure
```
Blob paths: handoff-archive/{hospitalId}/{date}/{bundleId}/handoff.json
hospitalId sourced exclusively from Pydantic Literal allowlist
→ No user-controlled path segments
→ Cross-hospital archive access structurally impossible via a crafted request
```

---

## SDK Singleton Pattern (`shared_clients.py`)

Azure Functions reuses the Python process (execution context) across "warm" invocations.
Module-level objects persist in memory between requests on the same instance.

```python
# shared_clients.py — initialized ONCE at module load time

credential = DefaultAzureCredential()           # token cache shared across all SDK clients
cosmos_container = _cosmos_client.get_container_client(...)  # keeps TCP connection alive
blob_service_client = BlobServiceClient(...)    # keeps HTTPS connection pool alive
```

**Without singletons:** Every HTTP invocation would re-run the credential token acquisition
flow (~80ms) and re-establish HTTPS connections to Cosmos DB and Blob Storage. On a warm
Azure Functions instance processing 10 EMS handoffs per minute during a mass casualty
event, this adds ~800ms of unnecessary latency per minute.

**Fail-fast (`os.environ[]` not `os.getenv()`):**  
All `os.environ[]` lookups in `shared_clients.py` raise `KeyError` immediately if a
required env var is absent. This surfaces misconfigurations at host startup — not
mid-incident when the first real request arrives.

---

## Blueprint Modularity (Open/Closed Principle)

```
function_app.py
    register_blueprint(ingestion_bp)
    register_blueprint(arrival_bp)
    register_blueprint(...)

Adding a new route:
    1. Create blueprints/new_feature_bp.py
    2. Add: from blueprints.new_feature_bp import bp as new_feature_bp
    3. Add: app.register_blueprint(new_feature_bp)
    
    ← Zero changes to existing blueprints
    ← Zero changes to function_app.py logic
```

Each blueprint is a self-contained feature module. `function_app.py` is a pure switchboard
with no business logic. This pattern means a bug in `ecg_bp.py` can never inadvertently
affect `ingestion_bp.py` — there is no shared mutable state between blueprints beyond
the `shared_clients.py` SDK singleton (which is read-only after initialization).

---

## Edit Detection — Server-Authoritative Pattern

The `editCount`, `isEdited`, and `lastEditedAt` fields on `FHIRBundle` are **never
trusted from the client payload**. They are computed by `ingestion_bp.py` via a
read-before-write pattern:

```python
try:
    existing = cosmos_container.read_item(item=bundle.id, partition_key=bundle.hospitalId)
    document["editCount"] = existing.get("editCount", 0) + 1
    document["isEdited"] = True
    document["lastEditedAt"] = datetime.now(timezone.utc).isoformat()
except ResourceNotFoundError:
    pass  # First submission — model defaults apply (editCount=0, isEdited=False)
```

A client-provided `isEdit: true` flag could be spoofed. The server-authoritative pattern
ensures the dashboard's amber "(Edited ×N)" indicator reflects actual re-submissions,
not client-declared intent.

---

## ECG Serial List Design

ECGs are stored as an ordered list on the FHIR Bundle root (`ecgRecords[]`), not as a
single `ecgBlobUrl` field. This enables:

- **Temporal comparison:** A STEMI patient may have an initial EKG (baseline) and
  update EKGs en route showing evolving ST changes. Both are clinically significant.
- **Serial viewer:** The hospital dashboard ECG viewer renders `ecgRecords[-1]` as
  "Current" and provides a history rail for prior uploads.
- **Side-by-side comparison:** The `ComparisonOverlay` component allows two ECGs to
  be selected and rendered simultaneously (pan, zoom, merge canvas modes).

Each `EcgRecord` carries a `blobKey` field containing the unique epoch-ms filename
(`ecg-{epoch_ms}.{ext}`). This allows `DELETE /api/delete-ecg` to reconstruct the
exact blob path for any record, regardless of position changes in the array after
deletions.

---

## Frontend Type Safety Contract

The TypeScript interfaces in `src/types/fhir.ts` (both frontends) must stay synchronized
with the Pydantic models in `src/api/models.py`.

**Current alignment:**

| Pydantic model field | TypeScript interface | Notes |
|---------------------|---------------------|-------|
| `FHIRBundle.id` | `FHIRBundle.id` | Root identifier |
| `FHIRBundle.hospitalId` | `FHIRBundle.hospitalId` | Partition key |
| `FHIRBundle.handoffStatus` | `FHIRBundle.handoffStatus` | `"inbound" \| "arrived"` |
| `FHIRBundle.ecgRecords` | `FHIRBundle.ecgRecords` | `EcgRecord[]` |
| `FHIRBundle.vitalHistory` | `FHIRBundle.vitalHistory` | `VitalSignEntry[]` |
| `PatientResource.computed_age` | `PatientResource.computed_age` | Read-only derived field |
| `EncounterResource.resourceRequirements` | `EncounterResource.resourceRequirements` | `string[]` |
| `CommentEntry` | `HospitalComment` | Comment thread entry |

When adding a new field to the Python model, update both TypeScript files:
- `src/frontend/ems-ingestion/src/types/fhir.ts`
- `src/frontend/hospital-dashboard/src/types/fhir.ts`
