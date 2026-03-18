"""
blueprints/ingestion_bp.py — EMS Handoff Ingestion Blueprint
=============================================================
Route:   POST /api/ems-to-db
Purpose: Accepts a FHIR Bundle from a field medic's PWA, validates it
         through the Pydantic Bouncer, and persists it to Cosmos DB.

Data Flow:
    PWA (Medic) ──POST──► /api/ems-to-db ──► Pydantic Bouncer ──► Cosmos DB
                                                      │
                                                400 on reject
                                                (never hits DB)

PWA Persistence Contract:
    On a successful 201 response, the body includes both `bundle_id` and
    `hospitalId`. The PWA stores these values in Browser LocalStorage so
    the medic can later trigger POST /api/ems-arrival without re-entering
    any identifiers. This creates a stateless, self-contained lifecycle:
      ems-to-db (ingest) → LocalStorage → ems-arrival (archive + cleanup)

Security:
    - DefaultAzureCredential (via shared_clients.py): zero hardcoded secrets.
    - PHI is NEVER logged. Only the Bundle `id` is used for debug traces.
    - Validation errors describe field paths and type mismatches only —
      raw PHI values from the payload are never echoed to the caller.

Shared Clients:
    cosmos_container is imported from shared_clients.py — it is a module-level
    singleton initialized once at host startup. This blueprint does not
    create any new SDK clients; it reuses the shared connection pool.
"""

import json
import logging
from datetime import datetime, timezone

import azure.functions as func
from azure.core.exceptions import ResourceNotFoundError
from pydantic import ValidationError

from models import FHIRBundle
from shared_clients import cosmos_container

# =============================================================================
# Blueprint Instance
# =============================================================================
#
# func.Blueprint() is a lightweight container for route definitions. It holds
# zero app-level state — it simply registers route handlers that function_app.py
# will attach to the main FunctionApp instance via app.register_blueprint().
#
# Think of a Blueprint as a "route module": it defines WHAT routes exist and
# HOW they behave, but the FunctionApp is the host that actually binds them
# to the HTTP server. This separation means we can add, remove, or swap entire
# feature modules (ingestion, arrival, future dashboards) in function_app.py
# without touching any route logic.

bp = func.Blueprint()


# =============================================================================
# Route: POST /api/ems-to-db
# =============================================================================


@bp.route(route="ems-to-db", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
def ems_to_db(req: func.HttpRequest) -> func.HttpResponse:
    """
    HTTP-Triggered Azure Function: EMS Handoff Ingestion.

    Accepts a FHIR Bundle payload from an EMS medic's PWA, runs it through
    the Pydantic "Bouncer" (FHIRBundle model), and persists valid records to
    Cosmos DB (ems-db / handoffs container) using an idempotent upsert.

    ┌──────────────────────────────────────────────────────────────────────┐
    │  REQUEST                                                             │
    │  Method:        POST                                                 │
    │  Route:         /api/ems-to-db                                       │
    │  Content-Type:  application/json                                     │
    │  Body:          FHIR Bundle JSON (see FHIR-patient-schema-v1.json)   │
    └──────────────────────────────────────────────────────────────────────┘

    ┌──────────────────────────────────────────────────────────────────────┐
    │  RESPONSES                                                           │
    │  201 Created      Handoff validated and written to Cosmos DB.        │
    │                   Body includes bundle_id + hospitalId for PWA       │
    │                   LocalStorage persistence.                          │
    │  400 Bad Request  Body is not JSON  OR  Pydantic validation failed.  │
    │                   The `details` array contains ALL validation errors │
    │                   at once — the caller sees every issue in one shot. │
    │  500 Server Error Cosmos DB write failed (auth, network, etc.)       │
    └──────────────────────────────────────────────────────────────────────┘
    """
    logging.info("ems-to-db: Handoff submission received.")

    # -------------------------------------------------------------------------
    # Step 1: Parse the raw JSON body
    # -------------------------------------------------------------------------
    # `req.get_json()` raises ValueError if the request body cannot be decoded
    # as JSON (e.g., malformed syntax, wrong Content-Type). We catch this
    # before Pydantic so the caller receives a clear "not valid JSON" message
    # that is distinct from a schema-level validation failure.
    try:
        payload: dict = req.get_json()
    except ValueError:
        logging.warning("ems-to-db: Request body is not valid JSON.")
        return func.HttpResponse(
            body=json.dumps({"error": "Request body must be valid JSON."}),
            status_code=400,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Step 2: Pydantic Validation — The Bouncer
    # -------------------------------------------------------------------------
    # `FHIRBundle.model_validate(payload)` runs the complete schema check
    # against the parsed dict. Pydantic v2 collects ALL validation errors
    # across the entire model tree before raising — it does NOT short-circuit
    # on the first failure. This means:
    #
    #   dirty payload → returns EVERY error at once (hospitalId missing AND
    #                   vital sign type error) in a single 400 response.
    #
    # The caller can review the full `details` list and fix everything in
    # one round trip, rather than discovering issues one at a time.
    #
    # HIPAA Note: `e.errors()` returns field paths (loc) and type mismatch
    # descriptions (msg, type) — it never echoes raw PHI values back to the
    # caller. The 400 response body is safe to transmit and log.
    try:
        bundle = FHIRBundle.model_validate(payload)
    except ValidationError as e:
        bundle_id = payload.get("id", "UNKNOWN")
        logging.warning(
            "ems-to-db: Validation FAILED | bundle_id=%s | error_count=%d",
            bundle_id,
            e.error_count(),
        )
        return func.HttpResponse(
            body=json.dumps(
                {
                    "error": (
                        "Payload validation failed. "
                        "See 'details' for all issues."
                    ),
                    # e.errors() → list of dicts, each with:
                    #   loc   → tuple of field path segments
                    #           e.g., ("hospitalId",) or
                    #                 ("entry", 1, "resource", "component", 0,
                    #                  "valueQuantity", "value")
                    #   msg   → human-readable description of the failure
                    #   type  → Pydantic error type code (e.g., "literal_error")
                    "details": e.errors(),
                }
            ),
            status_code=400,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Step 3: EDIT DETECTION — Read-Before-Write
    # -------------------------------------------------------------------------
    # exclude_none=True strips all Optional fields that were not provided
    # in the incoming payload, producing clean data-dense Cosmos documents.
    document: dict = bundle.model_dump(exclude_none=True)

    # WHY READ-BEFORE-WRITE (not a client-provided isEdit flag):
    # A client-provided "isEdit: true" flag could be spoofed by a malicious
    # or buggy client — anyone could claim their first submission is an edit
    # or claim their tenth edit is a first submission, corrupting editCount.
    # By performing a Cosmos read first, the backend is the authoritative source
    # of truth for editCount. The extra ~10ms read on a warm Cosmos connection
    # is an acceptable latency tradeoff for data integrity in a clinical system.
    try:
        existing = cosmos_container.read_item(
            item=bundle.id,
            partition_key=bundle.hospitalId,
        )
        # Document exists — this is a MEDIC EDIT (re-submission of same bundleId)
        document["editCount"] = existing.get("editCount", 0) + 1
        document["isEdited"] = True
        document["lastEditedAt"] = datetime.now(timezone.utc).isoformat()
        logging.info(
            "ems-to-db: EDIT detected | bundle_id=%s | hospitalId=%s | editCount=%d",
            bundle.id,
            bundle.hospitalId,
            document["editCount"],
        )
    except ResourceNotFoundError:
        # First submission — model defaults apply (editCount=0, isEdited=False)
        # No action needed; the document dict already has the correct defaults
        # from model_dump().
        pass

    # -------------------------------------------------------------------------
    # Step 4: Cosmos DB Write — upsert_item()
    # -------------------------------------------------------------------------
    # WHY upsert_item() over create_item():
    #   In a field network, packet loss and retries mean the same handoff
    #   payload may arrive more than once. upsert_item() is idempotent —
    #   a retransmission of "EMS-HANDOFF-MAX-001" overwrites the existing
    #   document rather than producing a 409 Conflict error. Resilience
    #   over strictness is the correct trade-off for EMS networks.
    try:
        cosmos_container.upsert_item(body=document)

        logging.info(
            "ems-to-db: Handoff persisted | bundle_id=%s | hospitalId=%s",
            bundle.id,
            bundle.hospitalId,
        )

        # ---------------------------------------------------------------------
        # 201 Response — Includes IDs for PWA LocalStorage Persistence
        # ---------------------------------------------------------------------
        # The PWA stores `bundle_id` and `hospitalId` from this response body
        # in Browser LocalStorage. When the medic later triggers "Arrived",
        # the PWA reads these values from LocalStorage and POSTs them to
        # /api/ems-arrival — completing the handoff lifecycle without any
        # server-side session state. The backend remains fully stateless.
        return func.HttpResponse(
            body=json.dumps(
                {
                    "message": "Handoff received and persisted successfully.",
                    "bundle_id": bundle.id,
                    "hospitalId": bundle.hospitalId,
                }
            ),
            status_code=201,
            mimetype="application/json",
        )

    except Exception:
        # Log bundle.id (non-PHI) for incident tracing. The exception
        # itself is logged by logging.exception() for the stack trace,
        # but we do NOT include exception message text in the HTTP response
        # body — Cosmos error messages may echo back document field names.
        logging.exception(
            "ems-to-db: Cosmos DB write FAILED | bundle_id=%s", bundle.id
        )
        return func.HttpResponse(
            body=json.dumps({"error": "Database write failed. Please retry."}),
            status_code=500,
            mimetype="application/json",
        )
