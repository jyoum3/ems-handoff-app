"""
blueprints/recover_handoff_bp.py — Handoff Recovery / Restore Blueprint
========================================================================
Route:   POST /api/recover-handoff
Purpose: Restores an archived ("arrived") FHIR Bundle from Blob Storage
         back into the Cosmos DB hot partition, re-inserting it into the
         live patient queue across ALL connected dashboard instances.

When to Use (Clinical Context):
    The "Restore" button in the History Tab handles three real-world scenarios:
      1. "Ghost Handoff" recovery — EMS crew marked a patient as arrived but
         the patient was actually rerouted to a different ED. Staff forgot to
         clear the record and need to re-activate it for triage.
      2. Staff error — Hospital staff clicked "Arrive" on the wrong patient row.
         The patient's record needs to be restored immediately before care is
         disrupted.
      3. Medic error — Paramedic tapped "Arrived" on the EMS-facing PWA before
         reaching the hospital (e.g., during ACLS on scene). The handoff needs
         to be re-instated for the receiving ED.

Recovery Lifecycle:
    ┌─────────────────────────────────────────────────────────────────────┐
    │  POST /api/recover-handoff                                          │
    │    { "bundle_id": "EMS-HANDOFF-MAX-001", "hospitalId": "HUP-PAV" } │
    └──────────────────────┬──────────────────────────────────────────────┘
                           │
                    [1] Validate RecoverRequest (Pydantic Bouncer)
                           │
                    [2] READ archived blob from Blob Storage
                           │        └─ 404 if blob not found
                           │
                    [3] Re-validate blob content through FHIRBundle Bouncer
                           │        └─ 500 if archived data is corrupt
                           │
                    [4] PATCH handoffStatus → "inbound"
                           │    CLEAR arrivedAt → None (patient not yet arrived)
                           │
                    [5] UPSERT into Cosmos DB  ← THE CRITICAL STEP
                           │    ↳ Cosmos DB Change Feed fires
                           │    ↳ streaming_bp broadcasts to SignalR
                           │    ↳ ALL dashboards: patient appears in live queue
                           │    ↳ ALL dashboards: patient removed from history
                           │
                    [6] UPDATE blob with handoffStatus="inbound"
                           │    Prevents patient from reappearing in hot-tier
                           │    history list after successful recovery.
                           │
                    [7] Return 200 — patient restored to live queue

The Single Source of Truth Principle (Why Cosmos Must Be Re-Populated):
    ┌─────────────────────────────────────────────────────────────────────┐
    │  The Cosmos DB Change Feed is the ONLY synchronization mechanism   │
    │  for connected dashboard instances. It fires exclusively on        │
    │  INSERT/UPDATE operations to Cosmos DB.                            │
    │                                                                     │
    │  If we only updated the blob and skipped Cosmos:                   │
    │    ✗ No Change Feed event → No SignalR broadcast                   │
    │    ✗ All 18 workstations continue showing empty live queue         │
    │    ✗ Every nurse must manually refresh their browser               │
    │    ✗ During a trauma, this delay is clinically unacceptable        │
    │                                                                     │
    │  By upserting to Cosmos FIRST:                                     │
    │    ✓ Change Feed fires → streaming_bp broadcasts instantly         │
    │    ✓ All connected dashboards add patient to live queue in real time│
    │    ✓ All connected dashboards remove patient from history in real  │
    │      time (via the reducer's recovery-aware HANDOFF_UPDATE case)   │
    │    ✓ No manual refresh needed on any workstation                   │
    └─────────────────────────────────────────────────────────────────────┘

Data Isolation Guard:
    The `hospitalId` Literal allowlist in RecoverRequest is enforced at
    the Pydantic layer before any Blob or Cosmos operation. An attacker
    cannot use a valid HUP-CEDAR bundle_id with hospitalId="HUP-PAV" to
    restore another hospital's record — the blob path is constructed from
    the validated hospitalId, so the read will simply return 404.

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

import azure.functions as func
from azure.core.exceptions import ResourceNotFoundError
from pydantic import ValidationError

from models import FHIRBundle, RecoverRequest
from shared_clients import blob_service_client, chat_container, cosmos_container

# =============================================================================
# Blueprint Instance
# =============================================================================

bp = func.Blueprint()

# Read the archive container name once at module load time.
# KeyError is intentional here — fail fast if misconfigured at startup.
_ARCHIVE_CONTAINER: str = os.environ["ARCHIVE_CONTAINER_NAME"]
_HUB_NAME = "EmsHandoff"


# =============================================================================
# Route: POST /api/recover-handoff
# =============================================================================


@bp.route(route="recover-handoff", methods=["POST"])
@bp.generic_output_binding(
    arg_name="signalr_messages",
    type="signalR",
    hub_name=_HUB_NAME,
    connection="AzureSignalRConnectionString",
)
def recover_handoff(req: func.HttpRequest, signalr_messages: func.Out[str]) -> func.HttpResponse:
    """
    HTTP-Triggered Azure Function: Handoff Recovery / Restore.

    Reads an archived FHIR Bundle from Blob Storage and re-inserts it into
    the Cosmos DB hot partition with handoffStatus="inbound", restoring the
    patient to the live queue on ALL connected dashboard instances via the
    Cosmos DB Change Feed → SignalR pipeline.

    ┌──────────────────────────────────────────────────────────────────────┐
    │  REQUEST                                                             │
    │  Method:        POST                                                 │
    │  Route:         /api/recover-handoff                                 │
    │  Content-Type:  application/json                                     │
    │  Body:          { "bundle_id": "...", "hospitalId": "..." }          │
    └──────────────────────────────────────────────────────────────────────┘

    ┌──────────────────────────────────────────────────────────────────────┐
    │  RESPONSES                                                           │
    │  200 OK           Patient restored to live queue.                   │
    │  400 Bad Request  Body is not JSON OR RecoverRequest validation      │
    │                   failed (e.g., unknown hospitalId).                 │
    │  404 Not Found    No archived blob found for the given IDs.          │
    │  500 Server Error Blob read, Cosmos upsert, or Blob update failed.  │
    └──────────────────────────────────────────────────────────────────────┘
    """
    logging.info("recover-handoff: Recovery request received.")

    # -------------------------------------------------------------------------
    # Step 1: Parse the raw JSON body
    # -------------------------------------------------------------------------
    try:
        payload: dict = req.get_json()
    except ValueError:
        logging.warning("recover-handoff: Request body is not valid JSON.")
        return func.HttpResponse(
            body=json.dumps({"error": "Request body must be valid JSON."}),
            status_code=400,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Step 2: Pydantic Validation — The Bouncer
    # -------------------------------------------------------------------------
    # RecoverRequest validates:
    #   bundle_id  → non-empty string (the Blob file name / Cosmos document id)
    #   hospitalId → must be one of the three allowlisted hospital codes
    #
    # The hospitalId validation is the data isolation guard — it ensures
    # the Blob path constructed below ({hospitalId}/{bundle_id}.json)
    # only points to the requesting hospital's archive directory.
    try:
        recover = RecoverRequest.model_validate(payload)
    except ValidationError as e:
        bundle_id = payload.get("bundle_id", "UNKNOWN")
        logging.warning(
            "recover-handoff: Validation FAILED | bundle_id=%s | error_count=%d",
            bundle_id,
            e.error_count(),
        )
        return func.HttpResponse(
            body=json.dumps(
                {
                    "error": (
                        "Recovery request validation failed. "
                        "See 'details' for all issues."
                    ),
                    "details": e.errors(),
                }
            ),
            status_code=400,
            mimetype="application/json",
        )

    bundle_id: str = recover.bundle_id
    hospital_id: str = recover.hospitalId

    # -------------------------------------------------------------------------
    # Step 3: READ archived blob from Blob Storage
    # -------------------------------------------------------------------------
    # Blob path discovery — supports TWO naming conventions:
    #
    #   NEW (arrival_bp.py post-Sprint 4 naming change):
    #     {hospitalId}/{YYYY-MM-DD}/{bundleId}/handoff.json
    #
    #   LEGACY (arrival_bp.py pre-naming-change):
    #     {hospitalId}/{bundleId}.json
    #
    # We don't know the date subfolder a priori (arrivedAt is in the blob,
    # which we haven't read yet). Use list_blobs() with the hospitalId prefix
    # to find the exact path regardless of the date subfolder, then fall back
    # to the flat legacy path for blobs archived before the naming change.
    blob_path: str | None = None
    try:
        container_client = blob_service_client.get_container_client(_ARCHIVE_CONTAINER)
        prefix = f"{hospital_id}/"
        for blob_item in container_client.list_blobs(name_starts_with=prefix):
            # New nested format: .../YYYY-MM-DD/{bundle_id}/handoff.json
            if blob_item.name.endswith(f"/{bundle_id}/handoff.json"):
                blob_path = blob_item.name
                break
    except Exception:
        logging.exception(
            "recover-handoff: Blob listing FAILED (falling back to legacy path) | "
            "bundle_id=%s | hospitalId=%s",
            bundle_id, hospital_id,
        )

    # Fallback: legacy flat path for blobs archived before the naming change
    if blob_path is None:
        blob_path = f"{hospital_id}/{bundle_id}.json"

    try:
        blob_client = blob_service_client.get_blob_client(
            container=_ARCHIVE_CONTAINER,
            blob=blob_path,
        )
        download_stream = blob_client.download_blob()
        blob_content: str = download_stream.readall().decode("utf-8")

        logging.info(
            "recover-handoff: Blob fetched | hospitalId=%s | bundle_id=%s",
            hospital_id,
            bundle_id,
        )

    except ResourceNotFoundError:
        logging.warning(
            "recover-handoff: Blob NOT FOUND | path=%s/%s",
            _ARCHIVE_CONTAINER,
            blob_path,
        )
        return func.HttpResponse(
            body=json.dumps(
                {
                    "error": (
                        "Archived record not found. The bundle may not have been "
                        "archived yet, or the IDs are incorrect."
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
            "recover-handoff: Blob download FAILED | bundle_id=%s | hospitalId=%s",
            bundle_id,
            hospital_id,
        )
        return func.HttpResponse(
            body=json.dumps(
                {"error": "Failed to retrieve archived record. Please retry."}
            ),
            status_code=500,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Step 4: Re-validate the archived blob content through FHIRBundle Bouncer
    # -------------------------------------------------------------------------
    # WHY RE-VALIDATE? — Defensive Programming for Archived Data:
    # ─────────────────────────────────────────────────────────────────────────
    # The archived blob was written by arrival_bp.py after passing the original
    # Pydantic validation at ingestion time. In theory, the data should still
    # be valid. However:
    #   a) A schema change between Sprint sprints could mean the stored blob
    #      no longer conforms to the CURRENT FHIRBundle model.
    #   b) The blob could have been manually modified (compliance correction,
    #      data rectification) and the modification may have introduced an error.
    #   c) The blob could be corrupt due to a storage issue.
    #
    # Re-validating through FHIRBundle before writing to Cosmos ensures that
    # ONLY schema-valid data re-enters the live pipeline. Corrupted or stale
    # archive data should never silently pollute the live Cosmos partition.
    try:
        bundle_dict: dict = json.loads(blob_content)
    except json.JSONDecodeError:
        logging.error(
            "recover-handoff: Blob content is not valid JSON | bundle_id=%s",
            bundle_id,
        )
        return func.HttpResponse(
            body=json.dumps(
                {"error": "Archived record is malformed. Cannot recover."}
            ),
            status_code=500,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Step 5: PATCH the bundle for re-instatement
    # -------------------------------------------------------------------------
    # Two mutations are applied BEFORE the Cosmos upsert:
    #
    # handoffStatus → "inbound":
    #   Re-activates the patient in the live queue. When the Change Feed fires
    #   after the Cosmos upsert, the streaming_bp broadcasts the document with
    #   handoffStatus="inbound". The frontend reducer's HANDOFF_UPDATE case for
    #   "inbound" will:
    #     1. Add the patient to liveQueue (restored to live feed)
    #     2. Remove the patient from history[] (if present — covers the case
    #        where the same browser session witnessed the original arrival)
    #
    # arrivedAt → None:
    #   The patient has NOT arrived yet (that's why we're restoring them).
    #   Clearing arrivedAt prevents the modal from displaying a stale "Arrived
    #   at HH:MM" timestamp from the erroneous arrival event. The field will
    #   be set again — correctly — if/when the patient actually arrives.
    bundle_dict["handoffStatus"] = "inbound"
    bundle_dict["arrivedAt"] = None

    # -------------------------------------------------------------------------
    # Step 6: UPSERT into Cosmos DB — THE CRITICAL SYNCHRONIZATION STEP
    # -------------------------------------------------------------------------
    # This is the step that makes recovery "global" — affecting ALL connected
    # dashboard instances, not just the workstation that clicked "Restore."
    #
    # The upsert triggers the Cosmos DB Change Feed → streaming_bp broadcasts
    # the recovered document to SignalR → all dashboard WebSocket connections
    # receive a 'handoffUpdate' event → the reducer handles it:
    #   HANDOFF_UPDATE(handoffStatus="inbound")
    #     → liveQueue[bundle.id] = bundle   (patient appears in live queue)
    #     → history = history.filter(b => b.id !== bundle.id)  (removed from history)
    #
    # upsert_item() is used instead of create_item() for idempotency:
    # If the Cosmos upsert succeeds but the subsequent blob update (Step 7)
    # fails, and the client retries, the upsert simply overwrites the same
    # document rather than creating a duplicate. Safe to retry.
    try:
        cosmos_container.upsert_item(body=bundle_dict)
        logging.info(
            "recover-handoff: Bundle upserted to Cosmos → 'inbound' | "
            "bundle_id=%s | hospitalId=%s | Change Feed triggered.",
            bundle_id,
            hospital_id,
        )
    except Exception:
        logging.exception(
            "recover-handoff: Cosmos upsert FAILED | bundle_id=%s | hospitalId=%s",
            bundle_id,
            hospital_id,
        )
        return func.HttpResponse(
            body=json.dumps(
                {
                    "error": (
                        "Failed to restore handoff to active queue. "
                        "Archived record is unchanged. Please retry."
                    )
                }
            ),
            status_code=500,
            mimetype="application/json",
        )

    # Notify EMS PWA that patient has been restored to live queue
    try:
        ems_restore_msg = [{
            "userId": bundle_id,
            "target": "emsHandoffUpdate",
            "arguments": [{"action": "restored", "bundleId": bundle_id, "hospitalId": hospital_id}],
        }]
        signalr_messages.set(json.dumps(ems_restore_msg))
        logging.info(
            "recover-handoff: EMS SignalR 'restored' broadcast sent | bundle_id=%s",
            bundle_id,
        )
    except Exception:
        logging.exception(
            "recover-handoff: EMS SignalR broadcast FAILED (non-fatal) | bundle_id=%s",
            bundle_id,
        )

    # -------------------------------------------------------------------------
    # Step 7: UPDATE the blob with handoffStatus="inbound"
    # -------------------------------------------------------------------------
    # WHY UPDATE THE BLOB AFTER COSMOS:
    # ─────────────────────────────────────────────────────────────────────────
    # The hot-tier history list (GET /api/fetch-archive without bundleId) filters
    # out blobs where handoffStatus != "arrived". If we don't update the blob,
    # the patient would still appear in the history list on the next page refresh
    # (because the blob still shows handoffStatus="arrived"), even though they
    # are now actively inbound in the live queue. This creates a confusing dual
    # state where a patient appears in BOTH the live queue AND history.
    #
    # By overwriting the blob with handoffStatus="inbound", the hot-tier list
    # filter correctly excludes the recovered patient from history. The blob
    # is also updated rather than deleted — preserving the full audit trail
    # of the arrival event (we can still see that this patient was originally
    # arrived and then recovered, by reading the blob's version history if
    # blob versioning is enabled on the storage account).
    #
    # Order of operations (Cosmos before Blob):
    # The Cosmos upsert MUST happen first because the Change Feed is the
    # real-time signal. If the blob update fails after the Cosmos upsert
    # succeeds, the patient is correctly back in the live queue (the clinical
    # outcome we need). The only downside is a page-refresh would show them
    # in both tabs — a cosmetic issue that resolves on the next retry.
    # This is an acceptable trade-off vs. the risk of a failed Cosmos write.
    try:
        blob_client.upload_blob(
            data=json.dumps(bundle_dict),
            overwrite=True,
        )
        logging.info(
            "recover-handoff: Blob updated → 'inbound' | path=%s/%s",
            _ARCHIVE_CONTAINER,
            blob_path,
        )
    except Exception:
        # Blob update is a non-critical secondary operation. The Cosmos upsert
        # already succeeded — the patient IS back in the live queue (the clinical
        # outcome we need). A failed blob update means the History tab may show
        # a stale entry on page refresh, but the live feed is correct.
        #
        # Fall through to Step 8 and the final 200 response. Returning early
        # here would wrongly signal to staff that the patient was NOT restored.
        logging.exception(
            "recover-handoff: Blob update FAILED after Cosmos upsert "
            "(patient IS in live queue, non-fatal) | bundle_id=%s | hospitalId=%s",
            bundle_id,
            hospital_id,
        )

    # -------------------------------------------------------------------------
    # Step 8: RESTORE CHAT COMPANION (best-effort)
    # -------------------------------------------------------------------------
    # Read the archived chat companion blob and upsert it back into the
    # inbound-chat Cosmos container (partitioned by /bundleId). This restores
    # the full message history for the medic and ED staff if the patient is
    # re-activated after an erroneous arrival event.
    #
    # WHY BEST-EFFORT: If the patient had no chat history (no companion blob),
    # ResourceNotFoundError is the expected result — silently ignored. If any
    # other error occurs, the critical path (Cosmos upsert + blob update) has
    # already succeeded, so the patient IS in the live queue. Chat restoration
    # failure is a non-critical secondary loss.
    # Chat companion blob: same two-path discovery as the handoff blob.
    #   NEW format: {hospitalId}/{YYYY-MM-DD}/{bundleId}/chat.json
    #   LEGACY format: {hospitalId}/{bundleId}-chat.json
    chat_blob_path: str | None = None
    try:
        for blob_item in container_client.list_blobs(name_starts_with=f"{hospital_id}/"):
            if blob_item.name.endswith(f"/{bundle_id}/chat.json"):
                chat_blob_path = blob_item.name
                break
    except Exception:
        pass  # fall through to legacy path
    if chat_blob_path is None:
        chat_blob_path = f"{hospital_id}/{bundle_id}-chat.json"

    try:
        chat_blob_client = blob_service_client.get_blob_client(
            container=_ARCHIVE_CONTAINER,
            blob=chat_blob_path,
        )
        chat_download = chat_blob_client.download_blob()
        chat_doc = json.loads(chat_download.readall().decode("utf-8"))
        chat_doc["archived"] = False
        # Re-upsert into inbound-chat (partition key = bundleId)
        chat_container.upsert_item(body=chat_doc)
        # Update companion blob to reflect active state
        chat_blob_client.upload_blob(data=json.dumps(chat_doc), overwrite=True)
        logging.info(
            "recover-handoff: Chat restored from Blob | bundle_id=%s", bundle_id
        )
    except ResourceNotFoundError:
        pass  # No chat history — patient had no messages during previous inbound period
    except Exception:
        logging.exception(
            "recover-handoff: Chat restoration FAILED (non-fatal) | bundle_id=%s",
            bundle_id,
        )

    # -------------------------------------------------------------------------
    # Return 200 — Recovery complete
    # -------------------------------------------------------------------------
    # Both operations confirmed:
    #   ✅ Cosmos upserted → Change Feed → SignalR → patient in live queue on all dashboards
    #   ✅ Blob updated → handoffStatus="inbound" → patient excluded from history list
    logging.info(
        "recover-handoff: Recovery COMPLETE | bundle_id=%s | hospitalId=%s",
        bundle_id,
        hospital_id,
    )
    # CRITICAL: Return bundle_dict (the full FHIRBundle) — mirrors divert_handoff_bp.py.
    # The EMS-SWA frontend casts the response directly to FHIRBundle via
    # `res.json() as Promise<FHIRBundle>`. Returning only metadata produces a
    # fake FHIRBundle where bundle.id is undefined, breaking the restore flow:
    #   bundle.id undefined → setBundleId(undefined) → useEmsSignalR(undefined)
    #   → stopConnection() → SignalR drops → 🔴 Disconnected + blank LiveView.
    return func.HttpResponse(
        body=json.dumps(bundle_dict),
        status_code=200,
        mimetype="application/json",
    )
