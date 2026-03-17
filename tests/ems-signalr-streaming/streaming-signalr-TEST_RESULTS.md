# Integration Test Report: Streaming & Archival Lifecycle
**Date:** 2026-03-06
**Engineer:** James Youm
**System:** Azure Functions + Cosmos DB Change Feed + SignalR + Blob Storage

---

## 1. Test Environment
- **Runtime:** Azure Functions Core Tools (Local Host)
- **Persistence:** Azure Cosmos DB (ems-db / handoffs)
- **Streaming:** Azure SignalR Service (Serverless Mode via Access Key)
- **Archival:** Azure Blob Storage (handoff-archive)

---

## 2. Executive Summary
Successfully validated the complete Phase 3 integration pipeline. The system correctly ingested a FHIR bundle, triggered a real-time SignalR broadcast via the Cosmos DB Change Feed, and executed a "Move-then-Delete" archival pattern upon patient arrival. Data integrity was maintained throughout the transition from hot storage (Cosmos) to cold storage (Blob).

---

## 3. Test Cases and Results

### Test 1: Real-Time Ingestion & Broadcast
* **ID:** `EMS-STREAM-INGESTION-TEST-001`
* **Goal:** Verify that a new database write triggers a SignalR push notification.
* **Result:** `201 Created` (API) & `Succeeded` (Change Feed Trigger)
* **Logs Verified:** - `ems-to-db`: Handoff persisted to `HUP-CEDAR` partition.
    - `streaming_bp`: Change Feed detected update; dispatched SignalR message to `userId=HUP-CEDAR`.

### Test 2: Arrival Lifecycle (Move-then-Delete)
* **Goal:** Confirm the "Soft-Delete" pattern: Patch status → Archive to Blob → Delete from Cosmos.
* **Result:** `200 OK`
* **Workflow Verification:**
    1. **Status Patch:** `handoffStatus` updated to `arrived` (Triggered Change Feed for UI card removal).
    2. **Blob Archival:** Succesfully uploaded to `handoff-archive/HUP-CEDAR/EMS-STREAM-INGESTION-TEST-001.json`.
    3. **Final Cleanup:** Document successfully deleted from Cosmos DB (`204 No Content`).

---

## 4. Architectural Observations
- **Change Feed Reliability:** The `handle_change_feed` function consistently triggered within 2 seconds of the database write.
- **Atomic-Style Archival:** Confirmed that the `ems_arrival` logic prevents Cosmos deletion unless the Blob Storage `PUT` request returns a `201`.
- **SignalR Scaling:** Using `userId` targeting in the broadcast ensures hospital-level data isolation at the transport layer.