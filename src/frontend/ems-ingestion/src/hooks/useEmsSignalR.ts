/**
 * useEmsSignalR.ts — EMS SignalR Real-Time Hook
 * ===============================================
 * Phase 4 Sprint 3 — EMS patient-scoped SignalR subscription.
 *
 * Architecture:
 *   - Connects when bundleId is non-null; stops when bundleId becomes null.
 *   - Calls /api/ems-negotiate?bundleId={bundleId} for a JWT scoped to that patient.
 *   - Listens for TWO events only:
 *       "emsHandoffUpdate" — hospital lifecycle events (arrived_by_hospital, restored, etc.)
 *       "chatUpdate"       — full message thread (allMessages) from hospital or EMS
 *   - Exponential reconnect: [0, 2000, 5000, 15000, 30000] ms
 *   - Exposes reconnect(newBundleId) for post-diversion channel switch.
 *
 * Mirrors hospital-dashboard/src/hooks/useSignalR.ts pattern.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import * as signalR from '@microsoft/signalr';
import { negotiateEms } from '../services/api';
import type { ChatMessage } from '../types/fhir';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SignalRConnectionState = 'live' | 'connecting' | 'reconnecting' | 'disconnected';

interface UseEmsSignalRResult {
  connectionState: SignalRConnectionState;
  reconnect: (newBundleId: string) => void;
  lastSyncAt: Date | null;  // Sprint 4.1: stale data guard
}

// Exponential back-off delays in ms
const RECONNECT_DELAYS = [0, 2000, 5000, 15000, 30000];

// ---------------------------------------------------------------------------
// useEmsSignalR
// ---------------------------------------------------------------------------

export function useEmsSignalR(
  bundleId: string | null,
  onEmsUpdate: (data: { action: string; bundleId: string; hospitalId: string }) => void,
  onChatMessage: (data: { bundleId: string; hospitalId: string; allMessages: ChatMessage[] }) => void,
): UseEmsSignalRResult {
  const [connectionState, setConnectionState] = useState<SignalRConnectionState>('disconnected');
  // Sprint 4.1: Track last received message time for stale data guard
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const connectionRef = useRef<signalR.HubConnection | null>(null);
  const activeBundleIdRef = useRef<string | null>(bundleId);

  // Keep latest callbacks in refs — never stale in event handlers
  const onEmsUpdateRef = useRef(onEmsUpdate);
  const onChatMessageRef = useRef(onChatMessage);
  useEffect(() => { onEmsUpdateRef.current = onEmsUpdate; }, [onEmsUpdate]);
  useEffect(() => { onChatMessageRef.current = onChatMessage; }, [onChatMessage]);

  // ── Stop current connection ──────────────────────────────────────────────
  const stopConnection = useCallback(async () => {
    if (connectionRef.current) {
      try {
        await connectionRef.current.stop();
      } catch {
        // Ignore stop errors — connection may already be gone
      }
      connectionRef.current = null;
    }
    setConnectionState('disconnected');
  }, []);

  // ── Start connection for a given bundleId ────────────────────────────────
  const startConnection = useCallback(async (bid: string) => {
    await stopConnection();
    setConnectionState('connecting');

    // Negotiate first to get the Azure SignalR hub URL + access token.
    // CRITICAL: We must use creds.url (the actual SignalR service endpoint),
    // NOT '/api' — using '/api' would cause the SDK to call '/api/negotiate'
    // which is the hospital-scoped endpoint requiring hospitalId.
    let hubUrl: string;
    let accessToken: string;
    try {
      const creds = await negotiateEms(bid);
      // Handle both field names: Azure Functions SDK v3+ returns 'url';
      // some versions return 'endpoint'. Fall back gracefully.
      const credsAny = creds as Record<string, string>;
      hubUrl = credsAny.url ?? credsAny.endpoint ?? '';
      accessToken = credsAny.accessToken ?? '';
      if (!hubUrl) {
        console.error('[useEmsSignalR] negotiate returned no hub URL:', creds);
        setConnectionState('disconnected');
        return;
      }
    } catch (err) {
      console.error('[useEmsSignalR] negotiate failed:', err);
      setConnectionState('disconnected');
      return;
    }

    const connection = new signalR.HubConnectionBuilder()
      .withUrl(hubUrl, {
        accessTokenFactory: () => accessToken,
      })
      .withAutomaticReconnect({
        nextRetryDelayInMilliseconds: (ctx) => {
          const delay = RECONNECT_DELAYS[Math.min(ctx.previousRetryCount, RECONNECT_DELAYS.length - 1)];
          return delay;
        },
      })
      .configureLogging(signalR.LogLevel.Warning)
      .build();

    // ── Event listeners ──────────────────────────────────────────────────
    connection.on('emsHandoffUpdate', (data) => {
      setLastSyncAt(new Date());  // Sprint 4.1: stale guard timestamp
      onEmsUpdateRef.current(data);
    });

    connection.on('chatUpdate', (data) => {
      setLastSyncAt(new Date());  // Sprint 4.1: stale guard timestamp
      onChatMessageRef.current(data);
    });

    // ── State transitions ────────────────────────────────────────────────
    connection.onreconnecting(() => setConnectionState('reconnecting'));
    connection.onreconnected(() => setConnectionState('live'));
    connection.onclose(() => setConnectionState('disconnected'));

    connectionRef.current = connection;

    try {
      await connection.start();
      setConnectionState('live');
    } catch (err) {
      console.error('[useEmsSignalR] start failed:', err);
      setConnectionState('disconnected');
    }
  }, [stopConnection]);

  // ── Lifecycle: connect when bundleId appears / disconnect when null ──────
  useEffect(() => {
    activeBundleIdRef.current = bundleId;
    if (bundleId) {
      startConnection(bundleId);
    } else {
      stopConnection();
    }

    return () => {
      stopConnection();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundleId]);

  // ── Public reconnect — called after diversion to re-sub to new bundleId ─
  const reconnect = useCallback((newBundleId: string) => {
    activeBundleIdRef.current = newBundleId;
    startConnection(newBundleId);
  }, [startConnection]);

  return { connectionState, reconnect, lastSyncAt };
}
