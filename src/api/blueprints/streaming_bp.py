"""
blueprints/streaming_bp.py — Cosmos DB Change Feed → SignalR Broadcast
=======================================================================
Route:   (No HTTP route — this is a Cosmos DB Change Feed trigger)
Purpose: Listens for new and modified documents in the Cosmos DB
         `handoffs` container and broadcasts each change to the
         appropriate hospital's SignalR group in real time.

Why the Change Feed Is the Right Architecture:
    The Cosmos DB Change Feed is a persistent, ordered log of every
    INSERT and UPDATE operation on a Cosmos DB container. Instead of
    the dashboard polling the database every N seconds (which adds
    latency, wastes RU/s, and creates thundering-herd risk at scale),
    the Change Feed trigger makes the database itself the event source.
    Every write becomes an automatic push notification.

    ┌──────────────────────────────────────────────────────────────────┐
    │  ems-to-db writes "inbound" bundle                               │
    │    → Cosmos DB Change Feed fires                                 │
    │    → handle_change_feed() receives the new document             │
    │    → Extracts hospitalId → "HUP-PAV"                            │
    │    → Broadcasts to SignalR userId="HUP-PAV"                     │
    │    → All HUP-PAV dashboard sessions receive the new card        │
    │                                                                  │
    │  ems-arrival patches handoffStatus → "arrived"                   │
    │    → Cosmos DB Change Feed fires again (update event)            │
    │    → handle_change_feed() receives the updated document         │
    │    → Broadcasts the updated document to userId="HUP-PAV"        │
    │    → Dashboard sees handoffStatus="arrived" → removes card      │
    └──────────────────────────────────────────────────────────────────┘

Data Isolation Guarantee:
    Each document carries a `hospitalId` field (the Cosmos partition key).
    This function extracts that field and sets it as the SignalR `userId`
    target — ensuring that HUP-PAV documents ONLY reach HUP-PAV dashboard
    sessions and never cross hospital boundaries. Isolation is enforced
    at the transport layer, not just the UI.

Lease Container:
    The Change Feed uses a `leases` Cosmos DB container to track which
    documents each function instance has already processed. This prevents
    duplicate processing when the Function App scales out across multiple
    instances, and ensures the trigger resumes from the correct offset
    after a cold start — not from the beginning of history.

Connection (Identity-Based):
    The trigger uses the `EmsDb` connection prefix, which maps to the
    `EmsDb__accountEndpoint` env var (and SP credential env vars for
    local dev). This aligns with DefaultAzureCredential semantics —
    no connection string key is hardcoded.

SignalR Output Binding (serverless mode):
    The `signalR` output binding targets Azure SignalR Service directly.
    In serverless mode, Functions do not act as the WebSocket hub — they
    only push messages to SignalR Service via its REST API. The binding
    handles token acquisition and the REST call automatically using the
    `AzureSignalRConnectionString` setting.
"""

import json
import logging
from typing import Any

import azure.functions as func

# =============================================================================
# Blueprint Instance
# =============================================================================
#
# A thin Blueprint container that registers the Change Feed trigger.
# Imported and registered by function_app.py — zero app-level state here.

bp = func.Blueprint()

# =============================================================================
# Constants
# =============================================================================

_HUB_NAME = "EmsHandoff"

# The SignalR target name is the JavaScript method name that dashboard clients
# subscribe to via: connection.on("handoffUpdate", (document) => { ... })
# This string is the contract between the backend broadcast and the frontend
# event handler. Keep it in sync with the dashboard SignalR client code.
_SIGNALR_TARGET = "handoffUpdate"


# =============================================================================
# Trigger: Cosmos DB Change Feed → handoffs container
# =============================================================================


@bp.cosmos_db_trigger(
    arg_name="documents",
    database_name="ems-db",
    container_name="handoffs",
    # `connection` is a SETTING NAME PREFIX, not the value itself.
    # The Azure Functions host resolves credentials from the set of env vars
    # that start with this prefix:
    #   EmsDb__accountEndpoint → the Cosmos DB account URI
    #   EmsDb__credential      → "clientsecret" (for SP-based local dev)
    #   EmsDb__clientId        → Service Principal client ID
    #   EmsDb__clientSecret    → Service Principal client secret
    #   EmsDb__tenantId        → Azure AD tenant ID
    # In Azure with Managed Identity: only EmsDb__accountEndpoint is needed.
    # This avoids any connection string key — fully identity-based.
    connection="EmsDb",
    lease_container_name="leases",
    # If the `leases` container doesn't exist, the trigger creates it
    # automatically. In a fresh deployment, this saves a manual setup step.
    # The leases container stores one document per function instance,
    # tracking the Change Feed continuation token (the "read bookmark").
    create_lease_container_if_not_exists=True,
)
@bp.generic_output_binding(
    arg_name="signalr_messages",
    type="signalR",
    hub_name=_HUB_NAME,
    # `connection` references the `AzureSignalRConnectionString` app setting.
    # Format for local dev (Service Principal):
    #   Endpoint=https://...signalr.net;AuthType=azure.app;ClientId=...;ClientSecret=...;TenantId=...
    # Format for Azure deployment (Managed Identity):
    #   Endpoint=https://...signalr.net;AuthType=azure.msi
    connection="AzureSignalRConnectionString",
)
def handle_change_feed(
    documents: func.DocumentList,
    signalr_messages: func.Out[str],
) -> None:
    """
    Cosmos DB Change Feed Trigger — Real-Time EMS Dashboard Broadcaster.

    Fires on every INSERT or UPDATE to the `handoffs` container and
    broadcasts the changed document(s) to the correct hospital's SignalR
    group. This is the engine behind the zero-latency dashboard updates.

    Important: The Change Feed does NOT fire on DELETE operations.
    ──────────────────────────────────────────────────────────────
    Cosmos DB Change Feed emits events for INSERTs and UPDATEs only.
    The `ems-arrival` function handles this by performing a STATUS UPDATE
    (upsert with handoffStatus="arrived") BEFORE the hard delete. This
    update fires the Change Feed, which broadcasts the status change to
    the dashboard. The dashboard reacts to handoffStatus="arrived" by
    removing the patient card in real time. The subsequent hard delete is
    invisible to the Change Feed — but by that point, the UI has already
    responded to the status update event.

    Parameters:
    -----------
    documents : func.DocumentList
        A batch of one or more changed Cosmos DB documents. The batch size
        is governed by the Functions host; in most cases it will be a single
        document, but can be larger under high-write-throughput conditions.
        The function handles any batch size via the for-loop below.

    signalr_messages : func.Out[str]
        The SignalR output binding. Setting this value causes the Azure
        Functions host to POST the message to Azure SignalR Service via
        its REST API. The binding handles auth token acquisition from
        `AzureSignalRConnectionString` automatically.

        A single call to `signalr_messages.set(json.dumps(message))` sends
        one message. To broadcast multiple documents in one trigger
        invocation, we accumulate a list of messages and set the binding
        once with a JSON array.
    """
    if not documents:
        logging.warning("streaming_bp: Change Feed triggered with empty document list.")
        return

    outbound_messages = []

    for doc in documents:
        # Convert the Azure Functions DocumentList item to a plain dict.
        # `dict(doc)` produces the raw Cosmos DB document, including system
        # fields like `_rid`, `_ts`, etc., which the dashboard can ignore.
        document: dict[str, Any] = dict(doc)

        hospital_id: str = document.get("hospitalId", "")
        bundle_id: str = document.get("id", "UNKNOWN")
        handoff_status: str = document.get("handoffStatus", "inbound")

        if not hospital_id:
            # A document without a hospitalId should never exist in this
            # container (FHIRBundle enforces it at ingestion), but if one
            # somehow appears via a manual write or schema migration, we
            # skip it rather than broadcasting to an empty group.
            logging.warning(
                "streaming_bp: Document missing hospitalId — skipping broadcast | "
                "bundle_id=%s",
                bundle_id,
            )
            continue

        logging.info(
            "streaming_bp: Broadcasting change | bundle_id=%s | hospitalId=%s | "
            "handoffStatus=%s",
            bundle_id,
            hospital_id,
            handoff_status,
        )

        # ---------------------------------------------------------------------
        # Build the SignalR message envelope
        # ---------------------------------------------------------------------
        # The SignalR output binding expects a JSON object with:
        #
        #   userId   → The target recipient identifier. Set to hospitalId so
        #              only the dashboard sessions whose negotiate token was
        #              issued with userId=hospitalId receive this message.
        #              This is the data isolation enforcement at the transport
        #              layer — not just a UI filter.
        #
        #   target   → The JavaScript method name on the frontend SignalR
        #              client: connection.on("handoffUpdate", handler).
        #              This is the event name the dashboard subscribes to.
        #
        #   arguments → Array of arguments passed to the target method.
        #               We pass the full document as the first argument.
        #               The dashboard handler receives it as a plain JS object.
        #
        # Note on groupName vs. userId:
        #   We target by `userId` (not `groupName`) because the negotiate
        #   endpoint issues tokens with userId=hospitalId. All connections
        #   for a given hospital share the same userId, and SignalR Service
        #   fans out to all of them automatically. Using userId eliminates
        #   the need for explicit group join/leave management.
        message = {
            "userId": hospital_id,
            "target": _SIGNALR_TARGET,
            "arguments": [document],
        }
        outbound_messages.append(message)

    if not outbound_messages:
        return

    # The SignalR output binding accepts either a single message object
    # or a JSON array of message objects. Setting a JSON array allows the
    # binding to broadcast all messages in one REST call to SignalR Service.
    signalr_messages.set(json.dumps(outbound_messages))
    logging.info(
        "streaming_bp: Dispatched %d SignalR message(s) to Azure SignalR Service.",
        len(outbound_messages),
    )
