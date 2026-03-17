"""
blueprints/negotiate_bp.py — Azure SignalR Service Negotiate Endpoint
======================================================================
Route:   GET /api/negotiate?hospitalId={hospitalId}
Purpose: Performs the SignalR handshake for hospital dashboard clients.
         Returns a short-lived access token and the Azure SignalR Service
         WebSocket URL that the browser's SignalR client uses to establish
         a persistent, real-time connection.

The SignalR Connection Lifecycle:
    ┌───────────────────────────────────────────────────────────────────┐
    │  1. Dashboard browser loads, reads its hospitalId config          │
    │  2. GET /api/negotiate?hospitalId=HUP-PAV                         │
    │  3. [This function] validates hospitalId → issues signed token    │
    │  4. Returns: { "url": "wss://...", "accessToken": "eyJ..." }      │
    │  5. Browser SignalR client connects to SignalR Service directly   │
    │     using the returned URL + token (serverless mode)              │
    │  6. Connection established → client is now in userId=HUP-PAV     │
    │  7. Cosmos Change Feed fires → streaming_bp broadcasts to        │
    │     userId=HUP-PAV → dashboard receives real-time push           │
    └───────────────────────────────────────────────────────────────────┘

Serverless Mode vs. Default Mode:
    In Azure SignalR Service "Default Mode", Azure Functions act as the
    WebSocket hub — every message passes through the Function App, which
    adds latency and burns function execution time for idle connections.
    In "Serverless Mode" (our architecture), clients connect DIRECTLY to
    Azure SignalR Service. Functions only push messages to SignalR Service
    via its REST API (the output binding in streaming_bp.py). The Function
    App is never in the WebSocket hot path — it only handles:
      a) The negotiate handshake (this file) — once per client connection
      b) Change Feed broadcasts (streaming_bp.py) — once per DB write

userId = hospitalId — The Isolation Key:
    The `signalRConnectionInfo` input binding issues a JWT access token
    with `userId` embedded. This userId is set to the `hospitalId` query
    parameter (via the `{query.hospitalId}` binding expression).

    When streaming_bp.py broadcasts a document, it targets `userId=HUP-PAV`.
    Azure SignalR Service delivers the WebSocket push to ALL active
    connections whose token was issued with userId=HUP-PAV — and ONLY
    those connections. This is data isolation enforced at the SignalR
    Service transport layer, not at the UI level.

    A HUP-CEDAR dashboard session with userId=HUP-CEDAR will NEVER receive
    a message targeted at userId=HUP-PAV, regardless of what the browser
    JavaScript does. The access token is the enforcement boundary.

Security Design:
    - The `hospitalId` query parameter is validated against the explicit
      allowlist BEFORE the connection info is returned to the caller.
    - The `signalRConnectionInfo` binding uses `AzureSignalRConnectionString`
      for auth — identity-based, no hardcoded keys.
    - The issued token is short-lived (default: 1 hour). If a dashboard
      session persists beyond token expiry, the client should call
      /api/negotiate again to refresh the connection.
"""

import json
import logging

import azure.functions as func

# =============================================================================
# Blueprint Instance
# =============================================================================

bp = func.Blueprint()

# =============================================================================
# Hospital Allowlist — Single Source of Truth for Negotiate Validation
# =============================================================================
#
# Duplicating the Literal["HUP-PAV", "HUP-PRESBY", "HUP-CEDAR"] constraint
# here as a set for O(1) membership tests. The Pydantic models enforce this
# on the data plane; this set enforces it on the connection plane.
# Both lists must be kept in sync if new hospitals are added.

_VALID_HOSPITAL_IDS: frozenset[str] = frozenset(
    {"HUP-PAV", "HUP-PRESBY", "HUP-CEDAR"}
)

_HUB_NAME = "EmsHandoff"


# =============================================================================
# Route: GET /api/negotiate
# =============================================================================


@bp.route(route="negotiate", methods=["GET", "POST"])
@bp.generic_input_binding(
    arg_name="connection_info",
    type="signalRConnectionInfo",
    hub_name=_HUB_NAME,
    # `{query.hospitalId}` is an Azure Functions binding expression.
    # The Functions host resolves this at runtime by reading the
    # `hospitalId` query parameter from the HTTP request and embedding
    # it as the `userId` claim in the signed SignalR access token.
    #
    # Effect: The issued JWT token has sub = "HUP-PAV" (or whichever
    # hospitalId was requested). When streaming_bp.py targets
    # userId="HUP-PAV", SignalR Service matches on this sub claim and
    # delivers the message to all connections with that userId.
    #
    # NOTE: The binding expression resolves BEFORE the function body
    # executes. If hospitalId is missing or invalid, the binding will
    # still issue a token (with an empty or invalid userId). Our
    # validation below ensures we NEVER return that token to the caller
    # for an invalid hospitalId — the 400 response is returned instead.
    user_id="{query.hospitalId}",
    # `connection` references the `AzureSignalRConnectionString` app setting.
    # Format for local dev (Service Principal):
    #   Endpoint=https://...signalr.net;AuthType=azure.app;ClientId=...;ClientSecret=...;TenantId=...
    # Format for Azure deployment (Managed Identity):
    #   Endpoint=https://...signalr.net;AuthType=azure.msi
    connection="AzureSignalRConnectionString",
)
def negotiate(
    req: func.HttpRequest,
    connection_info: str,
) -> func.HttpResponse:
    """
    HTTP-Triggered Azure Function: SignalR Negotiate Handshake.

    Issues a short-lived Azure SignalR Service access token scoped to the
    requesting hospital's userId. The browser SignalR client uses the
    returned URL and token to establish a direct WebSocket connection to
    Azure SignalR Service (serverless mode).

    ┌──────────────────────────────────────────────────────────────────────┐
    │  REQUEST                                                             │
    │  Method:  GET (POST also accepted for compatibility)                 │
    │  Route:   /api/negotiate                                             │
    │  Query:   hospitalId=HUP-PAV  (or HUP-PRESBY, HUP-CEDAR)           │
    └──────────────────────────────────────────────────────────────────────┘

    ┌──────────────────────────────────────────────────────────────────────┐
    │  RESPONSES                                                           │
    │  200 OK          { "url": "wss://...", "accessToken": "eyJ..." }    │
    │                  Client uses these to connect to SignalR Service.   │
    │  400 Bad Request Missing or invalid hospitalId.                     │
    │                  No token is issued or returned.                    │
    └──────────────────────────────────────────────────────────────────────┘
    """
    # -------------------------------------------------------------------------
    # Validate hospitalId — Gate before returning connection info
    # -------------------------------------------------------------------------
    # Even though the binding expression already embedded hospitalId in the
    # token, we MUST validate here before returning `connection_info` to
    # the caller. If we skip this check and return the token for an invalid
    # hospitalId (e.g., "ROGUE-HOSPITAL"), that caller would hold a token
    # scoped to an arbitrary userId — a security concern even if that userId
    # has no active broadcast targets.
    #
    # By validating first and returning 400 for any non-allowlisted value,
    # we ensure tokens are ONLY issued for the three known hospital IDs.
    hospital_id: str = req.params.get("hospitalId", "")

    if not hospital_id:
        logging.warning("negotiate: Missing hospitalId query parameter.")
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
            "negotiate: Invalid hospitalId rejected | hospitalId=%s", hospital_id
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
    # Return SignalR Connection Info
    # -------------------------------------------------------------------------
    # `connection_info` is a JSON string produced by the SignalRConnectionInfo
    # input binding. It contains:
    #   {
    #       "url":         "https://hospital-facing-signalr.service.signalr.net/...",
    #       "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
    #   }
    #
    # The `url` points directly to Azure SignalR Service (serverless mode).
    # The `accessToken` is a short-lived JWT signed by the SignalR Service
    # access key, with `userId` set to the validated hospitalId.
    #
    # The browser's `@microsoft/signalr` client uses these two values to
    # establish the WebSocket connection:
    #   const connection = new signalR.HubConnectionBuilder()
    #       .withUrl(connectionInfo.url, {
    #           accessTokenFactory: () => connectionInfo.accessToken
    #       })
    #       .build();
    #   await connection.start();
    #
    # The CORS headers below are required because the dashboard frontend
    # (hosted on Azure Static Web Apps at a different origin) will call
    # this endpoint from the browser. Without CORS, the browser will block
    # the preflight request.
    logging.info(
        "negotiate: Issuing SignalR connection token | hospitalId=%s", hospital_id
    )

    return func.HttpResponse(
        body=connection_info,
        status_code=200,
        mimetype="application/json",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": "true",
        },
    )
