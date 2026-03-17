# Validation Report
**Date:** 2026-03-05
**Engineer:** James Youm
**System:** Azure Functions (Python V2) + Pydantic Bouncer

---

## 1. Test Environment
- **Runtime:** Azure Functions Core  Tools (Local Host)
- **Language:** Python 3.x (uv managed)
- **Validation Engine:** Pydantic v2
- **Persistence:** Azure Cosmos DB (ems-db / handoffs)
- **Authentication:** DefaultAzureCredentials (Local Service Principal)

---

## 2. Executive Summary
ems-to-db function has been succesfully validated against the "Bouncer" (models.py) - Correctly identifies and rejects malformed PHI while allowing "Unknown" demographics required for unidentified emergency patients. Idempotency was confirmed via repeated submissions of the same Bundle ID. 

## 3. Test Cases and Results

### Test 1: Clean Handoff (Standard Success)
* **ID:** `EMS-HANDOFF-CLEAN-TEST-V1`
* **Goal:** Verify that a standard FHIR bundle with all required fields is accepted. 
* **Payload:** `cleanhandoff-ems-to-db-v1.json`
* **Result:** `201 Created`
* **Cosmos DB Verification:** Document succesfully written to the `HUP-PAV` partition with all fields intact.

### Test 2: Unknown Patient (Medical Flexibility)
* **ID:** `EMS-HANDOFF-UNKNOWN-TEST-V1`
* **Goal:** Ensure "Unknown" strings for birthDate, name, and gender do not trigger rejection.
* **Payload:** `unknownhandoff-ems-to-db-v1.json`
* **Result:** `201 Created`
* **Architectural Note:** Confirmed the Pydantic model correctly handles `Optional[str] = Unknown` and `Literal` checks for these edge cases. 

### Test 3: Dirty Payload (Bouncer Enforcement)
* **Goal:** Verify the Bouncer rejects missing hospitalId and type-mismatched vital signs.
* **Payload:** `dirtyhandoff-ems-to-db-v1.json`
* **Result:** `400 Bad Request`
* **Error Details Received:**
    1. `hospitalId`: Field Required
    2. `entry.response.component.valueQuantity.value`: Input should be a valid number (received "CRITICAL" for hr).
* **Security Check:** Verified that no raw PHI was echoed in the error response. 

---

## 4. Observation & Learning
- **Warm-Start Optimization:** Module-level client initialization resulted in sub-50 ms response times for repeat tests.
- **Idempotency:** Using `upsert_items()` allowed for multiple tests of the same ID without requiring database cleanup between runs. 