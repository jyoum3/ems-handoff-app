"""
blueprints/arrival_bp.py — EMS Arrival / Handoff Archival Blueprint
====================================================================
Route:   POST /api/ems-arrival
Purpose: Completes the PHI lifecycle for a single EMS handoff event.
         Triggered when a medic taps "Arrived" on the PWA, or when
         hospital staff manually confirms receipt of the patient.

PHI Lifecycle (Status-Update → Move-then-Delete Pattern):
    ┌─────────────────────────────────────────────────────────────────────┐
    │  POST /api/ems-arrival                                              │
    │    { "bundle_id": "EMS-HANDOFF-MAX-001", "hospitalId": "HUP-PAV" } │
    └──────────────────────┬──────────────────────────────────────────────┘
                           │
                    [1] Validate ArrivalRequest (Pydantic Bouncer)
                           │
                    [2] READ bundle from Cosmos DB (hot partition)
                           │        └─ 404 if not found
                           │
                    [3] PATCH handoffStatus → "arrived"
                           │    INJECT arrivedAt → UTC ISO 8601 server timestamp
                           │    UPSERT to Cosmos DB
                           │    ↳ Cosmos DB Change Feed fires (secondary path)
                           │
                    [4] BROADCAST "arrived" event directly to SignalR
                           │    ↳ ALL dashboards instantly remove patient card
                           │    ↳ Direct output binding — no Change Feed dependency
                           │    WHY: The Change Feed trigger is reliable in production
                           │    but has timing quirks in local dev for UPDATE events.
                           │    Emitting directly from the HTTP trigger guarantees
                           │    sub-100ms delivery regardless of environment.
                           │
                    [5] UPLOAD bundle JSON → Blob Storage (cold archive)
                           │    handoff-archive/{hospitalId}/{bundle_id}.json
                           │        └─ 500 if upload fails → Cosmos UNTOUCHED
                           │
                    [6] DELETE bundle from Cosmos DB (hot partition)
                           │        └─ 500 if delete fails → data safe in Blob
                           │
                    [7] Return 200 — lifecycle complete

Design Decision — Direct SignalR Broadcast (Step 4):
    The Cosmos DB Change Feed trigger (streaming_bp.py) was the original
    mechanism for broadcasting "arrived" status changes. While reliable in
    Azure production, the Change Feed has a polling window in local development
    that can fall between the Cosmos upsert (Step 3) and the delete (Step 6),
    causing it to miss the UPDATE event and leaving patient cards on screen.

    The architectural fix: add a SignalR output binding directly to this HTTP
    trigger so the "arrived" event broadcasts in the same HTTP execution — no
    Change Feed dependency, sub-100ms delivery in all environments. The Change
    Feed remains active in production as a secondary safety net (the reducer's
    HANDOFF_UPDATE action is idempotent on duplicate events).

    This pattern is consistent with recover_handoff_bp.py, which also emits
    its "restored" event directly rather than relying on the Change Feed.

Safety Guarantee (Write-Before-Delete):
    The archive upload to Blob Storage is ALWAYS performed and confirmed
    BEFORE the Cosmos DB delete is attempted. This guarantees that PHI
    exists in at least one durable store at all times.

Security:
    - DefaultAzureCredential (via shared_clients.py): zero hardcoded secrets.
    - PHI is NEVER logged. Only bundle_id and hospitalId are used for tracing.
    - Blob path is constructed from validated, allowlisted hospitalId values.

Environment Variables:
    ARCHIVE_CONTAINER_NAME — Blob container for archival (e.g., "handoff-archive")
"""

import json
import logging
import os
from datetime import datetime, timezone

import azure.functions as func
from azure.core.exceptions import ResourceNotFoundError
from pydantic import ValidationError

from models import ArrivalRequest
from shared_clients import blob_service_client, chat_container, comments_container, cosmos_container

# =============================================================================
# Blueprint Instance
# =============================================================================

bp = func.Blueprint()

_ARCHIVE_CONTAINER: str = os.environ["ARCHIVE_CONTAINER_NAME"]
_HUB_NAME = "EmsHandoff"
_SIGNALR_TARGET = "handoffUpdate"


# =============================================================================
# Route: POST /api/ems-arrival
# =============================================================================


@bp.route(route="ems-arrival", methods=["POST"])
@bp.generic_output_binding(
    arg_name="signalr_messages",
    type="signalR",
    hub_name=_HUB_NAME,
    # Direct SignalR broadcast — output binding guarantees sub-100ms delivery
    # to all connected dashboards, independent of the Change Feed polling window.
    # Uses the same AzureSignalRConnectionString as streaming_bp.py.
    connection="AzureSignalRConnectionString",
)
def ems_arrival(
    req: func.HttpRequest,
    signalr_messages: func.Out[str],
) -> func.HttpResponse:
    """
    HTTP-Triggered Azure Function: EMS Arrival / Handoff Archival.

    Implements the Status-Update → Move-then-Delete PHI lifecycle pattern.
    Broadcasts the "arrived" status update to all connected dashboard clients
    directly via SignalR output binding (sub-100ms) and simultaneously to
    the EMS PWA (notifying the medic's device), then archives the PHI to
    Blob Storage and removes the hot Cosmos record.
    """
    logging.info("ems-arrival: Arrival trigger received.")

    # -------------------------------------------------------------------------
    # Step 1: Parse the raw JSON body
    # -------------------------------------------------------------------------
    try:
        payload: dict = req.get_json()
    except ValueError:
        logging.warning("ems-arrival: Request body is not valid JSON.")
        return func.HttpResponse(
            body=json.dumps({"error": "Request body must be valid JSON."}),
            status_code=400,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Step 2: Pydantic Validation — The Bouncer
    # -------------------------------------------------------------------------
    try:
        arrival = ArrivalRequest.model_validate(payload)
    except ValidationError as e:
        bundle_id = payload.get("bundle_id", "UNKNOWN")
        logging.warning(
            "ems-arrival: Validation FAILED | bundle_id=%s | error_count=%d",
            bundle_id,
            e.error_count(),
        )
        return func.HttpResponse(
            body=json.dumps(
                {
                    "error": (
                        "Arrival request validation failed. "
                        "See 'details' for all issues."
                    ),
                    "details": e.errors(),
                }
            ),
            status_code=400,
            mimetype="application/json",
        )

    bundle_id: str = arrival.bundle_id
    hospital_id: str = arrival.hospitalId

    # -------------------------------------------------------------------------
    # Step 3: READ bundle from Cosmos DB
    # -------------------------------------------------------------------------
    try:
        bundle_document: dict = cosmos_container.read_item(
            item=bundle_id,
            partition_key=hospital_id,
        )
        logging.info(
            "ems-arrival: Bundle fetched from Cosmos | bundle_id=%s | hospitalId=%s",
            bundle_id,
            hospital_id,
        )
    except ResourceNotFoundError:
        logging.warning(
            "ems-arrival: Bundle NOT FOUND in Cosmos | bundle_id=%s | hospitalId=%s",
            bundle_id,
            hospital_id,
        )
        return func.HttpResponse(
            body=json.dumps(
                {
                    "error": (
                        "Handoff record not found. It may have already "
                        "been archived or the IDs are incorrect."
                    ),
                    "bundle_id": bundle_id,
                    "hospitalId": hospital_id,
                }
            ),
            status_code=404,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Step 4: PATCH handoffStatus → "arrived" + INJECT arrivedAt timestamp
    # -------------------------------------------------------------------------
    bundle_document["handoffStatus"] = "arrived"
    bundle_document["arrivedAt"] = datetime.now(timezone.utc).isoformat()

    try:
        cosmos_container.upsert_item(body=bundle_document)
        logging.info(
            "ems-arrival: handoffStatus patched → 'arrived' | "
            "bundle_id=%s | hospitalId=%s | Change Feed triggered.",
            bundle_id,
            hospital_id,
        )
    except Exception:
        logging.exception(
            "ems-arrival: Status patch FAILED | bundle_id=%s | hospitalId=%s",
            bundle_id,
            hospital_id,
        )
        return func.HttpResponse(
            body=json.dumps(
                {
                    "error": (
                        "Failed to update arrival status. "
                        "Handoff record unchanged. Please retry."
                    )
                }
            ),
            status_code=500,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Step 5: BROADCAST "arrived" event directly to SignalR
    # -------------------------------------------------------------------------
    # WHY THIS IS NOW THE PRIMARY NOTIFICATION MECHANISM:
    # ─────────────────────────────────────────────────────────────────────────
    # The Cosmos DB Change Feed trigger (streaming_bp.py) was the original
    # mechanism for broadcasting "arrived" status changes. While this works
    # reliably in Azure production (the Change Feed is an append-only log that
    # always captures upserts), local development has a timing quirk:
    #
    #   In local dev, the Change Feed trigger polls Cosmos at ~1s intervals.
    #   The arrival_bp upserts (Step 4), then immediately deletes (Step 7).
    #   If the polling window happens to fall BETWEEN the upsert and delete,
    #   the Change Feed sees the "arrived" document. If it falls AFTER both,
    #   the trigger may process the change as "document deleted" and skip it.
    #
    # By emitting directly from the HTTP trigger using the SignalR output
    # binding, we guarantee delivery regardless of Change Feed timing.
    # The message reaches Azure SignalR Service within the same HTTP request
    # execution — sub-100ms from when the nurse clicks "Arrive".
    #
    # The Change Feed still fires in production as a secondary safety net.
    # Having two mechanisms is acceptable — the reducer's HANDOFF_UPDATE
    # case is idempotent: processing the same "arrived" bundle twice simply
    # tries to remove a key that's already absent from liveQueue (no-op).
    try:
        signalr_message_list = [
            # Message 1: Hospital-facing broadcast (existing)
            {
                "userId": hospital_id,
                "target": _SIGNALR_TARGET,          # "handoffUpdate"
                "arguments": [bundle_document],
            },
            # Message 2: EMS-facing broadcast (new — notifies medic's PWA)
            {
                "userId": bundle_id,                # patient-scoped — targets the EMS device
                "target": "emsHandoffUpdate",
                "arguments": [{
                    "action": "arrived_by_hospital",
                    "bundleId": bundle_id,
                    "hospitalId": hospital_id,
                }],
            },
        ]
        signalr_messages.set(json.dumps(signalr_message_list))
        logging.info(
            "ems-arrival: Dual SignalR broadcast sent (hospital + EMS) | "
            "bundle_id=%s | hospitalId=%s",
            bundle_id,
            hospital_id,
        )
    except Exception:
        # SignalR broadcast failure is non-fatal — the Cosmos upsert succeeded,
        # so the Change Feed will still fire and eventually deliver the event.
        # Log for ops awareness but do not return an error to the client.
        logging.exception(
            "ems-arrival: SignalR broadcast FAILED (non-fatal) | bundle_id=%s",
            bundle_id,
        )

    # -------------------------------------------------------------------------
    # Step 6: UPLOAD bundle JSON → Blob Storage
    # -------------------------------------------------------------------------
    # Blob path: {hospitalId}/{YYYY-MM-DD}/{bundleId}/handoff.json
    # Date subfolder enables date-range queries and separates same-patient
    # re-visits (different bundleIds, different dates) without requiring an MRN.
    # All PHI artifacts (handoff + chat) live under the same bundleId folder.
    arrived_date: str = bundle_document.get("arrivedAt", "")[:10] or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    blob_path: str = f"{hospital_id}/{arrived_date}/{bundle_id}/handoff.json"
    blob_content: str = json.dumps(bundle_document)

    try:
        blob_client = blob_service_client.get_blob_client(
            container=_ARCHIVE_CONTAINER,
            blob=blob_path,
        )
        blob_client.upload_blob(
            data=blob_content,
            overwrite=True,
        )
        logging.info(
            "ems-arrival: Bundle archived to Blob | path=%s/%s",
            _ARCHIVE_CONTAINER,
            blob_path,
        )
    except Exception:
        logging.exception(
            "ems-arrival: Blob upload FAILED | bundle_id=%s | hospitalId=%s",
            bundle_id,
            hospital_id,
        )
        return func.HttpResponse(
            body=json.dumps(
                {"error": "Archive upload failed. Handoff record preserved. Please retry."}
            ),
            status_code=500,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Step 7: DELETE bundle from Cosmos DB
    # -------------------------------------------------------------------------
    try:
        cosmos_container.delete_item(
            item=bundle_id,
            partition_key=hospital_id,
        )
        logging.info(
            "ems-arrival: Bundle deleted from Cosmos | bundle_id=%s | hospitalId=%s",
            bundle_id,
            hospital_id,
        )
    except Exception:
        logging.exception(
            "ems-arrival: Cosmos delete FAILED (PHI archived in Blob) | bundle_id=%s",
            bundle_id,
        )
        return func.HttpResponse(
            body=json.dumps(
                {
                    "error": (
                        "Handoff archived successfully but Cosmos cleanup failed. "
                        "Please retry to complete the deletion."
                    ),
                    "bundle_id": bundle_id,
                    "hospitalId": hospital_id,
                }
            ),
            status_code=500,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Step 8: ARCHIVE CHAT COMPANION BLOB (best-effort)
    # -------------------------------------------------------------------------
    # The chat log (inbound-chat Cosmos container) is a companion to the PHI
    # bundle. At arrival, both are archived together. The chat companion blob
    # lives at the same prefix path as the PHI bundle, with a -chat.json suffix:
    #   handoff-archive/{hospitalId}/{bundle_id}-chat.json
    #
    # WHY BEST-EFFORT (no return on failure):
    # If the patient has no chat history, ResourceNotFoundError is expected and
    # silently ignored. If the Cosmos read or blob upload fails for any other
    # reason, it is logged but the arrival lifecycle is NOT blocked — the PHI
    # bundle is already safely archived (Step 6) and the Cosmos record deleted
    # (Step 7). Stopping arrival for a chat backup failure would be
    # clinically incorrect: the patient HAS physically arrived.
    chat_blob_path: str = f"{hospital_id}/{arrived_date}/{bundle_id}/chat.json"
    try:
        chat_doc = chat_container.read_item(
            item=bundle_id,
            partition_key=bundle_id,
        )
        chat_blob_client = blob_service_client.get_blob_client(
            container=_ARCHIVE_CONTAINER,
            blob=chat_blob_path,
        )
        chat_blob_client.upload_blob(
            data=json.dumps(chat_doc),
            overwrite=True,
        )
        logging.info(
            "ems-arrival: Chat archived to Blob | path=%s/%s",
            _ARCHIVE_CONTAINER,
            chat_blob_path,
        )
        # Clean up the Cosmos chat document (best-effort)
        try:
            chat_container.delete_item(
                item=bundle_id,
                partition_key=bundle_id,
            )
            logging.info(
                "ems-arrival: inbound-chat doc deleted | bundle_id=%s", bundle_id
            )
        except Exception:
            logging.exception(
                "ems-arrival: inbound-chat delete FAILED (non-fatal) | bundle_id=%s",
                bundle_id,
            )
    except ResourceNotFoundError:
        pass  # No chat history for this patient — expected, not an error
    except Exception:
        logging.exception(
            "ems-arrival: Chat archival FAILED (non-fatal) | bundle_id=%s", bundle_id
        )

    # -------------------------------------------------------------------------
    # Step 9: DELETE comment doc from handoff-comments container (best-effort)
    # -------------------------------------------------------------------------
    # Comments are hospital operational metadata — they do not belong in the
    # archived blob (which is a PHI-only clinical record). Clean up the comment
    # doc now that the handoff is archived and the hot Cosmos record is gone.
    #
    # 404 (ResourceNotFoundError) is the expected case when no comments were
    # ever added for this patient. Any other exception is non-fatal — the
    # comment doc is small and will not cause problems if left orphaned.
    try:
        comments_container.delete_item(
            item=bundle_id,
            partition_key=hospital_id,
        )
        logging.info(
            "ems-arrival: Comment doc cleaned up | bundle_id=%s", bundle_id
        )
    except ResourceNotFoundError:
        pass  # Expected: patient had no comments — nothing to clean up
    except Exception:
        logging.exception(
            "ems-arrival: Comment doc cleanup FAILED (non-fatal) | bundle_id=%s",
            bundle_id,
        )

    # -------------------------------------------------------------------------
    # Step 9: Return 200 — PHI lifecycle complete
    # -------------------------------------------------------------------------
    logging.info(
        "ems-arrival: Handoff lifecycle COMPLETE | bundle_id=%s | hospitalId=%s",
        bundle_id,
        hospital_id,
    )
    return func.HttpResponse(
        body=json.dumps(
            {
                "message": "Handoff archived and removed from active queue.",
                "bundle_id": bundle_id,
                "hospitalId": hospital_id,
                "archive_path": f"{_ARCHIVE_CONTAINER}/{blob_path}",
            }
        ),
        status_code=200,
        mimetype="application/json",
    )
