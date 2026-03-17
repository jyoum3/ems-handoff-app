// api.ts — EMS Ingestion PWA: Backend API Service Layer
// =======================================================
// All calls proxied through Vite dev server → localhost:7071 (Azure Functions).
// In production, Azure SWA routes /api/* to the linked Functions app.

import type { FHIRBundle } from '../types/fhir';
import type { ChatMessage } from '../types/fhir';

const BASE = '/api';

// ---------------------------------------------------------------------------
// Handoff Lifecycle
// ---------------------------------------------------------------------------

/**
 * POST /api/ems-to-db
 * First submission or re-submission (edit) of a FHIR bundle.
 * Returns the stored bundle_id and hospitalId on success (201).
 */
export async function submitHandoff(
  bundle: FHIRBundle,
): Promise<{ bundle_id: string; hospitalId: string }> {
  const res = await fetch(`${BASE}/ems-to-db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bundle),
  });
  if (!res.ok) throw new Error(`submitHandoff failed: ${res.status}`);
  return res.json() as Promise<{ bundle_id: string; hospitalId: string }>;
}

/**
 * POST /api/ems-arrival
 * Medic-triggered patient arrival. Moves bundle from Cosmos DB to Blob archive.
 */
export async function arrivePatient(
  bundleId: string,
  hospitalId: string,
): Promise<void> {
  const res = await fetch(`${BASE}/ems-arrival`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bundle_id: bundleId, hospitalId }),
  });
  if (!res.ok) throw new Error(`arrivePatient failed: ${res.status}`);
}

/**
 * POST /api/recover-handoff
 * Restores an archived patient back to the live Cosmos queue.
 * Called from EMS History Tab (Sprint 3).
 * Returns the restored FHIRBundle so the caller can transition back to LiveHandoffView.
 */
export async function recoverHandoff(
  bundleId: string,
  hospitalId: string,
): Promise<FHIRBundle> {
  const res = await fetch(`${BASE}/recover-handoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bundle_id: bundleId, hospitalId }),
  });
  if (!res.ok) throw new Error(`recoverHandoff failed: ${res.status}`);
  return res.json() as Promise<FHIRBundle>;
}

/**
 * POST /api/divert-handoff
 * Cross-partition patient migration to a different hospital.
 * Called from DivertModal (Sprint 3).
 * Returns the updated FHIRBundle with new hospitalId so LiveHandoffView can update state.
 */
export async function divertHandoff(
  bundleId: string,
  oldHospitalId: string,
  newHospitalId: string,
  newEta?: string,
): Promise<FHIRBundle> {
  const res = await fetch(`${BASE}/divert-handoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bundle_id: bundleId,
      old_hospital_id: oldHospitalId,
      new_hospital_id: newHospitalId,
      ...(newEta ? { new_eta: newEta } : {}),
    }),
  });
  if (!res.ok) throw new Error(`divertHandoff failed: ${res.status}`);
  return res.json() as Promise<FHIRBundle>;
}

// ---------------------------------------------------------------------------
// History Tab
// ---------------------------------------------------------------------------

/**
 * GET /api/fetch-archive?hospitalId={hospitalId}
 * Hydrates the EMS History Tab with arrived patients (Sprint 3).
 */
export async function getHandoffHistory(
  hospitalId: string,
): Promise<FHIRBundle[]> {
  const res = await fetch(`${BASE}/fetch-archive?hospitalId=${hospitalId}`);
  if (!res.ok) throw new Error(`getHandoffHistory failed: ${res.status}`);
  const data = (await res.json()) as unknown;
  // Backend returns { bundles: [...], count: N } — extract the array.
  // Guard also handles legacy plain-array responses for forward-compatibility.
  if (Array.isArray(data)) return data as FHIRBundle[];
  const obj = data as { bundles?: FHIRBundle[] };
  return Array.isArray(obj?.bundles) ? obj.bundles : [];
}

/**
 * GET /api/active-handoffs?hospitalId={hospitalId}
 * Fetches all active bundles for a hospital, then finds the one matching bundleId.
 * Used by App.tsx to restore currentBundle after a page refresh when only
 * bundleId + hospitalId are stored in sessionStorage.
 * Returns null (non-throwing) if the bundle is not found or the request fails.
 */
export async function fetchActiveBundle(
  bundleId: string,
  hospitalId: string,
): Promise<FHIRBundle | null> {
  try {
    const res = await fetch(`${BASE}/active-handoffs?hospitalId=${encodeURIComponent(hospitalId)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    // Backend returns { bundles: [...], count: N } — unwrap the array.
    // Guard also handles plain-array responses for forward-compatibility.
    let bundles: FHIRBundle[];
    if (Array.isArray(data)) {
      bundles = data as FHIRBundle[];
    } else {
      const obj = data as { bundles?: FHIRBundle[] };
      if (!Array.isArray(obj?.bundles)) return null;
      bundles = obj.bundles;
    }
    return bundles.find((b) => b.id === bundleId) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SignalR Negotiate (EMS patient-scoped)
// ---------------------------------------------------------------------------

/**
 * GET /api/ems-negotiate?bundleId={bundleId}
 * Returns a SignalR JWT with userId=bundleId (patient-scoped token).
 * Used by useEmsSignalR (Sprint 3) for live updates from the hospital.
 */
export async function negotiateEms(
  bundleId: string,
): Promise<{ url: string; accessToken: string }> {
  const res = await fetch(`${BASE}/ems-negotiate?bundleId=${bundleId}`);
  if (!res.ok) throw new Error(`negotiateEms failed: ${res.status}`);
  return res.json() as Promise<{ url: string; accessToken: string }>;
}

// ---------------------------------------------------------------------------
// Bidirectional Chat
// ---------------------------------------------------------------------------

/**
 * POST /api/send-chat
 * Appends a message to the inbound-chat Cosmos document and fan-outs
 * to both userId=hospitalId (hospital dashboard) and userId=bundleId (EMS).
 */
export async function sendChat(
  bundleId: string,
  hospitalId: string,
  text: string,
  authorRole: string,
  authorName: string,
  authorSource: 'EMS' | 'HOSPITAL',
): Promise<void> {
  const res = await fetch(`${BASE}/send-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bundleId,
      hospitalId,
      messageText: text,
      authorRole,
      authorName,
      authorSource,
    }),
  });
  if (!res.ok) throw new Error(`sendChat failed: ${res.status}`);
}

/**
 * GET /api/get-chat?bundleId={bundleId}&hospitalId={hospitalId}
 * Hydrates the chat thread on LiveHandoffView load (Sprint 3).
 * Returns [] if no chat history exists yet.
 */
export async function getChat(
  bundleId: string,
  hospitalId: string,
): Promise<ChatMessage[]> {
  const res = await fetch(
    `${BASE}/get-chat?bundleId=${bundleId}&hospitalId=${hospitalId}`,
  );
  if (!res.ok) throw new Error(`getChat failed: ${res.status}`);
  const data = (await res.json()) as { messages?: ChatMessage[] };
  return data.messages ?? [];
}

// ---------------------------------------------------------------------------
// ECG Upload Pipeline (Phase 4 Sprint 2.75)
// ---------------------------------------------------------------------------

/**
 * Uploads an ECG photo and appends an EcgRecord to the bundle in Cosmos DB.
 * Returns the blob_url, bundle_id, and assigned label ("Initial" | "Update HH:MM").
 *
 * Independent of form submit — can be called before or after first handoff
 * submission. If called before the bundle exists in Cosmos, the backend stores
 * the blob and returns the URL; the medic includes it in ecgRecords on submit.
 *
 * @param bundleId  - The active encounter bundle ID
 * @param hospitalId - Must be selected before ECG upload is enabled
 * @param file       - The image/JPEG, image/PNG, or PDF file from the input
 * @param rhythmInterpretation - Optional medic rhythm read (e.g. "Normal Sinus")
 */
export async function uploadEcg(
  bundleId: string,
  hospitalId: string,
  file: File,
  rhythmInterpretation?: string,
): Promise<{ blob_url: string; bundle_id: string; label: string; blobKey?: string }> {
  const form = new FormData();
  form.append('bundleId', bundleId);
  form.append('hospitalId', hospitalId);
  form.append('file', file);
  if (rhythmInterpretation) form.append('rhythmInterpretation', rhythmInterpretation);
  const res = await fetch(`${BASE}/upload-ecg`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`uploadEcg failed: ${res.status}`);
  return res.json() as Promise<{ blob_url: string; bundle_id: string; label: string }>;
}

/**
 * Retrieves a specific ECG image as a Blob object URL for use in <img src=...>.
 * index defaults to -1 (current/latest ECG). Pass 0 for "Initial", 1 for second, etc.
 *
 * The returned object URL must be revoked via URL.revokeObjectURL() when no
 * longer needed to avoid memory leaks.
 */
export async function getEcg(
  bundleId: string,
  hospitalId: string,
  index = -1,
): Promise<string> {
  const res = await fetch(
    `${BASE}/get-ecg?bundleId=${encodeURIComponent(bundleId)}&hospitalId=${encodeURIComponent(hospitalId)}&index=${index}`,
  );
  if (!res.ok) throw new Error(`getEcg failed: ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/**
 * deleteEcg — Remove an ECG record from Cosmos + delete the blob from storage.
 * DELETE /api/delete-ecg?bundleId={bundleId}&hospitalId={hospitalId}&index={index}
 *
 * Steps performed by the backend:
 *   1. Read bundle from Cosmos → get ecgRecords[index]
 *   2. Delete blob using blobKey (or legacy path fallback)
 *   3. Remove ecgRecords[index] from array via patch_item
 *   4. Re-index labels (Initial stays, Updates renumber)
 *   5. Cosmos Change Feed → SignalR → hospital dashboard updates automatically
 *
 * @returns { remainingCount } — number of ECG records after deletion
 */
export async function deleteEcg(
  bundleId: string,
  hospitalId: string,
  index: number,
): Promise<{ remainingCount: number }> {
  const res = await fetch(
    `/api/delete-ecg?bundleId=${encodeURIComponent(bundleId)}&hospitalId=${encodeURIComponent(hospitalId)}&index=${index}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Delete failed' }));
    throw new Error((err as { error?: string }).error ?? 'Delete failed');
  }
  return res.json() as Promise<{ remainingCount: number }>;
}
