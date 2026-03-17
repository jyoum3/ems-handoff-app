# Validation Report: EMS Arrival & Archival
**Date:** 2026-03-06
**Engineer:** James Youm
**System:** Azure Functions (Python V2) + Modular Blueprint Archival

---

## 1. Test Environment
* **Runtime:** Azure Functions Core Tools (Local Host)
* **Language:** Python 3.x (uv managed)
* **Validation Engine:** Pydantic v2 (ArrivalRequest Model)
* **Persistence:** Azure Cosmos DB (Hot Partition)
* **Archival:** Azure Blob Storage (Cold Archive - `handoff-archive`)
* **Authentication:** DefaultAzureCredential (Local Service Principal)

---

## 2. Executive Summary
The `ems-arrival` function was successfully validated using the **"Move-then-Delete"** data integrity pattern. The system correctly identifies valid archival requests, transfers the PHI bundle to long-term storage, and purges the active record from the hot partition only after a confirmed write. Security was confirmed via secretless authentication and zero-exposure logging.

---

## 3. Test Cases and Results

### Test 1: Clean Archival (Standard Success)
* **ID:** `EMS-HANDOFF-CLEAN-TEST-V1`
* **Goal:** Verify the full lifecycle of a valid record moving from Cosmos DB to Blob Storage.
* **Input:** `{ "bundle_id": "EMS-HANDOFF-CLEAN-TEST-V1", "hospitalId": "HUP-PAV" }`
* **Result:** `200 OK`
* **Storage Verification:** * **Blob Storage:** JSON successfully written to `/handoff-archive/HUP-PAV/EMS-HANDOFF-CLEAN-TEST-V1.json`.
    * **Cosmos DB:** Document successfully deleted from the `HUP-PAV` partition.

### Test 2: Unknown Patient Archival (Medical Flexibility)
* **ID:** `EMS-HANDOFF-UNKNOWN-TEST-V1`
* **Goal:** Confirm that bundles containing "Unknown" demographics (from Phase 1) can be successfully archived.
* **Input:** `{ "bundle_id": "EMS-HANDOFF-UNKNOWN-TEST-V1", "hospitalId": "HUP-PRESBY" }`
* **Result:** `200 OK`
* **Architectural Note:** Validated that the Move-then-Delete logic is agnostic to FHIR content as long as the record exists in the hot partition.

### Test 3: Idempotency Check (Retry Logic)
* **Goal:** Ensure a repeated archival request handles the "missing" resource gracefully.
* **Result:** `404 Not Found` (Expected Behavior)
* **Observation:** After a successful archival, a second attempt results in a 404. This proves the record was purged from the "Hot" partition, preventing accidental duplicate deletions while allowing the client to know the work is finished.

---

## 4. Observation & Learning
* **Write-Before-Delete Gate:** Verified via terminal logs that the Blob upload is confirmed by Azure (201 Created) before the Cosmos delete (204 No Content) is initiated, preventing PHI loss.
* **Data Isolation:** Confirmed that the `hospitalId` effectively partitions both the database and the archive folders (`HUP-PAV` vs `HUP-PRESBY`), maintaining strict multi-tenancy.
* **Stateless Persistence:** Successfully simulated the "Persistent Handshake" where the function relies on the IDs returned during ingestion to locate the record for arrival later.
