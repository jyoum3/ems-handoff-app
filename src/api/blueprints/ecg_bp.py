"""
blueprints/ecg_bp.py — ECG Upload Pipeline
============================================
ECG Upload Pipeline
───────────────────
POST /api/upload-ecg   (multipart form: bundleId, hospitalId, rhythmInterpretation?, file)
  1. Parse multipart/form-data body using email.parser.BytesParser
     (cgi.FieldStorage removed in Python 3.13 — replaced with stdlib email module)
  2. Validate metadata via EcgUploadRequest Pydantic Bouncer
     (bundle_id, hospitalId allowlist, rhythmInterpretation optional)
  3. Validate file presence — 400 if no file field
  4. Validate file type: {image/jpeg, image/png, application/pdf} → 400 if invalid
  5. Validate file size: max 10MB → 400 if exceeded
  6. Derive extension from content_type map
  7. Sprint 3.2: Unique blob path per upload using millisecond epoch timestamp:
       blob_file = f"ecg-{epoch_ms}.{ext}"
       blob_name = f"{hospitalId}/{bundleId}/{blob_file}"
     Each upload is now uniquely addressable — no more overwrites.
  8. Upload blob via ecg_container_client.upload_blob(overwrite=False)
  9. Construct blob_url from BLOB_SERVICE_ENDPOINT + ECG_CONTAINER_NAME + blob_name
  10. Determine label:
        label = "Initial" if this is the first record (ecgRecords=[])
        label = f"Update {HH:MM}" for subsequent uploads
  11. Append new EcgRecord (with blobKey) to bundle's ecgRecords list:
        a. Try read_item → if ecgRecords key exists: patch_item (op: "add", path: "/ecgRecords/-")
        b. If ecgRecords key missing (old doc format): add key + upsert_item
        c. If ResourceNotFoundError (bundle not yet submitted): return blob_url anyway
  12. Broadcast SignalR 'emsHandoffUpdate' to userId=bundleId (EMS live update)
  13. Broadcast SignalR 'handoffUpdate' to userId=hospitalId (hospital dashboard update)
  14. Return 200 { "blob_url": blob_url, "bundle_id": bundleId, "label": label }

GET /api/get-ecg?bundleId=X&hospitalId=Y&index=N
  1. Validate bundleId (non-empty) and hospitalId (allowlist)
  2. index param: integer, defaults to -1 (last/current ECG)
  3. Query Cosmos for bundle, read ecgRecords[index]
  4. Sprint 3.2: Use blobKey from record if present:
       blob_path = f"{hospitalId}/{bundleId}/{blobKey}"
     Legacy fallback: probe {hospitalId}/{bundleId}.{ext}
  5. Stream blob bytes, return Response with correct Content-Type
  6. If not found: return 404 { "error": "ECG not found" }

DELETE /api/delete-ecg?bundleId=X&hospitalId=Y&index=N
  1. Validate bundleId, hospitalId, index params
  2. Read bundle from Cosmos → get ecgRecords[index]
  3. Delete blob using blobKey (new format) or legacy path probe (fallback)
  4. Remove ecgRecords[index] from array via patch_item (replace entire array)
  5. Re-label remaining records: index 0 = "Initial", rest = "Update N"
  6. SignalR broadcast handled by Change Feed → streaming_bp pattern
  7. Return 200 { "bundleId": bundleId, "remainingCount": N }

WHY blob_name uses epoch_ms folder (Sprint 3.2):
  Each upload for a given bundleId now gets a UNIQUE path. The EcgRecord
  stores blobKey = "ecg-{epoch_ms}.{ext}" so GET and DELETE can reconstruct
  the exact path regardless of array index changes after deletions.
  Legacy GET fallback: probe {hospitalId}/{bundleId}.{ext} for pre-Sprint-3.2 blobs.

Security:
    - DefaultAzureCredential (via shared_clients.py): zero hardcoded secrets.
    - PHI is NEVER logged. Only bundle_id and hospitalId are used for tracing.
    - File type and size validated before any Blob Storage I/O.

Environment Variables:
    BLOB_SERVICE_ENDPOINT — Blob Storage account URI (for constructing blob URLs)
    ECG_CONTAINER_NAME    — Container name (default: "ecg-uploads")
"""

import json
import logging
import os
import time
from datetime import datetime, timezone
from email import policy as email_policy
from email.parser import BytesParser

import azure.functions as func
from azure.core.exceptions import ResourceNotFoundError
from pydantic import ValidationError

from models import EcgUploadRequest
from shared_clients import cosmos_container, ecg_container_client

# =============================================================================
# Blueprint Instance
# =============================================================================

bp = func.Blueprint()

_HUB_NAME = "EmsHandoff"
_BLOB_ENDPOINT: str = os.environ.get("BLOB_SERVICE_ENDPOINT", "")
_ECG_CONTAINER_NAME: str = os.getenv("ECG_CONTAINER_NAME", "ecg-uploads")
_ALLOWED_TYPES: dict[str, str] = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "application/pdf": "pdf",
}
_MAX_FILE_BYTES: int = 10 * 1024 * 1024  # 10 MB
_VALID_HOSPITALS: frozenset[str] = frozenset({"HUP-PAV", "HUP-PRESBY", "HUP-CEDAR"})


# =============================================================================
# Multipart Parser — replaces removed cgi.FieldStorage (Python 3.13+)
# =============================================================================


def _parse_multipart_form(body: bytes, content_type: str) -> dict[str, dict]:
    """
    Parse multipart/form-data without cgi (cgi module removed in Python 3.13).

    Uses stdlib email.parser.BytesParser — same underlying MIME machinery,
    zero external dependencies.

    Returns:
        dict[field_name] = {
            "value": bytes,          # field bytes (decode for text fields)
            "content_type": str,     # MIME type of part
            "filename": str | None,  # set for file upload parts
        }
    """
    # Prepend Content-Type header so BytesParser treats body as a MIME message
    raw = f"Content-Type: {content_type}\r\n\r\n".encode() + body
    msg = BytesParser(policy=email_policy.default).parsebytes(raw)

    result: dict[str, dict] = {}
    for part in msg.iter_parts():
        disposition = part.get("Content-Disposition", "")
        params: dict[str, str] = {}
        for seg in disposition.split(";"):
            seg = seg.strip()
            if "=" in seg:
                k, v = seg.split("=", 1)
                params[k.strip().lower()] = v.strip().strip('"')

        name = params.get("name")
        if not name:
            continue

        result[name] = {
            "value": part.get_payload(decode=True) or b"",
            "content_type": part.get_content_type() or "",
            "filename": params.get("filename"),
        }

    return result


def _field_text(form: dict[str, dict], key: str) -> str:
    """Extract and decode a text field from the parsed multipart form."""
    field = form.get(key)
    if field is None:
        return ""
    return (field["value"] or b"").decode("utf-8", errors="ignore").strip()


# =============================================================================
# Route: POST /api/upload-ecg
# =============================================================================


@bp.route(route="upload-ecg", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
@bp.generic_output_binding(
    arg_name="signalr_messages",
    type="signalR",
    hub_name=_HUB_NAME,
    connection="AzureSignalRConnectionString",
)
def upload_ecg(
    req: func.HttpRequest,
    signalr_messages: func.Out[str],
) -> func.HttpResponse:
    """
    HTTP-Triggered Azure Function: ECG Image Upload.

    Accepts a multipart/form-data POST with the ECG image file and metadata
    fields. Uploads the binary to Blob Storage and appends an EcgRecord to
    the matching FHIR bundle in Cosmos DB.

    Sprint 3.2 change: each upload uses a unique blob path:
        {hospitalId}/{bundleId}/ecg-{epoch_ms}.{ext}
    The EcgRecord stores blobKey = "ecg-{epoch_ms}.{ext}" for later retrieval.
    """
    logging.info("upload-ecg: Request received.")

    # -------------------------------------------------------------------------
    # Step 1: Parse multipart/form-data
    # -------------------------------------------------------------------------
    body: bytes = req.get_body()
    content_type: str = req.headers.get("Content-Type", "")

    if "multipart/form-data" not in content_type:
        return func.HttpResponse(
            body=json.dumps({"error": "Content-Type must be multipart/form-data."}),
            status_code=400,
            mimetype="application/json",
        )

    try:
        form = _parse_multipart_form(body, content_type)
    except Exception:
        logging.exception("upload-ecg: Failed to parse multipart body.")
        return func.HttpResponse(
            body=json.dumps({"error": "Failed to parse multipart form data."}),
            status_code=400,
            mimetype="application/json",
        )

    bundle_id: str = _field_text(form, "bundleId")
    hospital_id: str = _field_text(form, "hospitalId")
    rhythm_raw: str = _field_text(form, "rhythmInterpretation")
    rhythm: str | None = rhythm_raw if rhythm_raw else None

    # -------------------------------------------------------------------------
    # Step 2: Pydantic Bouncer — validate metadata fields
    # -------------------------------------------------------------------------
    try:
        EcgUploadRequest.model_validate({
            "bundle_id": bundle_id,
            "hospitalId": hospital_id,
            "rhythmInterpretation": rhythm,
        })
    except ValidationError as e:
        logging.warning(
            "upload-ecg: Metadata validation FAILED | bundle_id=%s | error_count=%d",
            bundle_id,
            e.error_count(),
        )
        return func.HttpResponse(
            body=json.dumps({"error": "Request validation failed.", "details": e.errors()}),
            status_code=400,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Step 3: Validate file presence
    # -------------------------------------------------------------------------
    if "file" not in form:
        return func.HttpResponse(
            body=json.dumps({"error": "Missing 'file' field in multipart body."}),
            status_code=400,
            mimetype="application/json",
        )

    file_field = form["file"]
    file_bytes: bytes = file_field["value"]
    file_content_type: str = file_field["content_type"].split(";")[0].strip().lower()

    # -------------------------------------------------------------------------
    # Step 4: Validate file type
    # -------------------------------------------------------------------------
    if file_content_type not in _ALLOWED_TYPES:
        logging.warning(
            "upload-ecg: Invalid file type '%s' | bundle_id=%s",
            file_content_type,
            bundle_id,
        )
        return func.HttpResponse(
            body=json.dumps({
                "error": (
                    f"Unsupported file type '{file_content_type}'. "
                    "Accepted: image/jpeg, image/png, application/pdf."
                ),
            }),
            status_code=400,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Step 5: Validate file size (max 10 MB)
    # -------------------------------------------------------------------------
    if len(file_bytes) > _MAX_FILE_BYTES:
        logging.warning(
            "upload-ecg: File too large (%d bytes) | bundle_id=%s",
            len(file_bytes),
            bundle_id,
        )
        return func.HttpResponse(
            body=json.dumps({
                "error": (
                    f"File size {len(file_bytes) // (1024 * 1024)}MB exceeds the 10MB limit."
                ),
            }),
            status_code=400,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Step 6: Derive extension + build unique blob path (Sprint 3.2)
    # -------------------------------------------------------------------------
    ext: str = _ALLOWED_TYPES[file_content_type]

    # Sprint 3.2: millisecond-epoch filename prevents overwrites between uploads.
    # Each EcgRecord now has its own uniquely addressable blob.
    epoch_ms: int = int(time.time() * 1000)
    blob_file: str = f"ecg-{epoch_ms}.{ext}"
    blob_name: str = f"{hospital_id}/{bundle_id}/{blob_file}"

    # -------------------------------------------------------------------------
    # Step 7–8: Upload to Blob Storage
    # -------------------------------------------------------------------------
    try:
        blob_client = ecg_container_client.get_blob_client(blob_name)
        blob_client.upload_blob(
            data=file_bytes,
            overwrite=False,
            content_settings=None,
        )
        logging.info(
            "upload-ecg: Blob uploaded | container=%s | blob=%s",
            _ECG_CONTAINER_NAME,
            blob_name,
        )
    except Exception:
        logging.exception(
            "upload-ecg: Blob upload FAILED | bundle_id=%s | blob=%s",
            bundle_id,
            blob_name,
        )
        return func.HttpResponse(
            body=json.dumps({"error": "ECG blob upload failed. Please retry."}),
            status_code=500,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Step 9: Construct blob URL
    # -------------------------------------------------------------------------
    blob_url: str = (
        f"{_BLOB_ENDPOINT.rstrip('/')}/{_ECG_CONTAINER_NAME}/{blob_name}"
    )

    # -------------------------------------------------------------------------
    # Step 10: Determine label + build EcgRecord dict (Sprint 3.2: includes blobKey)
    # -------------------------------------------------------------------------
    now_utc = datetime.now(timezone.utc)
    label: str = "Initial"  # default — overridden below if bundle exists with records

    ecg_record_dict: dict = {
        "url": blob_url,
        "timestamp": now_utc.isoformat(),
        "label": label,
        "rhythmInterpretation": rhythm,
        "blobKey": blob_file,  # Sprint 3.2: unique filename for later retrieval
    }

    # -------------------------------------------------------------------------
    # Step 11: Append EcgRecord to Cosmos bundle (best-effort — non-blocking)
    # -------------------------------------------------------------------------
    # bundle_doc_for_broadcast: set inside try on success so the SignalR step
    # can send the full updated bundle to the hospital (instead of partial metadata).
    # Stays None for pre-submit uploads (ResourceNotFoundError path).
    bundle_doc_for_broadcast: dict | None = None

    try:
        bundle_doc: dict = cosmos_container.read_item(
            item=bundle_id,
            partition_key=hospital_id,
        )
        existing_records: list = bundle_doc.get("ecgRecords", [])

        # Determine label based on existing record count
        if len(existing_records) == 0:
            label = "Initial"
        else:
            label = f"Update {now_utc.strftime('%H:%M')}"

        ecg_record_dict["label"] = label

        # Append via patch if ecgRecords array already exists in document,
        # otherwise initialize and upsert (handles old document formats)
        if "ecgRecords" in bundle_doc:
            cosmos_container.patch_item(
                item=bundle_id,
                partition_key=hospital_id,
                patch_operations=[
                    {"op": "add", "path": "/ecgRecords/-", "value": ecg_record_dict}
                ],
            )
            logging.info(
                "upload-ecg: EcgRecord appended via patch | bundle_id=%s | label=%s | blobKey=%s",
                bundle_id,
                label,
                blob_file,
            )
        else:
            # Old document format — initialize ecgRecords
            bundle_doc["ecgRecords"] = [ecg_record_dict]
            cosmos_container.upsert_item(body=bundle_doc)
            logging.info(
                "upload-ecg: ecgRecords initialized on legacy bundle | bundle_id=%s",
                bundle_id,
            )

        # Build the full updated bundle for the hospital broadcast.
        # Use the in-memory bundle_doc + the new ecg_record_dict appended —
        # no extra Cosmos read needed. The hospital HANDOFF_UPDATE reducer
        # expects a full FHIR bundle with bundle.id set (not partial metadata).
        bundle_doc_for_broadcast = {
            **bundle_doc,
            "ecgRecords": existing_records + [ecg_record_dict],
        }

    except ResourceNotFoundError:
        # Bundle not yet submitted to DB — the medic uploaded ECG before form submit.
        # Return the blob_url anyway; it will be included in ecgRecords when they
        # eventually call buildFHIRBundle and submit POST /api/ems-to-db.
        # hospital broadcast is skipped (nothing in liveQueue to update yet).
        logging.info(
            "upload-ecg: Bundle not yet in Cosmos (pre-submit ECG) | bundle_id=%s",
            bundle_id,
        )
    except Exception:
        logging.exception(
            "upload-ecg: Cosmos patch FAILED (non-fatal — blob is safe) | bundle_id=%s",
            bundle_id,
        )

    # -------------------------------------------------------------------------
    # Step 12–13: Dual SignalR broadcast (best-effort)
    # -------------------------------------------------------------------------
    try:
        signalr_message_list = [
            {
                "userId": bundle_id,
                "target": "emsHandoffUpdate",
                "arguments": [{
                    "action": "ecg_uploaded",
                    "bundleId": bundle_id,
                    "label": label,
                    "ecgRecord": ecg_record_dict,
                }],
            },
        ]
        # Send the FULL updated bundle to the hospital so usePatientQueue can
        # immediately update liveQueue[bundleId] and the EcgViewer History Rail
        # shows the new ECG without waiting for the next section save.
        # Skipped when bundle_doc_for_broadcast is None (pre-submit ECG path).
        if bundle_doc_for_broadcast is not None:
            signalr_message_list.append({
                "userId": hospital_id,
                "target": "handoffUpdate",
                "arguments": [bundle_doc_for_broadcast],
            })
        signalr_messages.set(json.dumps(signalr_message_list))
        logging.info(
            "upload-ecg: Dual SignalR broadcast sent | bundle_id=%s | label=%s",
            bundle_id,
            label,
        )
    except Exception:
        logging.exception(
            "upload-ecg: SignalR broadcast FAILED (non-fatal) | bundle_id=%s",
            bundle_id,
        )

    # -------------------------------------------------------------------------
    # Step 14: Return 200
    # -------------------------------------------------------------------------
    return func.HttpResponse(
        body=json.dumps({
            "blob_url": blob_url,
            "bundle_id": bundle_id,
            "label": label,
            "blobKey": blob_file,  # Returned so frontend can carry blobKey in local state
        }),
        status_code=200,
        mimetype="application/json",
    )


# =============================================================================
# Route: GET /api/get-ecg
# =============================================================================


@bp.route(route="get-ecg", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def get_ecg(req: func.HttpRequest) -> func.HttpResponse:
    """
    HTTP-Triggered Azure Function: ECG Image Retrieval.

    Sprint 3.2: Uses blobKey from the stored EcgRecord to reconstruct the
    exact blob path. Falls back to the legacy {hospitalId}/{bundleId}.{ext}
    probe pattern for records created before Sprint 3.2.
    """

    # -------------------------------------------------------------------------
    # Step 1: Parse + validate query params
    # -------------------------------------------------------------------------
    bundle_id: str = req.params.get("bundleId", "").strip()
    hospital_id: str = req.params.get("hospitalId", "").strip()
    index_str: str = req.params.get("index", "-1").strip()

    if not bundle_id:
        return func.HttpResponse(
            body=json.dumps({"error": "Missing required query param: bundleId"}),
            status_code=400,
            mimetype="application/json",
        )

    if hospital_id not in _VALID_HOSPITALS:
        return func.HttpResponse(
            body=json.dumps({
                "error": f"Invalid hospitalId '{hospital_id}'. "
                         "Must be one of: HUP-PAV, HUP-PRESBY, HUP-CEDAR."
            }),
            status_code=400,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Step 2: Parse index param
    # -------------------------------------------------------------------------
    try:
        index: int = int(index_str)
    except ValueError:
        index = -1

    # -------------------------------------------------------------------------
    # Step 3: Read bundle from Cosmos to get ecgRecords[index]
    # -------------------------------------------------------------------------
    try:
        bundle_doc: dict = cosmos_container.read_item(
            item=bundle_id,
            partition_key=hospital_id,
        )
    except ResourceNotFoundError:
        return func.HttpResponse(
            body=json.dumps({
                "error": "Bundle not found.",
                "bundle_id": bundle_id,
            }),
            status_code=404,
            mimetype="application/json",
        )

    ecg_records: list = bundle_doc.get("ecgRecords", [])
    if not ecg_records:
        return func.HttpResponse(
            body=json.dumps({"error": "No ECG records found for this bundle."}),
            status_code=404,
            mimetype="application/json",
        )

    # Resolve index (supports negative indexing: -1 = last)
    resolved_index: int = index if index >= 0 else len(ecg_records) + index
    if resolved_index < 0 or resolved_index >= len(ecg_records):
        return func.HttpResponse(
            body=json.dumps({
                "error": f"ECG index {index} out of range (0–{len(ecg_records) - 1})."
            }),
            status_code=404,
            mimetype="application/json",
        )

    record = ecg_records[resolved_index]

    # -------------------------------------------------------------------------
    # Step 4: Resolve blob path — blobKey (Sprint 3.2) or legacy probe
    # -------------------------------------------------------------------------
    blob_key: str | None = record.get("blobKey")
    content: bytes | None = None
    response_content_type: str = "image/jpeg"

    if blob_key:
        # Sprint 3.2: use stored blobKey to reconstruct the unique path
        blob_path = f"{hospital_id}/{bundle_id}/{blob_key}"
        try:
            blob_client = ecg_container_client.get_blob_client(blob_path)
            content = blob_client.download_blob().readall()
            # Derive content type from extension in blobKey
            if blob_key.endswith(".png"):
                response_content_type = "image/png"
            elif blob_key.endswith(".pdf"):
                response_content_type = "application/pdf"
            else:
                response_content_type = "image/jpeg"
        except ResourceNotFoundError:
            logging.warning(
                "get-ecg: Blob not found at blobKey path | bundle_id=%s | path=%s",
                bundle_id,
                blob_path,
            )
            content = None
        except Exception:
            logging.exception(
                "get-ecg: Blob read error | bundle_id=%s | blob=%s",
                bundle_id,
                blob_path,
            )
            content = None
    else:
        # Legacy fallback: probe {hospitalId}/{bundleId}.{ext} (pre-Sprint-3.2 blobs)
        ext_content_types: list[tuple[str, str]] = [
            ("jpg", "image/jpeg"),
            ("jpeg", "image/jpeg"),
            ("png", "image/png"),
            ("pdf", "application/pdf"),
        ]
        for ext, ct in ext_content_types:
            probe_name = f"{hospital_id}/{bundle_id}.{ext}"
            try:
                blob_client = ecg_container_client.get_blob_client(probe_name)
                content = blob_client.download_blob().readall()
                response_content_type = ct
                break
            except ResourceNotFoundError:
                continue
            except Exception:
                logging.exception(
                    "get-ecg: Blob read error (legacy probe) | bundle_id=%s | blob=%s",
                    bundle_id,
                    probe_name,
                )
                break

    # -------------------------------------------------------------------------
    # Step 5–6: Return blob bytes or 404
    # -------------------------------------------------------------------------
    if content is None:
        return func.HttpResponse(
            body=json.dumps({"error": "ECG not found in storage."}),
            status_code=404,
            mimetype="application/json",
        )

    logging.info(
        "get-ecg: retrieved | bundle_id=%s | index=%d",
        bundle_id,
        resolved_index,
    )

    return func.HttpResponse(
        body=content,
        status_code=200,
        mimetype=response_content_type,
    )


# =============================================================================
# Route: DELETE /api/delete-ecg
# =============================================================================


@bp.route(route="delete-ecg", methods=["DELETE"], auth_level=func.AuthLevel.ANONYMOUS)
def delete_ecg(req: func.HttpRequest) -> func.HttpResponse:
    """
    HTTP-Triggered Azure Function: ECG Record Deletion.

    Removes a specific ECG from the serial list:
      1. Validate params
      2. Read bundle from Cosmos → get ecgRecords[index]
      3. Delete blob using blobKey (Sprint 3.2) or legacy path fallback
      4. Remove ecgRecords[index] from array via patch_item
      5. Re-label remaining records (Initial stays, Updates renumber)
      6. SignalR broadcast handled by Change Feed → streaming_bp (no explicit call needed)
      7. Return 200 { "bundleId": bundleId, "remainingCount": N }

    Sprint 3.2 addition. Called from EcgViewer "🗑️ Confirm Delete?" flow.
    """

    # -------------------------------------------------------------------------
    # Step 1: Parse + validate query params
    # -------------------------------------------------------------------------
    bundle_id: str = req.params.get("bundleId", "").strip()
    hospital_id: str = req.params.get("hospitalId", "").strip()
    index_str: str = req.params.get("index", "").strip()

    if not bundle_id or not hospital_id or not index_str:
        return func.HttpResponse(
            json.dumps({"error": "bundleId, hospitalId, and index are required"}),
            status_code=400,
            mimetype="application/json",
        )

    if hospital_id not in _VALID_HOSPITALS:
        return func.HttpResponse(
            json.dumps({
                "error": f"Invalid hospitalId '{hospital_id}'. "
                         "Must be one of: HUP-PAV, HUP-PRESBY, HUP-CEDAR."
            }),
            status_code=400,
            mimetype="application/json",
        )

    try:
        idx = int(index_str)
    except ValueError:
        return func.HttpResponse(
            json.dumps({"error": "index must be an integer"}),
            status_code=400,
            mimetype="application/json",
        )

    # -------------------------------------------------------------------------
    # Step 2: Read bundle from Cosmos
    # -------------------------------------------------------------------------
    try:
        bundle_doc: dict = cosmos_container.read_item(
            item=bundle_id,
            partition_key=hospital_id,
        )
    except ResourceNotFoundError:
        return func.HttpResponse(
            json.dumps({"error": "Bundle not found"}),
            status_code=404,
            mimetype="application/json",
        )

    ecg_records: list = bundle_doc.get("ecgRecords", [])
    if idx < 0 or idx >= len(ecg_records):
        return func.HttpResponse(
            json.dumps({"error": f"Index {idx} out of range (0–{len(ecg_records) - 1})"}),
            status_code=400,
            mimetype="application/json",
        )

    record_to_delete: dict = ecg_records[idx]

    # -------------------------------------------------------------------------
    # Step 3: Delete blob (best-effort)
    # -------------------------------------------------------------------------
    blob_key: str | None = record_to_delete.get("blobKey")

    if blob_key:
        # Sprint 3.2: unique blob path
        blob_path = f"{hospital_id}/{bundle_id}/{blob_key}"
    else:
        # Legacy fallback: probe {hospitalId}/{bundleId}.{ext}
        blob_path = None
        for ext in [".jpg", ".jpeg", ".png", ".pdf"]:
            candidate = f"{hospital_id}/{bundle_id}{ext}"
            try:
                ecg_container_client.get_blob_client(candidate).get_blob_properties()
                blob_path = candidate
                break
            except ResourceNotFoundError:
                pass

    if blob_path:
        try:
            ecg_container_client.get_blob_client(blob_path).delete_blob()
            logging.info(
                "delete-ecg: Blob deleted | bundle_id=%s | path=%s",
                bundle_id,
                blob_path,
            )
        except ResourceNotFoundError:
            logging.warning(
                "delete-ecg: Blob already gone | bundle_id=%s | path=%s",
                bundle_id,
                blob_path,
            )

    # -------------------------------------------------------------------------
    # Step 4: Remove record from array
    # -------------------------------------------------------------------------
    updated_records: list = [r for i, r in enumerate(ecg_records) if i != idx]

    # -------------------------------------------------------------------------
    # Step 5: Re-label — index 0 stays "Initial", rest become "Update 1", "Update 2", etc.
    # -------------------------------------------------------------------------
    for i, rec in enumerate(updated_records):
        rec["label"] = "Initial" if i == 0 else f"Update {i}"

    # -------------------------------------------------------------------------
    # Step 6: Cosmos patch — replace entire ecgRecords array
    # -------------------------------------------------------------------------
    cosmos_container.patch_item(
        item=bundle_id,
        partition_key=hospital_id,
        patch_operations=[
            {"op": "replace", "path": "/ecgRecords", "value": updated_records}
        ],
    )
    logging.info(
        "delete-ecg: ECG %d removed | bundle_id=%s | remaining=%d",
        idx,
        bundle_id,
        len(updated_records),
    )

    # -------------------------------------------------------------------------
    # Step 7: Return 200
    # Note: SignalR broadcast to hospital is handled by Cosmos Change Feed →
    # streaming_bp pattern — no explicit broadcast needed here.
    # -------------------------------------------------------------------------
    return func.HttpResponse(
        json.dumps({"bundleId": bundle_id, "remainingCount": len(updated_records)}),
        status_code=200,
        mimetype="application/json",
    )
