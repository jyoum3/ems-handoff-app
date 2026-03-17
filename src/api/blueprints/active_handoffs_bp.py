"""
blueprints/active_handoffs_bp.py — Active Handoffs Hydration Endpoint
======================================================================
Route:   GET /api/active-handoffs?hospitalId={hospitalId}
Purpose: Returns all currently active (handoffStatus="inbound") FHIR
         Bundles for a given hospital partition. This endpoint serves as
         the authoritative initial hydration source for the Hospital-
         Facing Dashboard's useReducer state on page load or refresh.

Why This Endpoint Exists — The Hydration Gap Problem:
    ┌─────────────────────────────────────────────────────────────────────┐
    │  SignalR is an INCREMENTAL update mechanism.                        │
    │                                                                     │
    │  It delivers changes that occur AFTER the client connects.         │
    │  It has no concept of "catch me up to the current state."          │
    │                                                                     │
    │  Scenario: A charge nurse refreshes the dashboard at 0200.         │
    │  4 active inbound patients are already in Cosmos DB.               │
    │  SignalR connects. No new events fire. Dashboard shows: [empty].   │
    │                                                                     │
    │  Without hydration: nurses are blind to active patients until the  │
    │  next medic submits a new handoff or updates an existing one.      │
    │  In a trauma setting, this is clinically unacceptable.             │
    └─────────────────────────────────────────────────────────────────────┘

    This endpoint solves the hydration gap. The dashboard's load sequence:

    Page Load:
      [A] GET /api/active-handoffs?hospitalId=HUP-PAV   ← this endpoint
           └── Returns snapshot of all inbound patients
           └── Frontend dispatches HYDRATE → reducer populates liveQueue

      [B] GET /api/negotiate?hospitalId=HUP-PAV         ← runs in parallel
           └── SignalR WebSocket established
           └── All subsequent updates arrive as HANDOFF_UPDATE events

    Because [A] and [B] run in parallel and the reducer uses UPSERT
    semantics (new keys are added, existing keys are updated — never
    wiped), there is no race condition regardless of which resolves first.

Cosmos DB Query Design — Single-Partition Efficiency:
    The container is partitioned by `hospitalId`. By supplying the
    partition_key parameter to query_items(), the Cosmos DB SDK scopes
    the query to a single logical partition — no cross-partition fan-out.

    A cross-partition query for 4 inbound patients might cost 20+ RU/s.
    A single-partition query for the same 4 patients costs ~2 RU/s.
    At 18 workstations refreshing concurrently, this difference compounds
    quickly. The partition key is not just a data isolation mechanism —
    it is also the performance optimization that makes this query viable
    at clinical scale.

Security:
    - hospitalId validated against the explicit allowlist BEFORE any
      database operation. An unlisted hospital ID never reaches Cosmos.
    - DefaultAzureCredential via shared_clients.py — no hardcoded keys.
    - PHI is never logged. Only bundle_id list and count are traced.
    - CORS headers allow the dashboard frontend (localhost:3000 in dev,
      Azure Static Web Apps in production) to call this endpoint from
      the browser.
"""

import json
import logging

import azure.functions as func

from shared_clients import cosmos_container

# =============================================================================
# Blueprint Instance
# =============================================================================

bp = func.Blueprint()

# =============================================================================
# Hospital Allowlist — consistent with negotiate_bp.py and models.py
# =============================================================================

_VALID_HOSPITAL_IDS: frozenset[str] = frozenset(
    {"HUP-PAV", "HUP-PRESBY", "HUP-CEDAR"}
)


# =============================================================================
# Route: GET /api/active-handoffs
# =============================================================================


@bp.route(route="active-handoffs", methods=["GET"])
def active_handoffs(req: func.HttpRequest) -> func.HttpResponse:
    """
    HTTP-Triggered Azure Function: Active Handoffs Hydration Query.

    Returns all active (handoffStatus="inbound") FHIR Bundles for the
    specified hospital partition. Used exclusively by the Hospital-Facing
    Dashboard for initial state hydration on page load or refresh.

    ┌──────────────────────────────────────────────────────────────────────┐
    │  REQUEST                                                             │
    │  Method:  GET                                                        │
    │  Route:   /api/active-handoffs                                       │
    │  Query:   hospitalId=HUP-PAV  (or HUP-PRESBY, HUP-CEDAR)           │
    └──────────────────────────────────────────────────────────────────────┘

    ┌──────────────────────────────────────────────────────────────────────┐
    │  RESPONSES                                                           │
    │  200 OK          { "bundles": [...FHIRBundle[]] }                   │
    │                  Array may be empty if no active inbound patients.  │
    │  400 Bad Request Missing or invalid hospitalId.                     │
    │  500 Server Error Cosmos DB query failed.                           │
    └──────────────────────────────────────────────────────────────────────┘
    """
    # -------------------------------------------------------------------------
    # Validate hospitalId — gate before any DB operation
    # -------------------------------------------------------------------------
    # This mirrors the same validation pattern in negotiate_bp.py.
    # Both endpoints gate on hospitalId because both expose hospital-scoped
    # data — the negotiate endpoint gates what SignalR data you can receive,
    # this endpoint gates what Cosmos data you can read.
    hospital_id: str = req.params.get("hospitalId", "")

    if not hospital_id:
        logging.warning("active-handoffs: Missing hospitalId query parameter.")
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
            "active-handoffs: Invalid hospitalId rejected | hospitalId=%s",
            hospital_id,
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

    # -------------------------------------------------------------------------
    # Query Cosmos DB — single-partition scan for inbound handoffs
    # -------------------------------------------------------------------------
    # WHY partition_key IS SPECIFIED HERE:
    # ─────────────────────────────────────────────────────────────────────────
    # Cosmos DB SDK's query_items() defaults to a cross-partition query when
    # no partition_key is provided. A cross-partition query fans out to EVERY
    # physical partition in the container — even ones belonging to HUP-PRESBY
    # or HUP-CEDAR — before filtering results. This wastes RU/s proportional
    # to the number of partitions and violates hospital data isolation.
    #
    # By supplying partition_key=hospital_id, the SDK sends the query ONLY
    # to the partition shard that holds HUP-PAV data. This is:
    #   1. More efficient      → ~10x fewer RU/s consumed
    #   2. More secure         → HUP-PAV data path never touches HUP-PRESBY
    #   3. More consistent     → Results reflect a single partition state
    #
    # The query itself is intentionally simple:
    #   "SELECT * FROM c WHERE c.handoffStatus = 'inbound'"
    # We return all fields from the document (not a SELECT projection) because
    # the dashboard needs the full FHIR Bundle to populate every column in
    # the live queue row — vitals, demographics, ESI, resources, etc.
    try:
        query = "SELECT * FROM c WHERE c.handoffStatus = 'inbound'"
        items = list(
            cosmos_container.query_items(
                query=query,
                partition_key=hospital_id,
            )
        )

        bundle_ids = [item.get("id", "UNKNOWN") for item in items]
        logging.info(
            "active-handoffs: Query complete | hospitalId=%s | count=%d | ids=%s",
            hospital_id,
            len(items),
            bundle_ids,
        )

    except Exception:
        logging.exception(
            "active-handoffs: Cosmos DB query FAILED | hospitalId=%s", hospital_id
        )
        return func.HttpResponse(
            body=json.dumps(
                {
                    "error": (
                        "Failed to retrieve active handoffs. "
                        "Please retry or contact support."
                    )
                }
            ),
            status_code=500,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Return hydration payload
    # -------------------------------------------------------------------------
    # The response shape { "bundles": [...] } is intentional:
    #   - A named key makes the payload self-documenting
    #   - It future-proofs the response — we can add metadata (e.g.,
    #     "queryTimestamp", "count") without breaking array parsing
    #   - The frontend dispatcher: dispatch({ type: 'HYDRATE', bundles: data.bundles })
    #     reads the named key explicitly, not array index 0
    #
    # An empty `bundles` array (no active patients) is a valid 200 response.
    # The dashboard reducer handles HYDRATE with an empty array gracefully —
    # the live queue shows the "No active inbound patients" empty state.
    return func.HttpResponse(
        body=json.dumps({"bundles": items, "count": len(items)}),
        status_code=200,
        mimetype="application/json",
    )
