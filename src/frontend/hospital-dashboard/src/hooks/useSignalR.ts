/**
 * useSignalR.ts — Azure SignalR Service Connection Hook
 * ======================================================
 *
 * PURPOSE:
 * Manages the full lifecycle of the Azure SignalR Service WebSocket
 * connection for the hospital dashboard. Abstracts all SignalR SDK
 * complexity behind a clean React hook interface so that consumer
 * components (Dashboard) have zero knowledge of WebSocket internals.
 *
 * ARCHITECTURE:
 * This hook is intentionally stateless from React's perspective — it
 * does not manage its own state or cause re-renders. It communicates
 * externally via two callbacks:
 *   onMessage(bundle)       → called on every 'handoffUpdate' SignalR event
 *   onStatusChange(status)  → called on connection state transitions
 *
 * Both callbacks are provided by usePatientQueue, which owns all state.
 * This separation of concerns means:
 *   - useSignalR owns: connection lifecycle, reconnect, cleanup
 *   - usePatientQueue owns: all application state transitions
 *   - Neither knows about components or rendering
 *
 * CONNECTION LIFECYCLE:
 *   Mount → negotiate() → build HubConnection → start()
 *   Disconnect → withAutomaticReconnect backoff → reconnected
 *   Token expiry → TODO: re-negotiate before token exp claim
 *   Unmount → connection.stop() → cleanup
 *
 * WHY useRef FOR THE CONNECTION (NOT useState):
 * The HubConnection object is a mutable SDK instance. Storing it in
 * useState would cause a re-render every time it's assigned, and React
 * state updates are async — there's a window where the old and new
 * connection both exist. useRef is synchronous, doesn't cause re-renders,
 * and the ref always holds the latest value without stale closure issues.
 * This is the correct pattern for imperative, non-visual resources
 * (WebSockets, timers, DOM nodes).
 */

import { useEffect, useRef } from 'react'
import * as signalR from '@microsoft/signalr'
import type { FHIRBundle, HospitalId, HospitalComment, ChatMessage } from '../types/fhir'
import { negotiate } from '../services/api'

// =============================================================================
// Types
// =============================================================================

export type SignalRStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'

interface UseSignalROptions {
  hospitalId: HospitalId
  onMessage: (bundle: FHIRBundle) => void
  onStatusChange: (status: SignalRStatus) => void
  onCommentUpdate?: (data: { bundleId: string; hospitalId: string; allComments: HospitalComment[] }) => void
  onChatUpdate?: (data: { bundleId: string; hospitalId: string; allMessages: ChatMessage[] }) => void
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Manages the Azure SignalR Service WebSocket connection.
 *
 * Calls onMessage() for every 'handoffUpdate' event received.
 * Calls onStatusChange() on every connection state transition.
 * Automatically reconnects with exponential backoff on disconnect.
 * Stops the connection cleanly on component unmount.
 *
 * @param hospitalId   - Drives the SignalR userId scope (data isolation)
 * @param onMessage    - Stable callback (memoized in usePatientQueue)
 * @param onStatusChange - Stable callback (memoized in usePatientQueue)
 */
export function useSignalR({
  hospitalId,
  onMessage,
  onStatusChange,
  onCommentUpdate,
  onChatUpdate,
}: UseSignalROptions): void {
  // useRef stores the active HubConnection instance.
  // Why ref and not state: HubConnection is a mutable SDK object that
  // we manage imperatively (call .start(), .stop(), .on()). Storing it
  // in state would create unnecessary re-renders and async assignment
  // timing issues. The ref is synchronous and doesn't trigger renders.
  const connectionRef = useRef<signalR.HubConnection | null>(null)

  useEffect(() => {
    // Guard: don't attempt SignalR connection until a valid hospitalId is known.
    // Without this, the hook fires on first render before RolePicker selection,
    // sending GET /api/negotiate?hospitalId= (empty) which crashes the
    // {query.hospitalId} binding expression in negotiate_bp.py at the host
    // level — before the Python validation code can return a clean 400.
    if (!hospitalId) {
      onStatusChange('disconnected')
      return
    }

    // `isMounted` flag prevents state updates on an unmounted component.
    // This handles the React StrictMode double-invoke pattern (mount →
    // cleanup → mount) and genuine unmounts before async operations complete.
    let isMounted = true

    async function startConnection(): Promise<void> {
      onStatusChange('connecting')

      try {
        // ── Step 1: Negotiate — exchange hospitalId for a signed JWT ───────
        //
        // The negotiate call hits GET /api/negotiate?hospitalId=HUP-PAV.
        // The Azure Functions backend validates the hospitalId against the
        // allowlist, then issues a JWT access token with userId=HUP-PAV
        // via the signalRConnectionInfo input binding.
        //
        // This token is the data isolation enforcement mechanism:
        //   - Token scoped to userId=HUP-PAV
        //   - When streaming_bp broadcasts to userId=HUP-PAV, SignalR Service
        //     delivers it ONLY to connections with that userId in their token
        //   - A HUP-CEDAR connection cannot receive HUP-PAV messages even if
        //     the JavaScript tries to subscribe — the transport layer enforces it
        const connectionInfo = await negotiate(hospitalId)

        // Guard: if the component unmounted while negotiate() was in flight,
        // abort before creating a connection that nobody will clean up.
        if (!isMounted) return

        // ── Step 2: Build the HubConnection ────────────────────────────────
        //
        // .withUrl() accepts the URL returned by negotiate (the Azure SignalR
        // Service WebSocket endpoint) plus an accessTokenFactory function.
        //
        // WHY accessTokenFactory IS A FUNCTION (not a value):
        // The SignalR SDK calls accessTokenFactory() each time it needs a
        // token — on initial connect AND on reconnect. By returning a function
        // that returns the token string (rather than the string itself), we
        // allow future enhancement: call negotiate() again inside the factory
        // to fetch a fresh token when the original expires. For now, returning
        // the initial token is sufficient for a dashboard session lifetime.
        //
        // .withAutomaticReconnect([0, 2000, 5000, 15000, 30000]):
        //
        // WHY AUTOMATIC RECONNECT MATTERS IN A CLINICAL SETTING:
        // A dashboard running all day on an ER tablet WILL experience network
        // interruptions — WiFi hiccups, network switch restarts, Azure SignalR
        // service deployments, browser sleep/wake cycles. Without automatic
        // reconnect, a nurse would need to manually refresh the page during a
        // disconnect. In a trauma scenario, a missed SignalR event during a
        // manual refresh means a nurse is unaware of an inbound critical patient.
        //
        // The backoff schedule [0, 2000, 5000, 15000, 30000] means:
        //   1st retry: immediately (0ms)
        //   2nd retry: 2 seconds later
        //   3rd retry: 5 seconds after that
        //   4th retry: 15 seconds after that
        //   5th retry: 30 seconds after that
        //
        // After the 5th failed attempt, the SDK fires onclose() — we surface
        // a "Connection lost" banner to nurses. The onreconnecting/onreconnected
        // events update the HospitalBanner status indicator during retries.
        //
        // WHY NOT UNLIMITED RETRIES:
        // Unlimited retries with no circuit breaker would silently hammer the
        // negotiate endpoint forever on a misconfiguration. The bounded schedule
        // ensures we surface the problem to the user rather than hiding it.
        const connection = new signalR.HubConnectionBuilder()
          .withUrl(connectionInfo.url, {
            accessTokenFactory: () => connectionInfo.accessToken,
          })
          .withAutomaticReconnect([0, 2000, 5000, 15000, 30000])
          .configureLogging(signalR.LogLevel.Warning)
          .build()

        // ── Step 3: Register the 'handoffUpdate' event handler ─────────────
        //
        // 'handoffUpdate' is the SignalR target name defined in streaming_bp.py:
        //   _SIGNALR_TARGET = "handoffUpdate"
        //
        // This string is the CONTRACT between the backend broadcast and this
        // frontend listener. If it changes in streaming_bp.py, it MUST change
        // here too. The argument is the Cosmos DB document (a FHIRBundle).
        //
        // onMessage is the stable callback from usePatientQueue that dispatches
        // HANDOFF_UPDATE to the reducer. It is wrapped in useCallback there
        // to maintain referential stability and prevent this effect from
        // re-running on every render.
        connection.on('handoffUpdate', (document: FHIRBundle) => {
          onMessage(document)
        })

        // Sprint 5: commentUpdate — separate channel for comment-only events.
        // Does NOT touch FHIRBundle state — only updates state.comments map.
        connection.on('commentUpdate', (data: { bundleId: string; hospitalId: string; allComments: HospitalComment[] }) => {
          onCommentUpdate?.(data)
        })

        // Sprint 4.1: chatUpdate — bidirectional EMS ↔ Hospital chat.
        // Broadcast by chat_bp.py to userId=hospitalId AND userId=bundleId.
        connection.on('chatUpdate', (data: { bundleId: string; hospitalId: string; allMessages: ChatMessage[] }) => {
          onChatUpdate?.(data)
        })

        // ── Step 4: Register connection state event handlers ───────────────
        //
        // These update the HospitalBanner connection indicator in real time.
        // onreconnecting: fires on the first reconnect attempt
        // onreconnected:  fires when a reconnect attempt succeeds
        // onclose:        fires when ALL reconnect attempts are exhausted
        //                 (after the 30s final attempt in our schedule)
        connection.onreconnecting(() => {
          if (isMounted) onStatusChange('reconnecting')
        })

        connection.onreconnected(() => {
          if (isMounted) onStatusChange('connected')
        })

        connection.onclose(() => {
          // All reconnect attempts exhausted — connection is dead.
          // The dashboard HospitalBanner will show a red "Disconnected" badge.
          // Nurses must manually refresh to re-establish the connection.
          if (isMounted) onStatusChange('disconnected')
        })

        // ── Step 5: Start the connection ────────────────────────────────────
        await connection.start()

        // Final mount guard — if unmounted during connection.start(),
        // immediately stop the connection and don't update any state.
        if (!isMounted) {
          await connection.stop()
          return
        }

        connectionRef.current = connection
        onStatusChange('connected')
      } catch (err) {
        // Connection setup failed (negotiate error, WebSocket refused, etc.)
        // This is distinct from a mid-session disconnect, which withAutomaticReconnect
        // handles. This error occurs during the INITIAL connection attempt.
        if (isMounted) {
          console.error('[useSignalR] Initial connection failed:', err)
          onStatusChange('disconnected')
        }
      }
    }

    startConnection()

    // ── Cleanup: stop the connection when the hook's dependencies change ──
    //
    // This runs:
    //   a) When the component unmounts (e.g., navigating away from dashboard)
    //   b) In React StrictMode development, which double-invokes effects
    //      (mount → cleanup → mount) to detect side effect cleanup issues
    //   c) If hospitalId changes (would require re-negotiate for new userId)
    //
    // connection.stop() gracefully sends the WebSocket close frame and
    // tears down the connection. Without this cleanup, hot-reloading in
    // development leaves orphaned connections open, and multiple connections
    // would be created on rapid re-renders.
    return () => {
      isMounted = false
      connectionRef.current?.stop().catch(() => {
        // Ignore stop() errors during cleanup — the connection may already
        // be in a stopping or disconnected state.
      })
      connectionRef.current = null
    }
  }, [hospitalId, onMessage, onStatusChange, onCommentUpdate, onChatUpdate])
  // Dependencies: hospitalId (data isolation key), onMessage and onStatusChange
  // are stable refs from useCallback in usePatientQueue — they don't trigger
  // re-runs. hospitalId changing would require a new negotiate() call.
}
