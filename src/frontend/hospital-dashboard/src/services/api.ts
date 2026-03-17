// services/api.ts — API client for EMS Handoff Dashboard
// Sprint 5: addComment removed. getComments + updateComment added.
//           Comments live in separate Cosmos container (not on FHIRBundle).
// Sprint 4.1: getChat, sendChat, getEcg added.

import type { CommentMap, FHIRBundle, HospitalId, ChatMessage } from '../types/fhir';

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api';

// ---------------------------------------------------------------------------
// Handoff Operations
// ---------------------------------------------------------------------------

/** Fetch all active (inbound) handoffs for a hospital */
export async function getActiveHandoffs(hospitalId: HospitalId): Promise<FHIRBundle[]> {
  const res = await fetch(`${BASE}/active-handoffs?hospitalId=${hospitalId}`);
  if (!res.ok) throw new Error(`getActiveHandoffs failed: ${res.status}`);
  const data = await res.json();
  // Backend returns { bundles: [...], count: N } — unwrap the array.
  // Guard also handles plain-array responses for forward-compatibility.
  if (Array.isArray(data)) return data as FHIRBundle[];
  const obj = data as { bundles?: FHIRBundle[] };
  return Array.isArray(obj?.bundles) ? obj.bundles : [];
}

/** Fetch archived handoffs (from Blob Storage) for a hospital */
export async function getArchiveHandoffs(hospitalId: HospitalId): Promise<FHIRBundle[]> {
  const res = await fetch(`${BASE}/fetch-archive?hospitalId=${hospitalId}`);
  if (!res.ok) throw new Error(`getArchiveHandoffs failed: ${res.status}`);
  const data = await res.json();
  // Backend returns { bundles: [...], count: N } — unwrap the array.
  // Guard also handles plain-array responses for forward-compatibility.
  if (Array.isArray(data)) return data as FHIRBundle[];
  const obj = data as { bundles?: FHIRBundle[] };
  return Array.isArray(obj?.bundles) ? obj.bundles : [];
}

/** Mark a patient as arrived — archives bundle, cleans up comment doc */
export async function arrivePatient(
  bundleId: string,
  hospitalId: HospitalId,
): Promise<void> {
  const res = await fetch(`${BASE}/ems-arrival`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bundle_id: bundleId, hospitalId }),
  });
  if (!res.ok) throw new Error(`arrivePatient failed: ${res.status}`);
}

/** Restore an archived patient back to the live queue */
export async function recoverHandoff(
  bundleId: string,
  hospitalId: HospitalId,
): Promise<void> {
  const res = await fetch(`${BASE}/recover-handoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bundle_id: bundleId, hospitalId }),
  });
  if (!res.ok) throw new Error(`recoverHandoff failed: ${res.status}`);
}

// ---------------------------------------------------------------------------
// Comment Operations (Sprint 5 — Separate Container)
// ---------------------------------------------------------------------------

/**
 * Fetch all comment documents for a hospital.
 * Returns a CommentMap: { bundleId: HospitalComment[] }
 * Called once on mount to hydrate state.comments.
 */
export async function getComments(hospitalId: HospitalId): Promise<CommentMap> {
  const res = await fetch(`${BASE}/get-comments?hospitalId=${hospitalId}`);
  if (!res.ok) throw new Error(`getComments failed: ${res.status}`);
  const data = await res.json();
  return (data.comments ?? {}) as CommentMap;
}

/**
 * Append a new comment to a patient's comment document.
 * The backend upserts to handoff-comments container and broadcasts
 * 'commentUpdate' via SignalR to all connected dashboards.
 */
export async function updateComment(
  bundleId: string,
  hospitalId: HospitalId,
  commentText: string,
  authorRole: string,
  authorName: string,
): Promise<void> {
  const res = await fetch(`${BASE}/update-comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bundleId, hospitalId, commentText, authorRole, authorName }),
  });
  if (!res.ok) throw new Error(`updateComment failed: ${res.status}`);
}

// ---------------------------------------------------------------------------
// Backward-Compatible Aliases (for existing component/hook code)
// ---------------------------------------------------------------------------

/** @deprecated Use getActiveHandoffs */
export const fetchActiveHandoffs = getActiveHandoffs;

/** @deprecated Use getArchiveHandoffs */
export const fetchHotTierArchive = getArchiveHandoffs;

/**
 * Fetch a single archived bundle by bundleId (used by PatientDetailModal).
 * Fetches all archive bundles and filters by id.
 */
export async function fetchArchiveBundle(
  bundleId: string,
  hospitalId: HospitalId,
): Promise<FHIRBundle | null> {
  const bundles = await getArchiveHandoffs(hospitalId);
  return bundles.find((b) => b.id === bundleId) ?? null;
}

/**
 * @deprecated Use updateComment.
 * Legacy addComment kept for any component referencing the old API.
 */
export async function addComment(
  bundleId: string,
  hospitalId: HospitalId,
  commentText: string,
  authorRole: string,
  authorName: string,
): Promise<void> {
  return updateComment(bundleId, hospitalId, commentText, authorRole, authorName);
}

// ---------------------------------------------------------------------------
// SignalR Negotiation
// ---------------------------------------------------------------------------

export async function negotiateSignalR(hospitalId: HospitalId): Promise<{ url: string; accessToken: string }> {
  const res = await fetch(`${BASE}/negotiate?hospitalId=${hospitalId}`);
  if (!res.ok) throw new Error(`negotiate failed: ${res.status}`);
  return res.json();
}

/** @deprecated alias used by useSignalR */
export const negotiate = negotiateSignalR;

// ---------------------------------------------------------------------------
// Sprint 4.1: Chat API
// ---------------------------------------------------------------------------

/**
 * Lazy-load chat history for a patient. Called on Details modal open.
 * Backend: GET /api/get-chat?bundleId=X&hospitalId=Y
 * Returns the messages[] array from the inbound-chat Cosmos document.
 */
export async function getChat(
  bundleId: string,
  hospitalId: HospitalId,
): Promise<ChatMessage[]> {
  const res = await fetch(`${BASE}/get-chat?bundleId=${encodeURIComponent(bundleId)}&hospitalId=${encodeURIComponent(hospitalId)}`)
  if (!res.ok) throw new Error(`getChat failed: ${res.status}`)
  const data = await res.json()
  return data.messages ?? []
}

/**
 * Send a hospital → EMS chat message.
 * Only CHARGE role should call this (enforced client-side by ChatPanel).
 * Backend: POST /api/send-chat
 */
export async function sendChat(
  bundleId: string,
  hospitalId: HospitalId,
  text: string,
  authorRole: string,
  authorName: string,
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
      authorSource: 'HOSPITAL',
    }),
  })
  if (!res.ok) throw new Error(`sendChat failed: ${res.status}`)
}

// ---------------------------------------------------------------------------
// Sprint 4.1: ECG API
// ---------------------------------------------------------------------------

/**
 * Retrieve an ECG image as an object URL (for EcgViewer).
 * Backend: GET /api/get-ecg?bundleId=X&hospitalId=Y&index=N
 * index=-1 (default) returns the most recent ECG.
 */
export async function getEcg(
  bundleId: string,
  hospitalId: HospitalId,
  index = -1,
): Promise<string> {
  const res = await fetch(
    `${BASE}/get-ecg?bundleId=${encodeURIComponent(bundleId)}&hospitalId=${encodeURIComponent(hospitalId)}&index=${index}`,
  )
  if (!res.ok) throw new Error(`getEcg failed: ${res.status}`)
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}
