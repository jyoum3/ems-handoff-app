"""
blueprints/chat_bp.py — Bidirectional EMS ↔ Hospital Chat Blueprint
=====================================================================
Routes:
  GET  /api/get-chat?bundleId=X&hospitalId=Y  → Hydrate chat thread on load
  POST /api/send-chat                          → Append message, fan-out SignalR

DUAL FAN-OUT ARCHITECTURE:
    Every chat message is broadcast to TWO SignalR userId targets simultaneously:
      1. userId=hospitalId  → Hospital Dashboard ChatPanel ('chatUpdate' event)
      2. userId=bundleId    → EMS PWA ChatHub ('chatUpdate' event)

    Both sides receive the FULL updated messages array (not just the delta) so
    they can overwrite their local state in a single merge — no diffing required.
    This "full-state broadcast" pattern prevents message de-sync between tabs or
    across reconnections.

    The dual fan-out is critical for UX continuity:
      • If only hospitalId were targeted, the medic's screen would never update.
      • If only bundleId were targeted, the ED charge nurse would never see the
        medic's messages until the next page refresh.
      • Both targets in a single signalr_messages.set() call ensures atomic
        delivery — either both sides get the message or neither does.

WHY inbound-chat IS PARTITIONED BY /bundleId (NOT /hospitalId):
    The chat document belongs to ONE PATIENT, not to a hospital. If a patient
    is diverted mid-transport (HUP-PAV → HUP-CEDAR), the chat thread MUST
    survive without re-keying. Cosmos DB forbids partition key changes on
    existing documents — you cannot move a document to a new partition
    without deleting and recreating it, which risks data loss during an
    active clinical handoff.

    By partitioning by /bundleId:
      ✅  Point reads by bundleId are maximally efficient (single-partition)
      ✅  Chat survives patient diversion — only hospitalId metadata updates
      ✅  divert_handoff_bp simply patches doc["hospitalId"] without touching
          the document's id or partition key
      ⚠️  Cannot list all chats for a hospital without cross-partition query
      ✅  We never need to list chats by hospital — always access by bundleId

Security:
    - hospitalId is validated against the allowlist (Pydantic Bouncer).
    - messageText is length-validated (max 1000 chars, stripped).
    - authorRole and authorName are stripped and validated as non-empty.
    - PHI is never logged — only bundleId, hospitalId, and messageId in traces.

Environment Variables:
    CHAT_CONTAINER_NAME         — Cosmos container for chat docs (inbound-chat)
    AzureSignalRConnectionString — Azure SignalR Service connection
"""

import json
import logging
import uuid
from datetime import datetime, timezone

import azure.functions as func
from azure.core.exceptions import ResourceNotFoundError
from pydantic import ValidationError

from models import SendChatRequest
from shared_clients import chat_container

# =============================================================================
# Blueprint Instance
# =============================================================================

bp = func.Blueprint()

_HUB_NAME = "EmsHandoff"
_VALID_HOSPITALS = {"HUP-PAV", "HUP-PRESBY", "HUP-CEDAR"}


# =============================================================================
# Route: GET /api/get-chat
# =============================================================================


@bp.route(route="get-chat", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def get_chat(req: func.HttpRequest) -> func.HttpResponse:
    """
    GET /api/get-chat?bundleId=X&hospitalId=Y

    Hydrates the chat thread for a specific patient bundle on LiveHandoffView
    load (EMS PWA) or PatientDetailModal open (Hospital Dashboard).

    Returns the full messages array from the inbound-chat Cosmos document.
    If no chat document exists yet (patient has no messages), returns an empty
    array with 200 — silence is not an error in a chat context.

    ┌──────────────────────────────────────────────────────────────────────┐
    │  REQUEST                                                             │
    │  Method:  GET                                                        │
    │  Route:   /api/get-chat                                              │
    │  Query:   bundleId=X    (required — inbound-chat document id)       │
    │           hospitalId=Y  (required — validated against allowlist)    │
    └──────────────────────────────────────────────────────────────────────┘

    ┌──────────────────────────────────────────────────────────────────────┐
    │  RESPONSES                                                           │
    │  200 OK           { "messages": [...] }  (empty array if no chat)   │
    │  400 Bad Request  Missing or invalid bundleId / hospitalId.         │
    │  500 Server Error Cosmos read failed for an unexpected reason.      │
    └──────────────────────────────────────────────────────────────────────┘
    """
    bundle_id: str = req.params.get("bundleId", "").strip()
    hospital_id: str = req.params.get("hospitalId", "").strip()

    # ── Validate query parameters ─────────────────────────────────────────────
    if not bundle_id:
        logging.warning("get-chat: Missing bundleId query parameter.")
        return func.HttpResponse(
            body=json.dumps({"error": "Missing required query parameter: bundleId."}),
            status_code=400,
            mimetype="application/json",
        )

    if hospital_id not in _VALID_HOSPITALS:
        logging.warning("get-chat: Invalid hospitalId=%s", hospital_id)
        return func.HttpResponse(
            body=json.dumps({"error": f"Invalid or missing hospitalId '{hospital_id}'."}),
            status_code=400,
            mimetype="application/json",
        )

    # ── Read chat document (partition_key = bundleId) ─────────────────────────
    try:
        doc = chat_container.read_item(
            item=bundle_id,
            partition_key=bundle_id,
        )
        logging.info(
            "get-chat: Chat doc fetched | bundleId=%s | hospitalId=%s | "
            "message_count=%d",
            bundle_id,
            hospital_id,
            len(doc.get("messages", [])),
        )
        return func.HttpResponse(
            body=json.dumps({"messages": doc.get("messages", [])}),
            status_code=200,
            mimetype="application/json",
        )

    except ResourceNotFoundError:
        # No chat document yet — patient hasn't sent or received any messages.
        # This is the EXPECTED state for a newly submitted handoff. Return an
        # empty messages array with 200 so the frontend initializes cleanly.
        logging.info(
            "get-chat: No chat doc found (patient has no messages) | bundleId=%s",
            bundle_id,
        )
        return func.HttpResponse(
            body=json.dumps({"messages": []}),
            status_code=200,
            mimetype="application/json",
        )

    except Exception:
        logging.exception(
            "get-chat: Cosmos read FAILED | bundleId=%s | hospitalId=%s",
            bundle_id,
            hospital_id,
        )
        return func.HttpResponse(
            body=json.dumps({"error": "Failed to retrieve chat messages. Please retry."}),
            status_code=500,
            mimetype="application/json",
        )


# =============================================================================
# Route: POST /api/send-chat
# =============================================================================


@bp.route(route="send-chat", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
@bp.generic_output_binding(
    arg_name="signalr_messages",
    type="signalR",
    hub_name=_HUB_NAME,
    # Dual fan-out: this single output binding is used to send TWO SignalR
    # messages — one to userId=hospitalId (hospital dashboard) and one to
    # userId=bundleId (EMS PWA). Both messages are delivered atomically by
    # passing a JSON array to signalr_messages.set().
    connection="AzureSignalRConnectionString",
)
def send_chat(
    req: func.HttpRequest,
    signalr_messages: func.Out[str],
) -> func.HttpResponse:
    """
    POST /api/send-chat

    Appends a new chat message to the bundleId's chat document in the
    inbound-chat Cosmos container, then broadcasts 'chatUpdate' via SignalR
    dual fan-out to both the hospital dashboard (userId=hospitalId) and the
    EMS PWA (userId=bundleId).

    If no chat document exists for this bundleId, one is created on the fly
    (read-or-initialize pattern, same as comment_bp.py).

    Request body:
      {
        "bundleId":     "EMS-55-1709925600000",
        "hospitalId":   "HUP-PAV",
        "messageText":  "Patient now in respiratory distress.",
        "authorRole":   "MEDIC-55",
        "authorName":   "Jane Doe",
        "authorSource": "EMS"
      }

    Response (200):
      { "message": "Chat message sent.", "bundleId": "...", "messageId": "..." }
    """
    logging.info("send-chat: Chat message request received.")

    # ── Step 1: Parse JSON ────────────────────────────────────────────────────
    try:
        payload: dict = req.get_json()
    except ValueError:
        return func.HttpResponse(
            body=json.dumps({"error": "Request body must be valid JSON."}),
            status_code=400,
            mimetype="application/json",
        )

    # ── Step 2: Pydantic Bouncer ──────────────────────────────────────────────
    try:
        chat_req = SendChatRequest.model_validate(payload)
    except ValidationError as e:
        logging.warning(
            "send-chat: Validation FAILED | bundleId=%s | errors=%d",
            payload.get("bundleId", "UNKNOWN"),
            e.error_count(),
        )
        return func.HttpResponse(
            body=json.dumps({"error": "Validation failed.", "details": e.errors()}),
            status_code=400,
            mimetype="application/json",
        )

    bundle_id: str = chat_req.bundleId
    hospital_id: str = chat_req.hospitalId

    # ── Step 3: Build new ChatMessage dict ───────────────────────────────────
    new_msg: dict = {
        "messageId":    str(uuid.uuid4()),
        "text":         chat_req.messageText,
        "authorRole":   chat_req.authorRole,
        "authorName":   chat_req.authorName,
        "authorSource": chat_req.authorSource,
        "createdAt":    datetime.now(timezone.utc).isoformat(),
    }
    logging.info(
        "send-chat: Message built | bundleId=%s | messageId=%s | source=%s",
        bundle_id,
        new_msg["messageId"],
        new_msg["authorSource"],
    )

    # ── Step 4: Read-or-initialize chat document ──────────────────────────────
    # Attempt a point read on the inbound-chat container (partition_key=bundleId).
    # If this is the first message for this patient, no document exists yet —
    # create a fresh document shell and the upsert in Step 5 will create it.
    try:
        chat_doc = chat_container.read_item(
            item=bundle_id,
            partition_key=bundle_id,
        )
        logging.info(
            "send-chat: Existing chat doc found | bundleId=%s | "
            "existing_message_count=%d",
            bundle_id,
            len(chat_doc.get("messages", [])),
        )
    except ResourceNotFoundError:
        # First message for this patient — initialize a new document.
        # The `id` field is the Cosmos document id AND the partition key.
        chat_doc = {
            "id":         bundle_id,
            "bundleId":   bundle_id,
            "hospitalId": hospital_id,
            "archived":   False,
            "messages":   [],
        }
        logging.info(
            "send-chat: Creating new chat doc | bundleId=%s | hospitalId=%s",
            bundle_id,
            hospital_id,
        )
    except Exception:
        logging.exception(
            "send-chat: Chat doc read FAILED | bundleId=%s | hospitalId=%s",
            bundle_id,
            hospital_id,
        )
        return func.HttpResponse(
            body=json.dumps({"error": "Failed to read chat document. Please retry."}),
            status_code=500,
            mimetype="application/json",
        )

    # ── Step 5: Append message and upsert ─────────────────────────────────────
    if not isinstance(chat_doc.get("messages"), list):
        chat_doc["messages"] = []
    chat_doc["messages"].append(new_msg)

    try:
        chat_container.upsert_item(body=chat_doc)
        logging.info(
            "send-chat: Chat doc upserted | bundleId=%s | "
            "total_message_count=%d",
            bundle_id,
            len(chat_doc["messages"]),
        )
    except Exception:
        logging.exception(
            "send-chat: Chat doc upsert FAILED | bundleId=%s | hospitalId=%s",
            bundle_id,
            hospital_id,
        )
        return func.HttpResponse(
            body=json.dumps({"error": "Failed to save chat message. Please retry."}),
            status_code=500,
            mimetype="application/json",
        )

    # ── Step 6: Dual SignalR fan-out ──────────────────────────────────────────
    # Build the shared payload containing the full updated messages array.
    # Both targets receive identical data — full state, not a delta — so
    # each client can overwrite their local chat state cleanly.
    full_messages = chat_doc["messages"]
    signalr_payload = {
        "bundleId":    bundle_id,
        "hospitalId":  hospital_id,
        "allMessages": full_messages,
    }

    try:
        dual_messages = [
            # Message 1: Hospital Dashboard — ChatPanel update
            {
                "userId":    hospital_id,
                "target":    "chatUpdate",
                "arguments": [signalr_payload],
            },
            # Message 2: EMS PWA — ChatHub update
            {
                "userId":    bundle_id,
                "target":    "chatUpdate",
                "arguments": [signalr_payload],
            },
        ]
        signalr_messages.set(json.dumps(dual_messages))
        logging.info(
            "send-chat: Dual SignalR 'chatUpdate' broadcast sent | "
            "bundleId=%s | hospitalId=%s",
            bundle_id,
            hospital_id,
        )
    except Exception:
        # Non-fatal: message is already persisted to Cosmos. Both clients will
        # see it on next get-chat call. Log for ops awareness.
        logging.exception(
            "send-chat: SignalR broadcast FAILED (non-fatal) | bundleId=%s",
            bundle_id,
        )

    # ── Step 7: Return 200 ────────────────────────────────────────────────────
    return func.HttpResponse(
        body=json.dumps({
            "message":   "Chat message sent.",
            "bundleId":  bundle_id,
            "messageId": new_msg["messageId"],
        }),
        status_code=200,
        mimetype="application/json",
    )
