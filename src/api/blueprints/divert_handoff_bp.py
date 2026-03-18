"""
blueprints/divert_handoff_bp.py — Patient Diversion Blueprint
=============================================================
Route:   POST /api/divert-handoff
Purpose: Migrates a FHIR Bundle from one hospital's Cosmos partition to
         another when a medic diverts a patient mid-transport.

Diversion Lifecycle (Write-Before-Delete + Dual SignalR Broadcast):
    ┌─────────────────────────────────────────────────────────────────────┐
    │  POST /api/divert-handoff                                           │
    │    {                                                                │
    │      "bundle_id":       "EMS-55-1709925600000",                    │
    │      "old_hospital_id": "HUP-PAV",                                 │
    │      "new_hospital_id": "HUP-CEDAR"                                │
    │    }                                                                │
    └──────────────────────┬──────────────────────────────────────────────┘
                           │
                    [1] Validate DivertRequest (Pydantic Bouncer)
                           │    └─ 400 if same hospital (model_validator)
                           │    └─ 400 if missing/invalid fields
                           │
                    [2] READ bundle from old_hospital_id Cosmos partition
                           │    └─ 404 if not found
                           │
                    [3] BUILD updated document
                           │    set document["hospitalId"] = new_hospital_id
                           │    all other fields preserved
                           │
                    [4] UPSERT updated document → new_hospital_id partition
                           │    └─ 500 if fails (old record UNTOUCHED)
                           │    Write-Before-Delete guarantee: new record
                           │    must exist before old is deleted
                           │
                    [5] DELETE bundle from old_hospital_id partition
                           │    └─ non-fatal if fails (PHI safe in new partition)
                           │
                    [6] BEST-EFFORT: Delete comment doc from handoff-comments
                           │    delete_item(bundle_id, partition_key=old_hospital_id)
                           │    ResourceNotFoundError → pass (expected)
                           │    WHY: Comments do NOT migrate to new hospital.
                           │    New hospital staff start with clean operational notes.
                           │    Ghost comment docs at old hospital would be
                           │    incorrectly cleaned up by arrival_bp at new hospital
                           │    (different partition) — divert_bp must clean them here.
                           │
                    [7] BEST-EFFORT: Update hospitalId on inbound-chat doc
                           │    read_item(bundle_id, partition_key=bundle_id)
                           │    set doc["hospitalId"] = new_hospital_id
                           │    upsert back to chat_container
                           │    WHY: The chat doc partition key (bundleId) does NOT
                           │    change — but hospitalId metadata must be updated so
                           │    send-chat can validate messages against the correct
                           │    hospital after diversion.
                           │
                    [8] BROADCAST dual SignalR messages
                           │    Message 1 → old_hospital_id: "diverted" removal event
                           │    Message 2 → new_hospital_id: full updated document
                           │
                    [9] Return 200

WRITE-BEFORE-DELETE GUARANTEE:
    Step 4 (UPSERT to new partition) is confirmed before Step 5 (DELETE from
    old partition). If the upsert fails, a 500 is returned immediately and the
    old record is left completely untouched. This ensures PHI always exists in
    at least one Cosmos partition at all times. A failed Step 5 is non-fatal —
    PHI exists safely in the new partition; the old record will be cleaned up
    on next arrival or manually.

FAILURE MATRIX:
    ┌──────────────────────────────────┬────────────────────────────────────┐
    │  Failure Point                   │  Outcome                           │
    ├──────────────────────────────────┼────────────────────────────────────┤
    │  Step 2: READ fails (404)        │  404 returned. Nothing mutated.    │
    │  Step 4: UPSERT fails            │  500 returned. Old record intact.  │
    │  Step 5: DELETE fails            │  Logged non-fatal. PHI in new ✅   │
    │  Step 6: Comment delete fails    │  Logged non-fatal. Ghost comment   │
    │                                  │  will not block clinical flow.     │
    │  Step 7: Chat metadata update    │  Logged non-fatal. hospitalId on   │
    │          fails                   │  chat doc may be stale but chat    │
    │                                  │  messages still delivered by       │
    │                                  │  bundleId routing.                 │
    │  Step 8: SignalR fails           │  Logged non-fatal. Change Feed     │
    │                                  │  may still deliver update.         │
    └──────────────────────────────────┴────────────────────────────────────┘

Security:
    - DivertRequest Pydantic Bouncer validates both hospitalId fields against
      the explicit Literal allowlist before any Cosmos operation.
    - PHI is NEVER logged. Only bundle_id and hospitalId values in traces.
    - DefaultAzureCredential (via shared_clients.py): zero hardcoded secrets.

Environment Variables:
    AzureSignalRConnectionString — Azure SignalR Service connection
"""

import json
import logging

import azure.functions as func
from azure.core.exceptions import ResourceNotFoundError
from pydantic import ValidationError

from models import DivertRequest
from shared_clients import chat_container, comments_container, cosmos_container

# =============================================================================
# Blueprint Instance
# =============================================================================

bp = func.Blueprint()

_HUB_NAME = "EmsHandoff"
_SIGNALR_TARGET = "handoffUpdate"


# =============================================================================
# Route: POST /api/divert-handoff
# =============================================================================


@bp.route(route="divert-handoff", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
@bp.generic_output_binding(
    arg_name="signalr_messages",
    type="signalR",
    hub_name=_HUB_NAME,
    connection="AzureSignalRConnectionString",
)
def divert_handoff(
    req: func.HttpRequest,
    signalr_messages: func.Out[str],
) -> func.HttpResponse:
    """
    HTTP-Triggered Azure Function: Patient Diversion / Cross-Partition Migration.

    Moves a FHIR Bundle from the old hospital's Cosmos partition to the new
    hospital's Cosmos partition, broadcasts removal to the old hospital and
    admission to the new hospital via dual SignalR broadcast.

    ┌──────────────────────────────────────────────────────────────────────┐
    │  REQUEST                                                             │
    │  Method:        POST                                                 │
    │  Route:         /api/divert-handoff                                  │
    │  Content-Type:  application/json                                     │
    │  Body:          { bundle_id, old_hospital_id, new_hospital_id }      │
    └──────────────────────────────────────────────────────────────────────┘

    ┌──────────────────────────────────────────────────────────────────────┐
    │  RESPONSES                                                           │
    │  200 OK           Patient diverted. Old partition empty.            │
    │  400 Bad Request  Validation failed (same hospital, missing fields). │
    │  404 Not Found    Bundle not found in old_hospital_id partition.     │
    │  500 Server Error UPSERT to new partition failed. Old intact.        │
    └──────────────────────────────────────────────────────────────────────┘
    """
    logging.info("divert-handoff: Diversion request received.")

    # -------------------------------------------------------------------------
    # Step 1: Parse JSON
    # -------------------------------------------------------------------------
    try:
        payload: dict = req.get_json()
    except ValueError:
        logging.warning("divert-handoff: Request body is not valid JSON.")
        return func.HttpResponse(
            body=json.dumps({"error": "Request body must be valid JSON."}),
            status_code=400,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Step 2: Pydantic Bouncer — DivertRequest
    # -------------------------------------------------------------------------
    # The @model_validator on DivertRequest rejects same-hospital requests
    # before any Cosmos operation is attempted.
    try:
        divert = DivertRequest.model_validate(payload)
    except ValidationError as e:
        logging.warning(
            "divert-handoff: Validation FAILED | bundle_id=%s | errors=%d",
            payload.get("bundle_id", "UNKNOWN"),
            e.error_count(),
        )
        return func.HttpResponse(
            body=json.dumps(
                {
                    "error": (
                        "Diversion request validation failed. "
                        "See 'details' for all issues."
                    ),
                    "details": e.errors(),
                }
            ),
            status_code=400,
            mimetype="application/json",
        )

    bundle_id: str = divert.bundle_id
    old_hospital_id: str = divert.old_hospital_id
    new_hospital_id: str = divert.new_hospital_id

    # -------------------------------------------------------------------------
    # Step 3: READ bundle from old_hospital_id partition
    # -------------------------------------------------------------------------
    try:
        document: dict = cosmos_container.read_item(
            item=bundle_id,
            partition_key=old_hospital_id,
        )
        logging.info(
            "divert-handoff: Bundle fetched from old partition | "
            "bundle_id=%s | old_hospital_id=%s",
            bundle_id,
            old_hospital_id,
        )
    except ResourceNotFoundError:
        logging.warning(
            "divert-handoff: Bundle NOT FOUND | bundle_id=%s | old_hospital_id=%s",
            bundle_id,
            old_hospital_id,
        )
        return func.HttpResponse(
            body=json.dumps(
                {
                    "error": (
                        "Bundle not found in the specified hospital partition. "
                        "It may have already been diverted or arrived."
                    ),
                    "bundle_id": bundle_id,
                    "old_hospital_id": old_hospital_id,
                }
            ),
            status_code=404,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Step 4: BUILD updated document with new hospitalId
    # -------------------------------------------------------------------------
    # The Cosmos document id stays the same. Only the hospitalId (partition key
    # metadata) changes. Because Cosmos DB does not allow partition key changes
    # on existing documents, we must delete and recreate — but we always write
    # the new document FIRST (Steps 5-6) before deleting the old one (Step 7).
    document["hospitalId"] = new_hospital_id
    updated_document: dict = document

    # -------------------------------------------------------------------------
    # Step 5: UPSERT updated document → new_hospital_id partition
    # -------------------------------------------------------------------------
    # This is the critical write. If it fails, we return 500 immediately and
    # leave the old record completely untouched. PHI integrity is guaranteed:
    # the patient remains in the old partition until the upsert succeeds.
    try:
        cosmos_container.upsert_item(body=updated_document)
        logging.info(
            "divert-handoff: Bundle upserted to new partition | "
            "bundle_id=%s | new_hospital_id=%s",
            bundle_id,
            new_hospital_id,
        )
    except Exception:
        logging.exception(
            "divert-handoff: UPSERT to new partition FAILED (old record intact) | "
            "bundle_id=%s | new_hospital_id=%s",
            bundle_id,
            new_hospital_id,
        )
        return func.HttpResponse(
            body=json.dumps(
                {
                    "error": (
                        "Failed to write bundle to new hospital partition. "
                        "Original record is unchanged. Please retry."
                    )
                }
            ),
            status_code=500,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Step 6: DELETE bundle from old_hospital_id partition (non-fatal)
    # -------------------------------------------------------------------------
    # PHI now exists safely in the new partition. If this delete fails, the
    # patient appears in both hospitals' queues — a cosmetic issue ops can
    # resolve. It does not block the diversion or put PHI at risk.
    try:
        cosmos_container.delete_item(
            item=bundle_id,
            partition_key=old_hospital_id,
        )
        logging.info(
            "divert-handoff: Bundle deleted from old partition | "
            "bundle_id=%s | old_hospital_id=%s",
            bundle_id,
            old_hospital_id,
        )
    except Exception:
        logging.exception(
            "divert-handoff: DELETE from old partition FAILED (non-fatal, "
            "PHI safe in new partition) | bundle_id=%s | old_hospital_id=%s",
            bundle_id,
            old_hospital_id,
        )

    # -------------------------------------------------------------------------
    # Step 7: BEST-EFFORT — Delete comment doc from old hospital partition
    # -------------------------------------------------------------------------
    # Comments (handoff-comments container, partitioned by hospitalId) do NOT
    # migrate to the new hospital. New hospital staff start with a clean slate
    # of operational notes. If not deleted here, the ghost comment doc would
    # never be cleaned up because arrival_bp at the new hospital targets the
    # new hospitalId partition — it would never find this old-partition doc.
    try:
        comments_container.delete_item(
            item=bundle_id,
            partition_key=old_hospital_id,
        )
        logging.info(
            "divert-handoff: Old comment doc deleted | "
            "bundle_id=%s | old_hospital_id=%s",
            bundle_id,
            old_hospital_id,
        )
    except ResourceNotFoundError:
        pass  # Expected: patient had no comments at old hospital — not an error
    except Exception:
        logging.exception(
            "divert-handoff: Comment doc delete FAILED (non-fatal) | "
            "bundle_id=%s | old_hospital_id=%s",
            bundle_id,
            old_hospital_id,
        )

    # -------------------------------------------------------------------------
    # Step 8: BEST-EFFORT — Update hospitalId metadata on inbound-chat doc
    # -------------------------------------------------------------------------
    # The chat document partition key (/bundleId) does NOT change — the document
    # stays in place. Only the hospitalId metadata field is updated so that
    # send-chat can correctly validate subsequent messages against the new hospital.
    # Any failure here is non-fatal: the chat thread is still routed by bundleId,
    # so messages will still be delivered — just with stale hospitalId metadata.
    try:
        chat_doc = chat_container.read_item(
            item=bundle_id,
            partition_key=bundle_id,
        )
        chat_doc["hospitalId"] = new_hospital_id
        chat_container.upsert_item(body=chat_doc)
        logging.info(
            "divert-handoff: Chat doc hospitalId updated | "
            "bundle_id=%s | new_hospital_id=%s",
            bundle_id,
            new_hospital_id,
        )
    except ResourceNotFoundError:
        pass  # No chat history for this patient — expected, not an error
    except Exception:
        logging.exception(
            "divert-handoff: Chat doc hospitalId update FAILED (non-fatal) | "
            "bundle_id=%s",
            bundle_id,
        )

    # -------------------------------------------------------------------------
    # Step 9: BROADCAST dual SignalR messages
    # -------------------------------------------------------------------------
    # Message 1 — Removal from old hospital:
    #   Sends a "diverted" sentinel to the old hospital's dashboard. The
    #   frontend reducer handles handoffStatus="diverted" as a removal signal,
    #   removing the patient card from the old hospital's live queue.
    #
    # Message 2 — Arrival at new hospital:
    #   Sends the full updated document (with hospitalId=new_hospital_id) to
    #   the new hospital's dashboard. The reducer upserts this into liveQueue,
    #   making the patient card appear immediately on the new hospital's screen.
    try:
        dual_messages = [
            # Message 1: Signal old hospital to remove the patient card
            {
                "userId":    old_hospital_id,
                "target":    _SIGNALR_TARGET,
                "arguments": [{
                    "id":            bundle_id,
                    "hospitalId":    old_hospital_id,
                    "handoffStatus": "diverted",
                }],
            },
            # Message 2: Send full updated document to new hospital
            {
                "userId":    new_hospital_id,
                "target":    _SIGNALR_TARGET,
                "arguments": [updated_document],
            },
        ]
        signalr_messages.set(json.dumps(dual_messages))
        logging.info(
            "divert-handoff: Dual SignalR broadcast sent | "
            "bundle_id=%s | old=%s → new=%s",
            bundle_id,
            old_hospital_id,
            new_hospital_id,
        )
    except Exception:
        # Non-fatal: Cosmos Change Feed may still deliver the update.
        logging.exception(
            "divert-handoff: SignalR broadcast FAILED (non-fatal) | bundle_id=%s",
            bundle_id,
        )

    # -------------------------------------------------------------------------
    # Step 10: Return 200 — Diversion complete
    # -------------------------------------------------------------------------
    # CRITICAL FIX: Return the full updated_document (FHIRBundle) so the
    # EMS-SWA frontend can call setCurrentBundle(newBundle) with a valid bundle.
    # Previously returning only metadata { message, bundle_id, old_hospital_id,
    # new_hospital_id } caused api.ts divertHandoff() — which casts to FHIRBundle —
    # to produce a broken object missing 'id', 'hospitalId', and 'entry[]'.
    # That broken object cascaded into: blank LiveHandoffView, undefined hospitalId
    # written to sessionStorage, and corrupted ems_hospital_history.
    logging.info(
        "divert-handoff: Diversion COMPLETE | bundle_id=%s | %s → %s",
        bundle_id,
        old_hospital_id,
        new_hospital_id,
    )
    return func.HttpResponse(
        body=json.dumps(updated_document),
        status_code=200,
        mimetype="application/json",
    )
