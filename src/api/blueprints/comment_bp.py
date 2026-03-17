"""
blueprints/comment_bp.py — Clinical Staff Comment Blueprint
===============================================================================
Routes:
  GET  /api/get-comments    → Fetch CommentMap for all patients at a hospital
  POST /api/update-comment  → Append a new comment, broadcast via SignalR

COMMENT STORAGE MODEL — Separate Container:
  Comments live in the `handoff-comments` Cosmos container, NOT on the FHIR
  bundle. This architectural separation is intentional:

    FHIR Bundle (handoffs container) = PHI clinical data
    Comment Document (handoff-comments) = Hospital operational metadata

  Keeping these in separate containers means:
    1. Comments survive independently of the PHI lifecycle (arrive/restore).
    2. The FHIR bundle schema stays clean — no operational metadata pollutes
       the clinical record that medics submit and the archive stores.
    3. Comment access patterns differ from PHI access: comments are read
       by hospitalId (all patients at once), not by individual bundleId.

  Comment Document Schema (partition key = hospitalId):
  {
    "id": "<bundleId>",         ← Cosmos doc id = the handoff bundleId
    "hospitalId": "HUP-PAV",   ← Partition key for efficient queries
    "comments": [
      {
        "commentId": "<uuid>",
        "text": "NEED LVAD SPECIALIST STAT",
        "authorRole": "CHARGE",
        "authorName": "Jane Doe",
        "createdAt": "2026-03-07T18:15:00.000Z"
      }
    ]
  }

REAL-TIME PROPAGATION:
  POST /api/update-comment broadcasts a 'commentUpdate' SignalR event
  (distinct from 'handoffUpdate') directly to the hospitalId group:
    target="commentUpdate"
    payload={ bundleId, hospitalId, allComments: [...] }

  The frontend useSignalR hook has a dedicated 'commentUpdate' listener
  that dispatches COMMENT_UPDATE to usePatientQueue, updating state.comments
  without touching the FHIR bundle state at all. This is a clean separation
  of concerns — comments are operational metadata, not clinical record data.

LIFECYCLE:
  - Comment docs are CREATED on the first POST for a patient.
  - Comment docs are APPENDED on subsequent POSTs (upsert pattern).
  - Comment docs are DELETED by arrival_bp.py at patient arrival time.
    This is a best-effort cleanup: 404 (doc not found) is silently ignored.
  - When a patient is Restored (recover_handoff_bp.py), no comment cleanup
    occurs — comments persist and remain accessible via getComments().
  - After the Cosmos handoff doc is deleted at arrival, the comment doc is
    also deleted. The archived blob in Blob Storage does NOT carry comments
    (they are not PHI and have no clinical value post-handoff).
  - After 24h, the lifecycle container policy moves the blob to Archive tier
    and the comment doc has already been cleaned up at arrival time — no
    orphaned data remains.

Security:
  - hospitalId is validated against the allowlist (Pydantic Bouncer).
  - commentText is length-validated (max 1000 chars, stripped).
  - authorRole and authorName come from the client session — trusted in
    portfolio context; in production, derive from Entra ID token claims.
  - PHI is never logged — only bundleId and hospitalId in traces.
"""

import json
import logging
import os
import uuid
from datetime import datetime, timezone

import azure.functions as func
from azure.core.exceptions import ResourceNotFoundError
from pydantic import BaseModel, ValidationError, field_validator

from shared_clients import comments_container

# =============================================================================
# Blueprint Instance
# =============================================================================

bp = func.Blueprint()

_HUB_NAME = "EmsHandoff"
_SIGNALR_TARGET = "commentUpdate"
_VALID_HOSPITALS = {"HUP-PAV", "HUP-PRESBY", "HUP-CEDAR"}


# =============================================================================
# Request Validation Model (Pydantic Bouncer)
# =============================================================================


class UpdateCommentRequest(BaseModel):
    """
    Validates the POST /api/update-comment request body.

    Fields:
        bundleId     → The FHIR Bundle identifier (e.g., "TEST-PAV-001")
        hospitalId   → Validated against the allowlist (data isolation)
        commentText  → Clinical note text (1-1000 chars, stripped)
        authorRole   → "CHARGE", "PFC", "INTAKE", "GENERAL-1", "GENERAL-2"
        authorName   → "Jane Doe" from the active UserSession
    """

    bundleId: str
    hospitalId: str
    commentText: str
    authorRole: str
    authorName: str

    @field_validator("hospitalId")
    @classmethod
    def validate_hospital(cls, v: str) -> str:
        if v not in _VALID_HOSPITALS:
            raise ValueError(f"Invalid hospitalId '{v}'.")
        return v

    @field_validator("commentText")
    @classmethod
    def validate_text(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("commentText cannot be blank.")
        if len(v) > 1000:
            raise ValueError(f"commentText too long ({len(v)} chars). Maximum is 1000.")
        return v

    @field_validator("authorRole")
    @classmethod
    def validate_role(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("authorRole cannot be blank.")
        return v

    @field_validator("authorName")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("authorName cannot be blank.")
        return v


# =============================================================================
# Route: GET /api/get-comments
# =============================================================================


@bp.route(route="get-comments", methods=["GET"])
def get_comments(req: func.HttpRequest) -> func.HttpResponse:
    """
    GET /api/get-comments?hospitalId=X

    Returns all comment documents for a hospital as a CommentMap:
      { "comments": { "<bundleId>": [HospitalComment, ...], ... } }

    Queries the handoff-comments Cosmos container by hospitalId partition key.
    This is called once on page load by usePatientQueue to hydrate state.comments
    with all existing comments for the hospital's active and recent patients.

    The result is a flat CommentMap keyed by bundleId — the frontend can
    look up comments for any patient in O(1) without a network call.
    """
    hospital_id = req.params.get("hospitalId", "").strip()

    if hospital_id not in _VALID_HOSPITALS:
        logging.warning("get-comments: Invalid hospitalId=%s", hospital_id)
        return func.HttpResponse(
            body=json.dumps({"error": f"Invalid hospitalId '{hospital_id}'."}),
            status_code=400,
            mimetype="application/json",
        )

    try:
        results = list(
            comments_container.query_items(
                query="SELECT * FROM c WHERE c.hospitalId = @hospitalId",
                parameters=[{"name": "@hospitalId", "value": hospital_id}],
                partition_key=hospital_id,
            )
        )

        # Build CommentMap: { bundleId: [HospitalComment...] }
        comment_map: dict = {}
        for doc in results:
            bundle_id = doc.get("id", "")
            if bundle_id:
                comment_map[bundle_id] = doc.get("comments", [])

        logging.info(
            "get-comments: Returned %d comment docs | hospitalId=%s",
            len(comment_map),
            hospital_id,
        )

        return func.HttpResponse(
            body=json.dumps({"comments": comment_map}),
            status_code=200,
            mimetype="application/json",
        )

    except Exception:
        logging.exception(
            "get-comments: Query FAILED | hospitalId=%s", hospital_id
        )
        return func.HttpResponse(
            body=json.dumps({"error": "Failed to fetch comments."}),
            status_code=500,
            mimetype="application/json",
        )


# =============================================================================
# Route: POST /api/update-comment
# =============================================================================


@bp.route(route="update-comment", methods=["POST"])
@bp.generic_output_binding(
    arg_name="signalr_messages",
    type="signalR",
    hub_name=_HUB_NAME,
    # Direct SignalR output binding — same pattern as arrival_bp.py.
    # Broadcasts 'commentUpdate' (not 'handoffUpdate') to the hospitalId group.
    # This keeps comment updates on a dedicated event channel, distinct from
    # the FHIR bundle update channel ('handoffUpdate').
    connection="AzureSignalRConnectionString",
)
def update_comment(
    req: func.HttpRequest,
    signalr_messages: func.Out[str],
) -> func.HttpResponse:
    """
    POST /api/update-comment

    Appends a new HospitalComment to the bundleId's comment document in the
    handoff-comments container, then broadcasts 'commentUpdate' via SignalR
    so all connected dashboards update state.comments in real time.

    Request body:
      { bundleId, hospitalId, commentText, authorRole, authorName }

    Response:
      { message, bundleId, commentId }
    """
    logging.info("update-comment: Comment request received.")

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
        comment_req = UpdateCommentRequest.model_validate(payload)
    except ValidationError as e:
        logging.warning(
            "update-comment: Validation FAILED | bundleId=%s | errors=%d",
            payload.get("bundleId", "UNKNOWN"),
            e.error_count(),
        )
        return func.HttpResponse(
            body=json.dumps({"error": "Validation failed.", "details": e.errors()}),
            status_code=400,
            mimetype="application/json",
        )

    bundle_id = comment_req.bundleId
    hospital_id = comment_req.hospitalId

    # ── Step 3: Build new HospitalComment ────────────────────────────────────
    new_comment = {
        "commentId": str(uuid.uuid4()),
        "text": comment_req.commentText,
        "authorRole": comment_req.authorRole,
        "authorName": comment_req.authorName,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    logging.info(
        "update-comment: Comment built | bundleId=%s | commentId=%s",
        bundle_id,
        new_comment["commentId"],
    )

    # ── Step 4: Read or initialize comment document ───────────────────────────
    # Try to read the existing document for this patient. If it doesn't exist
    # yet (first comment ever for this patient), create a fresh document shell.
    try:
        comment_doc = comments_container.read_item(
            item=bundle_id,
            partition_key=hospital_id,
        )
        logging.info(
            "update-comment: Existing comment doc found | bundleId=%s", bundle_id
        )
    except ResourceNotFoundError:
        # First comment for this patient — create a new document
        comment_doc = {
            "id": bundle_id,
            "hospitalId": hospital_id,
            "comments": [],
        }
        logging.info(
            "update-comment: Creating new comment doc | bundleId=%s | hospitalId=%s",
            bundle_id,
            hospital_id,
        )
    except Exception:
        logging.exception(
            "update-comment: Read FAILED | bundleId=%s | hospitalId=%s",
            bundle_id,
            hospital_id,
        )
        return func.HttpResponse(
            body=json.dumps({"error": "Failed to read comment document. Please retry."}),
            status_code=500,
            mimetype="application/json",
        )

    # ── Step 5: Append comment ────────────────────────────────────────────────
    if not isinstance(comment_doc.get("comments"), list):
        comment_doc["comments"] = []
    comment_doc["comments"].append(new_comment)

    # ── Step 6: Upsert to comments container ─────────────────────────────────
    try:
        comments_container.upsert_item(body=comment_doc)
        logging.info(
            "update-comment: Comment persisted | bundleId=%s | hospitalId=%s",
            bundle_id,
            hospital_id,
        )
    except Exception:
        logging.exception(
            "update-comment: Upsert FAILED | bundleId=%s | hospitalId=%s",
            bundle_id,
            hospital_id,
        )
        return func.HttpResponse(
            body=json.dumps({"error": "Failed to save comment. Please retry."}),
            status_code=500,
            mimetype="application/json",
        )

    # ── Step 7: Direct SignalR broadcast ─────────────────────────────────────
    # Broadcasts 'commentUpdate' (not 'handoffUpdate') with the full updated
    # comments array. The frontend COMMENT_UPDATE reducer case merges this
    # into state.comments[bundleId] without touching the FHIR bundle state.
    all_comments = comment_doc["comments"]
    try:
        signalr_payload = {
            "bundleId": bundle_id,
            "hospitalId": hospital_id,
            "allComments": all_comments,
        }
        signalr_message = {
            "userId": hospital_id,
            "target": _SIGNALR_TARGET,
            "arguments": [signalr_payload],
        }
        signalr_messages.set(json.dumps([signalr_message]))
        logging.info(
            "update-comment: SignalR broadcast sent | bundleId=%s | hospitalId=%s",
            bundle_id,
            hospital_id,
        )
    except Exception:
        # Non-fatal: comment is already persisted. Dashboard will see it on
        # next getComments call (e.g., page refresh).
        logging.exception(
            "update-comment: SignalR broadcast FAILED (non-fatal) | bundleId=%s",
            bundle_id,
        )

    # ── Step 8: Return 200 ────────────────────────────────────────────────────
    return func.HttpResponse(
        body=json.dumps({
            "message": "Comment added successfully.",
            "bundleId": bundle_id,
            "commentId": new_comment["commentId"],
        }),
        status_code=200,
        mimetype="application/json",
    )
