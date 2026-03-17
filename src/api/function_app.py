"""
function_app.py — Azure Functions App Entry Point
==================================================
This file is the sole entry point for the Azure Functions host.
Its responsibility is intentionally minimal:

  1. Instantiate the FunctionApp with the global HTTP auth level.
  2. Import each Blueprint module.
  3. Register each Blueprint with the app instance.

No route logic, SDK client initialization, or business logic lives here.
This file is the switchboard — it wires feature modules together without
knowing anything about what they do.

Blueprint Architecture:
    function_app.py  (entry point & registry)
         │
         ├──► ingestion_bp       → POST /api/ems-to-db
         ├──► arrival_bp         → POST /api/ems-arrival
         ├──► streaming_bp       → Cosmos DB Change Feed → SignalR broadcast
         ├──► negotiate_bp       → GET  /api/negotiate       (hospital SignalR token)
         ├──► ems_negotiate_bp   → GET  /api/ems-negotiate    (EMS SignalR token)
         ├──► active_handoffs_bp → GET  /api/active-handoffs  (dashboard hydration)
         ├──► fetch_archive_bp   → GET  /api/fetch-archive    (Blob PHI proxy)
         ├──► recover_handoff_bp → POST /api/recover-handoff
         ├──► comment_bp         → GET  /api/get-comments
         │                       → POST /api/update-comment
         ├──► chat_bp            → GET  /api/get-chat
         │                       → POST /api/send-chat
         ├──► divert_handoff_bp  → POST /api/divert-handoff
         └──► ecg_bp             → POST /api/upload-ecg
                                 → GET  /api/get-ecg
                                 → DELETE /api/delete-ecg

Adding a new feature requires exactly two lines:
  1. Create  blueprints/new_feature_bp.py  with a Blueprint instance.
  2. Add one import + one register_blueprint() call below.
No existing files need modification — Open/Closed Principle in practice.

Shared Clients:
    shared_clients.py is imported transitively by each blueprint. Because
    Python caches module imports, shared_clients initializes exactly once
    regardless of how many blueprints import it. The credential, Cosmos
    container clients, and BlobServiceClient are true singletons across
    the entire Function App.

Auth Level:
    func.AuthLevel.FUNCTION requires a valid `code` query parameter on all
    HTTP-triggered routes. This is enforced by the Azure Functions host and
    acts as a lightweight API key layer for inbound traffic from the PWAs.
    In production, this is combined with VNet integration and Azure API
    Management for defense in depth.
"""

import azure.functions as func

from blueprints.active_handoffs_bp import bp as active_handoffs_bp
from blueprints.arrival_bp import bp as arrival_bp
from blueprints.chat_bp import bp as chat_bp
from blueprints.comment_bp import bp as comment_bp
from blueprints.divert_handoff_bp import bp as divert_handoff_bp
from blueprints.ecg_bp import bp as ecg_bp
from blueprints.ems_negotiate_bp import bp as ems_negotiate_bp
from blueprints.fetch_archive_bp import bp as fetch_archive_bp
from blueprints.ingestion_bp import bp as ingestion_bp
from blueprints.negotiate_bp import bp as negotiate_bp
from blueprints.recover_handoff_bp import bp as recover_handoff_bp
from blueprints.streaming_bp import bp as streaming_bp

# FunctionApp — the root object the Azure Functions host binds to.
# http_auth_level applies as the default for routes that don't override it.
app = func.FunctionApp(http_auth_level=func.AuthLevel.FUNCTION)

# Blueprint Registration
# register_blueprint() attaches all route decorators defined in the blueprint
# module to this app instance. Order does not matter for HTTP triggers.
app.register_blueprint(ingestion_bp)        # POST /api/ems-to-db
app.register_blueprint(arrival_bp)          # POST /api/ems-arrival
app.register_blueprint(streaming_bp)        # Cosmos DB Change Feed → SignalR
app.register_blueprint(negotiate_bp)        # GET  /api/negotiate
app.register_blueprint(ems_negotiate_bp)    # GET  /api/ems-negotiate
app.register_blueprint(active_handoffs_bp)  # GET  /api/active-handoffs
app.register_blueprint(fetch_archive_bp)    # GET  /api/fetch-archive
app.register_blueprint(recover_handoff_bp)  # POST /api/recover-handoff
app.register_blueprint(comment_bp)          # GET  /api/get-comments  + POST /api/update-comment
app.register_blueprint(chat_bp)             # GET  /api/get-chat      + POST /api/send-chat
app.register_blueprint(divert_handoff_bp)   # POST /api/divert-handoff
app.register_blueprint(ecg_bp)              # POST /api/upload-ecg   + GET /api/get-ecg + DELETE /api/delete-ecg
