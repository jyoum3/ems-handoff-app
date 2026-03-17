"""
shared_clients.py — Singleton Azure SDK Clients
================================================
Purpose:
    Initializes DefaultAzureCredential and all Azure SDK clients ONCE at
    module load time. Both blueprint modules import from here, so the entire
    Function App shares a single credential, a single Cosmos container
    reference, and a single BlobServiceClient across all warm invocations.

Why Singletons Matter for Azure Functions:
    Azure Functions reuses the execution context (Python process) across
    back-to-back "warm" invocations. If clients were initialized inside each
    function handler, every request would re-run the credential token
    acquisition flow and re-establish HTTPS connections to Cosmos DB and
    Blob Storage. For an EMS handoff pipeline — where milliseconds matter
    during a trauma or a Code — that per-invocation overhead is unacceptable.

    Module-level initialization means:
      ✅  Token acquired once → reused across warm invocations
      ✅  HTTPS connection pool kept alive → no TCP handshake per request
      ✅  Container client references reused → no repeated service lookups

Fail-Fast Philosophy:
    KeyError is intentionally NOT caught for os.environ[] lookups below.
    If a required environment variable is missing, the host crashes loudly
    at startup rather than failing silently on the first live request.
    This surfaces misconfigurations immediately during local `func start`
    or an Azure deployment — never mid-incident.

Security (DefaultAzureCredential):
    Credential resolution order relevant to this project:
      Local dev  → AZURE_CLIENT_ID + AZURE_CLIENT_SECRET + AZURE_TENANT_ID
                   env vars (Service Principal via local.settings.json).
      Azure      → Managed Identity assigned to the Function App.

    One credential object. One code path. Both environments. Zero secrets
    hardcoded anywhere in this repository.

Environment Variables (local.settings.json / Azure App Settings):
    COSMOS_DB_ENDPOINT        — Cosmos DB account URI
    BLOB_SERVICE_ENDPOINT     — Blob Storage account URI
    COMMENTS_CONTAINER_NAME   — Cosmos container for clinical staff comments
                                 (separate from the PHI handoffs container)
    CHAT_CONTAINER_NAME       — Cosmos container for bidirectional EMS ↔ Hospital
                                 chat logs (inbound-chat), partitioned by /bundleId
    ECG_CONTAINER_NAME        — Blob container for ECG image uploads (ecg-uploads).
                                 Separate from handoff-archive for distinct retention
                                 policy and RBAC. Partitioned by {hospitalId}/{bundleId}.
"""

import os

from azure.cosmos import CosmosClient
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient, ContainerClient

# =============================================================================
# Credential — Single Instance Shared Across All SDK Clients
# =============================================================================
#
# DefaultAzureCredential is initialized once and passed to EVERY SDK client
# below. All clients share the same underlying token cache, so a token
# refreshed for the Cosmos client is automatically reused by the Blob client
# without a second round-trip to Azure AD. This is both more efficient and
# more resilient than constructing separate credential instances per client.

credential = DefaultAzureCredential()

# =============================================================================
# Cosmos DB — Shared Client + Container References
# =============================================================================

_COSMOS_ENDPOINT: str = os.environ["COSMOS_DB_ENDPOINT"]
_DATABASE_NAME: str = "ems-db"

_cosmos_client = CosmosClient(url=_COSMOS_ENDPOINT, credential=credential)
_database_client = _cosmos_client.get_database_client(_DATABASE_NAME)

# ── handoffs container ────────────────────────────────────────────────────────
# The primary PHI store. Partitioned by `hospitalId`.
# All inbound FHIR bundles live here until arrival_bp.py archives them.
_HANDOFFS_CONTAINER_NAME: str = "handoffs"

cosmos_container = _database_client.get_container_client(_HANDOFFS_CONTAINER_NAME)

# ── handoff-comments container ────────────────────────────────────────────────
# Clinical staff comments — hospital operational metadata, NOT PHI.
# Stored in a SEPARATE container from the FHIR bundles to enforce the principle
# that operational notes are distinct from clinical record data.
#
# Document schema:
#   {
#     "id": "<bundleId>",       ← Cosmos document id AND the handoff it annotates
#     "hospitalId": "HUP-PAV", ← Partition key
#     "comments": [
#       { "commentId": "<uuid>", "text": "...", "authorRole": "CHARGE",
#         "authorName": "Jane Doe", "createdAt": "2026-03-07T18:15:00Z" }
#     ]
#   }
#
# Lifecycle: comment docs are deleted by arrival_bp.py when a patient is
# arrived. This keeps the container clean and prevents orphaned metadata.
_COMMENTS_CONTAINER_NAME: str = os.environ["COMMENTS_CONTAINER_NAME"]

comments_container = _database_client.get_container_client(_COMMENTS_CONTAINER_NAME)

# ── inbound-chat container ─────────────────────────────────────────────────────
# Bidirectional EMS ↔ Hospital real-time chat log.
# CRITICAL ARCHITECTURAL DECISION — Partitioned by /bundleId (NOT /hospitalId):
#
# The inbound-chat container is partitioned by bundleId because the chat log
# belongs to ONE PATIENT — not to a hospital. If a patient is diverted from
# HUP-PAV to HUP-CEDAR mid-transport, the chat document must NOT move.
# Cosmos DB does not allow partition key changes on existing documents —
# you would have to delete and recreate the document, risking data loss
# during a live clinical handoff. By partitioning by bundleId, the chat
# document stays in place during diversion; only the hospitalId metadata
# field on the document is updated. This is a deliberate tradeoff:
#
#   ✅  Chat survives diversion without re-keying
#   ✅  Single-document point reads by bundleId (the ONLY access pattern we need)
#   ⚠️  Cannot list all chats for a hospital without a cross-partition query
#   ✅  We never need to list all chats for a hospital — we always fetch by bundleId
#
_CHAT_CONTAINER_NAME: str = os.environ["CHAT_CONTAINER_NAME"]

chat_container = _database_client.get_container_client(_CHAT_CONTAINER_NAME)

# =============================================================================
# Blob Storage — BlobServiceClient (Account-Level)
# =============================================================================

_BLOB_ENDPOINT: str = os.environ["BLOB_SERVICE_ENDPOINT"]

# `blob_service_client` is the account-level client imported by arrival_bp.py.
# The blueprint calls .get_blob_client(container=..., blob=...) on this
# instance at request time to target the specific archive path:
#     handoff-archive/{hospitalId}/{bundle_id}.json
blob_service_client = BlobServiceClient(
    account_url=_BLOB_ENDPOINT,
    credential=credential,
)

# ── ECG Container ─────────────────────────────────────────────────────────────
# Container: "ecg-uploads"
# Blob path: {hospitalId}/{bundleId}.{ext}
# Access: DefaultAzureCredential (same storage account as handoff-archive)
#
# WHY a separate container (not handoff-archive):
# ─────────────────────────────────────────────────────────────────────────────
# ECG images are binary blobs with a different retention policy than archived
# FHIR bundles (JSON). ECG images may be subject to a longer legal/audit hold
# for cardiology records. Separate containers = separate Azure Blob lifecycle
# policies, separate RBAC assignments, and cleaner access patterns.
# The archive container holds JSON only; the ECG container holds image binaries.
#
# Overwrite semantics: each upload for a given bundleId OVERWRITES the same
# blob path. The EcgRecord list in Cosmos DB tracks history (timestamps, labels,
# rhythm interpretations). Blob Storage stores only the latest physical image
# per bundleId. This keeps blob storage lean while preserving the full audit
# trail in the structured Cosmos document.
_ECG_CONTAINER_NAME: str = os.getenv("ECG_CONTAINER_NAME", "ecg-uploads")

ecg_container_client: ContainerClient = blob_service_client.get_container_client(
    _ECG_CONTAINER_NAME
)
