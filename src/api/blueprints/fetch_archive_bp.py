"""
blueprints/fetch_archive_bp.py — Archive Bundle Retrieval Endpoint
===================================================================
Route:   GET /api/fetch-archive?hospitalId={hospitalId}&bundleId={bundleId}
         GET /api/fetch-archive?hospitalId={hospitalId}   (list / hot-tier mode)

Purpose:
    Two operating modes determined by the presence of `bundleId`:

    SINGLE MODE (bundleId present):
        Retrieves a specific archived FHIR Bundle from Blob Storage and
        returns it to the Hospital-Facing Dashboard for historical audit
        and drill-down display in the History tab's "View Details" modal.

    LIST MODE (bundleId absent — Sprint 3 addition):
        Lists ALL blobs for the given hospital that are in the "hot tier"
        (last_modified within the past 24 hours), filters for only
        handoffStatus="arrived" records (excludes recovered patients), and
        returns the full bundle array sorted by arrivedAt descending
        (most recently arrived patient at the top). Used to hydrate the
        History Tab on page load so it persists across browser refreshes.

Why This Endpoint Exists — The PHI Proxy Pattern:
    ┌─────────────────────────────────────────────────────────────────────┐
    │  The frontend CANNOT call Azure Blob Storage directly for PHI.      │
    │                                                                     │
    │  Option A — Public Blob Access:                                     │
    │  Result: Any person on the internet can download PHI records        │
    │  by guessing paths. HIPAA violation. Never acceptable.              │
    │                                                                     │
    │  Option B — SAS Tokens:                                             │
    │  Result: SAS token is a secret. Secrets in the browser are          │
    │  extractable via DevTools. Any compromised workstation becomes a    │
    │  PHI exfiltration vector.                                           │
    │                                                                     │
    │  Option C — Azure Function Proxy (THIS FILE):                       │
    │  Browser calls /api/fetch-archive with hospitalId (+ optional ID).  │
    │  This function uses DefaultAzureCredential (Managed Identity)       │
    │  to authenticate to Blob Storage server-side. The browser           │
    │  receives only the JSON payload — never a credential.              │
    │                                                                     │
    │  Result: The Managed Identity credential NEVER leaves the           │
    │  server. The browser has no ability to access Blob Storage         │
    │  independent of this function. This is the HIPAA-correct pattern.  │
    └─────────────────────────────────────────────────────────────────────┘

List Mode — Hot-Tier Design Rationale:
    Azure Blob Storage has a lifecycle management policy that transitions
    blobs from Hot → Archive tier after 24 hours. The "hot tier" window
    corresponds to all blobs accessible in under-24h — these are the records
    relevant to a current shift's History Tab.

    For the list, we use `blob.last_modified` (from blob properties, available
    without downloading the blob content) to filter. We only download and
    parse each blob that passes the time filter, keeping the operation
    efficient for a typical ED shift volume (20-60 arrivals per 24h).

    The filter for handoffStatus="arrived" (applied after downloading) ensures
    that recovered patients (whose blobs were updated to handoffStatus="inbound"
    by recover_handoff_bp.py) do NOT re-appear in the History Tab after recovery.

Security:
    - hospitalId validated against explicit allowlist before any Blob access
    - DefaultAzureCredential via shared_clients.py — no hardcoded keys
    - PHI is never logged — only bundle_id and hospitalId used for tracing
    - 404 is returned for missing blobs rather than exposing blob path details

Environment Variables:
    ARCHIVE_CONTAINER_NAME — Blob container for archival (e.g., "handoff-archive")
"""

import json
import logging
import os
from datetime import datetime, timedelta, timezone

import azure.functions as func
from azure.core.exceptions import ResourceNotFoundError

from shared_clients import blob_service_client

# =============================================================================
# Blueprint Instance
# =============================================================================

bp = func.Blueprint()

# =============================================================================
# Hospital Allowlist — consistent across all endpoints
# =============================================================================

_VALID_HOSPITAL_IDS: frozenset[str] = frozenset(
    {"HUP-PAV", "HUP-PRESBY", "HUP-CEDAR"}
)

# Archive container name — read once at module load (fail-fast on missing env var)
_ARCHIVE_CONTAINER: str = os.environ["ARCHIVE_CONTAINER_NAME"]

# Hot-tier threshold: blobs modified within the last 24 hours.
# This matches the Azure Blob lifecycle policy that moves blobs to
# Archive tier after 24 hours. The frontend History Tab should only
# display records from the current shift window.
_HOT_TIER_HOURS: int = 24


# =============================================================================
# Route: GET /api/fetch-archive
# =============================================================================


@bp.route(route="fetch-archive", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def fetch_archive(req: func.HttpRequest) -> func.HttpResponse:
    """
    HTTP-Triggered Azure Function: Archived Bundle Retrieval (Single or List).

    Operates in two modes based on query parameters:
      - SINGLE MODE: bundleId present → returns one specific archived bundle
      - LIST MODE:   bundleId absent  → returns all hot-tier arrived bundles

    ┌──────────────────────────────────────────────────────────────────────┐
    │  REQUEST (Single Mode)                                               │
    │  Method:  GET                                                        │
    │  Route:   /api/fetch-archive                                         │
    │  Query:   hospitalId=HUP-PAV&bundleId=EMS-HANDOFF-MAX-001          │
    └──────────────────────────────────────────────────────────────────────┘

    ┌──────────────────────────────────────────────────────────────────────┐
    │  REQUEST (List / Hot-Tier Mode)                                      │
    │  Method:  GET                                                        │
    │  Route:   /api/fetch-archive                                         │
    │  Query:   hospitalId=HUP-PAV  (no bundleId)                         │
    └──────────────────────────────────────────────────────────────────────┘

    ┌──────────────────────────────────────────────────────────────────────┐
    │  RESPONSES                                                           │
    │  200 OK          Single: Full FHIR Bundle JSON from Blob Storage    │
    │                  List:   { "bundles": [...], "count": N }           │
    │  400 Bad Request Missing or invalid hospitalId                      │
    │  404 Not Found   Single: No blob at the specified path              │
    │  500 Server Error Blob read failed                                  │
    └──────────────────────────────────────────────────────────────────────┘
    """
    # -------------------------------------------------------------------------
    # Validate hospitalId (required for both modes)
    # -------------------------------------------------------------------------
    hospital_id: str = req.params.get("hospitalId", "")
    bundle_id: str = req.params.get("bundleId", "").strip()

    if not hospital_id:
        logging.warning("fetch-archive: Missing hospitalId query parameter.")
        return func.HttpResponse(
            body=json.dumps(
                {
                    "error": (
                        "Missing required query parameter: hospitalId. "
                        "Expected one of: HUP-PAV, HUP-PRESBY, HUP-CEDAR."
                    )
                }
            ),
            status_code=400,
            mimetype="application/json",
        )

    if hospital_id not in _VALID_HOSPITAL_IDS:
        logging.warning(
            "fetch-archive: Invalid hospitalId rejected | hospitalId=%s", hospital_id
        )
        return func.HttpResponse(
            body=json.dumps(
                {
                    "error": (
                        f"Invalid hospitalId: '{hospital_id}'. "
                        "Expected one of: HUP-PAV, HUP-PRESBY, HUP-CEDAR."
                    )
                }
            ),
            status_code=400,
            mimetype="application/json",
        )

    # ─────────────────────────────────────────────────────────────────────────
    # Route to the appropriate handler based on bundleId presence
    # ─────────────────────────────────────────────────────────────────────────
    if bundle_id:
        return _fetch_single(hospital_id, bundle_id)
    else:
        return _list_hot_tier(hospital_id)


# =============================================================================
# Single Mode Handler
# =============================================================================


def _fetch_single(hospital_id: str, bundle_id: str) -> func.HttpResponse:
    """
    Fetches a single archived FHIR Bundle by its blob path.

    Used by PatientDetailModal (mode='archive') when a nurse clicks
    "View Details" on a History Tab row. Returns the authoritative
    legal record stored in Blob Storage rather than the in-memory
    React state copy (which may have been captured mid-lifecycle).

    Blob path structure: {hospitalId}/{bundleId}.json
    """
    blob_path: str = f"{hospital_id}/{bundle_id}.json"

    try:
        blob_client = blob_service_client.get_blob_client(
            container=_ARCHIVE_CONTAINER,
            blob=blob_path,
        )
        download_stream = blob_client.download_blob()
        blob_content: str = download_stream.readall().decode("utf-8")

        logging.info(
            "fetch-archive[single]: Bundle retrieved | hospitalId=%s | bundle_id=%s",
            hospital_id,
            bundle_id,
        )

    except ResourceNotFoundError:
        logging.warning(
            "fetch-archive[single]: Blob NOT FOUND | path=%s/%s",
            _ARCHIVE_CONTAINER,
            blob_path,
        )
        return func.HttpResponse(
            body=json.dumps(
                {
                    "error": (
                        "Archive record not found. The handoff may still be "
                        "processing or the record may no longer exist."
                    ),
                    "bundle_id": bundle_id,
                    "hospitalId": hospital_id,
                }
            ),
            status_code=404,
            mimetype="application/json",
        )

    except Exception:
        logging.exception(
            "fetch-archive[single]: Blob download FAILED | hospitalId=%s | bundle_id=%s",
            hospital_id,
            bundle_id,
        )
        return func.HttpResponse(
            body=json.dumps(
                {
                    "error": (
                        "Failed to retrieve archive record. "
                        "Please retry or contact support."
                    )
                }
            ),
            status_code=500,
            mimetype="application/json",
        )

    # Return the raw blob content as the response body.
    # blob_content is the JSON string written by arrival_bp.py —
    # the same FHIRBundle structure used everywhere in the pipeline.
    return func.HttpResponse(
        body=blob_content,
        status_code=200,
        mimetype="application/json",
    )


# =============================================================================
# List Mode Handler — Hot-Tier History Hydration (Sprint 3)
# =============================================================================


def _list_hot_tier(hospital_id: str) -> func.HttpResponse:
    """
    Lists all 'hot tier' (< 24 hours old) arrived bundles for a hospital.

    Used by the History Tab on page load (via usePatientQueue's HYDRATE_HISTORY
    effect) to restore the session history after a browser refresh. Without this,
    every page refresh would show an empty History Tab regardless of how many
    patients arrived during the current shift.

    Algorithm:
    1. List all blobs with prefix "{hospitalId}/" in the archive container.
       (prefix scoping = only this hospital's archive, no cross-hospital access)
    2. Filter for blobs where last_modified > utcnow() - 24h (hot tier only).
    3. Download and parse each hot blob's JSON content.
    4. Filter for bundles where handoffStatus == "arrived".
       (excludes recovered patients — their blobs were updated to "inbound"
       by recover_handoff_bp.py, preventing them from re-appearing in history)
    5. Sort by arrivedAt descending (most recently arrived first).
       Falls back to bundle.timestamp if arrivedAt is absent (pre-Sprint 3 blobs).
    6. Return { "bundles": [...], "count": N }.

    Performance Note:
    ──────────────────
    For a typical ED shift (20-60 arrivals per 24h), this downloads 20-60 × ~3KB
    = ~60-180KB of data. This is acceptable for a shift-load operation that runs
    once on page load, not on every render. At high volume, the pattern could be
    optimized by storing a manifest index blob, but that is premature for the
    current scale. The single-partition prefix listing is already efficient.

    WHY last_modified vs. creation_time for the hot-tier filter:
    ─────────────────────────────────────────────────────────────
    `last_modified` reflects when the blob was last written (arrival OR recovery
    update). A blob recovered by recover_handoff_bp.py gets a new last_modified
    timestamp. Since we also filter by handoffStatus, this doesn't cause false
    positives — recovered blobs are excluded by the status filter.
    Using last_modified is correct because it catches both first-arrival blobs
    AND any blobs that were recently updated (e.g., post-recovery corrections).
    """
    prefix: str = f"{hospital_id}/"
    cutoff: datetime = datetime.now(timezone.utc) - timedelta(hours=_HOT_TIER_HOURS)
    hot_bundles: list = []

    try:
        container_client = blob_service_client.get_container_client(_ARCHIVE_CONTAINER)

        # list_blobs() with name_starts_with scopes the listing to only this
        # hospital's "directory" within the flat Blob Storage namespace.
        # This is an O(n) operation over blobs in the prefix, not the entire container.
        blob_list = container_client.list_blobs(name_starts_with=prefix)

        for blob_props in blob_list:
            # ── Hot-tier filter ───────────────────────────────────────────────
            # Skip blobs older than the hot-tier window. Blob.last_modified
            # is an offset-aware datetime from the Azure SDK — compatible with
            # our timezone.utc cutoff directly.
            if blob_props.last_modified and blob_props.last_modified < cutoff:
                continue

            # ── Download and parse each hot blob ─────────────────────────────
            # We download the full blob content because we need the JSON payload
            # for the History Tab rows (name, ESI, chief complaint, vitals, etc.).
            # Blob properties alone (name, size, metadata) are insufficient.
            try:
                blob_client = blob_service_client.get_blob_client(
                    container=_ARCHIVE_CONTAINER,
                    blob=blob_props.name,
                )
                content = blob_client.download_blob().readall().decode("utf-8")
                bundle = json.loads(content)

            except Exception:
                # Skip individual corrupt or unreadable blobs rather than
                # aborting the entire list. Log for ops awareness.
                logging.warning(
                    "fetch-archive[list]: Skipping unreadable blob | path=%s",
                    blob_props.name,
                )
                continue

            # ── Status filter ─────────────────────────────────────────────────
            # Only include blobs where handoffStatus == "arrived".
            # Recovered patients have handoffStatus="inbound" in their blob —
            # excluding them here prevents showing a patient in both the History
            # Tab (via this list) AND the Live Queue (via Cosmos hydration) at
            # the same time after a recovery + page refresh sequence.
            if bundle.get("handoffStatus") != "arrived":
                continue

            hot_bundles.append(bundle)

    except Exception:
        logging.exception(
            "fetch-archive[list]: Blob listing FAILED | hospitalId=%s", hospital_id
        )
        return func.HttpResponse(
            body=json.dumps(
                {
                    "error": (
                        "Failed to retrieve archive history. "
                        "Please retry or contact support."
                    )
                }
            ),
            status_code=500,
            mimetype="application/json",
        )

    # ── Sort by arrivedAt descending (newest arrival at top) ─────────────────
    # Primary sort key: arrivedAt (the server-injected timestamp from arrival_bp.py).
    # Fallback sort key: bundle.timestamp (submission time) for pre-Sprint 3 blobs
    # that were archived before the arrivedAt field was added.
    #
    # ISO 8601 strings sort lexicographically in the correct chronological order,
    # so a simple string comparison is safe and avoids datetime parsing overhead.
    def sort_key(bundle: dict) -> str:
        return bundle.get("arrivedAt") or bundle.get("timestamp") or ""

    hot_bundles.sort(key=sort_key, reverse=True)

    logging.info(
        "fetch-archive[list]: Hot-tier list complete | hospitalId=%s | count=%d | cutoff=%s",
        hospital_id,
        len(hot_bundles),
        cutoff.isoformat(),
    )

    return func.HttpResponse(
        body=json.dumps({"bundles": hot_bundles, "count": len(hot_bundles)}),
        status_code=200,
        mimetype="application/json",
    )
