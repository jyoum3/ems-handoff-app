/**
 * ChatHub.tsx — Bidirectional Chat Component
 * ============================================
 * Phase 4 Sprint 3 — Two modes:
 *   Mini Bar: sticky above action bar (55% compose / 45% log)
 *   Full Overlay: full-screen chat (z-index 1500)
 *
 * Messages:
 *   EMS:      left-aligned, orange left border
 *   Hospital: right-aligned, role-color right border
 * On mount: hydrates via getChat()
 * Send: optimistic local append → sendChat() API → HTTP 200 = permanent commit
 *
 * Sprint 3.5 Fix: Message is permanently committed the moment HTTP 200 returns.
 * No SignalR confirmation required. SignalR chatUpdate events only add NEW
 * messages from the hospital — they never replace the local message list.
 * This fixes the 30-second timeout that was deleting messages when SignalR
 * was slow to connect.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { ChatMessage, EmsSession } from '../../types/fhir';
import { sendChat, getChat } from '../../services/api';
import { HOSPITAL_COLORS } from '../../types/fhir';
import styles from './ChatHub.module.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMsgTime(iso: string): string {
  try {
    const d = new Date(iso);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${mm}/${dd}/${yyyy} ${hh}:${min}`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ChatHubProps {
  messages: ChatMessage[];
  bundleId: string;
  hospitalId: string;
  session: EmsSession;
  isExpanded: boolean;
  onExpandToggle: () => void;
  onNewMessages: (messages: ChatMessage[]) => void;
}

// Optimistic message:
//   _pending=true  → HTTP request in flight (not yet confirmed)
//   _committed=true → HTTP 200 returned, permanently shown even without SignalR
//   _failed=true   → HTTP request failed, tap to retry
interface OptimisticMessage extends ChatMessage {
  _pending?: boolean;
  _committed?: boolean;
  _failed?: boolean;
  _tempId?: string;
}

// ---------------------------------------------------------------------------
// ChatHub
// ---------------------------------------------------------------------------

export default function ChatHub({
  messages,
  bundleId,
  hospitalId,
  session,
  isExpanded,
  onExpandToggle,
  onNewMessages,
}: ChatHubProps) {
  const [composeText, setComposeText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [localMessages, setLocalMessages] = useState<OptimisticMessage[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [lastSeenCount, setLastSeenCount] = useState(0);

  const messageEndRef = useRef<HTMLDivElement>(null);
  const miniLogRef = useRef<HTMLDivElement>(null);

  // ── Merge: show server messages + local messages not yet in server list ──
  // A local message is "in the server list" once an exact text+authorSource
  // match appears in `messages` prop (the server-confirmed list). Until then
  // (or if SignalR never fires), the local message stays visible permanently.
  const allMessages: OptimisticMessage[] = [
    ...messages,
    ...localMessages.filter((lm) => {
      // Always show failed messages so medic can retry
      if (lm._failed) return true;
      // Hide if already confirmed in server messages prop
      const confirmed = messages.some(
        (m) => m.text === lm.text && m.authorSource === lm.authorSource,
      );
      return !confirmed;
    }),
  ];

  // Track unread count when mini bar is visible
  useEffect(() => {
    if (!isExpanded) {
      const newCount = allMessages.length - lastSeenCount;
      setUnreadCount(Math.max(0, newCount));
    }
  }, [allMessages.length, isExpanded, lastSeenCount]);

  // Clear unread when expanded
  useEffect(() => {
    if (isExpanded) {
      setUnreadCount(0);
      setLastSeenCount(allMessages.length);
    }
  }, [isExpanded, allMessages.length]);

  // Auto-scroll
  useEffect(() => {
    if (isExpanded) {
      messageEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else {
      if (miniLogRef.current) {
        miniLogRef.current.scrollTop = miniLogRef.current.scrollHeight;
      }
    }
  }, [allMessages.length, isExpanded]);

  // Hydrate on mount
  useEffect(() => {
    getChat(bundleId, hospitalId)
      .then((msgs) => {
        if (msgs.length > 0) onNewMessages(msgs);
      })
      .catch(() => {/* silently ignore */});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundleId, hospitalId]);

  // ── Send ─────────────────────────────────────────────────────────────────
  const handleSend = useCallback(async (textOverride?: string) => {
    const text = (textOverride ?? composeText).trim();
    if (!text || isSending) return;

    const tempId = `temp-${Date.now()}`;
    const authorRole = `MEDIC-${session.medicUnit}`;
    const authorName = session.medicName;

    // Step 1: Optimistic append (pending state)
    const optimistic: OptimisticMessage = {
      messageId: tempId,
      _tempId: tempId,
      _pending: true,
      text,
      authorRole,
      authorName,
      authorSource: 'EMS',
      createdAt: new Date().toISOString(),
    };
    setLocalMessages((prev) => [...prev, optimistic]);
    setComposeText('');
    setSendError('');
    setIsSending(true);

    try {
      // Step 2: HTTP call — takes ~150ms per backend logs
      await sendChat(bundleId, hospitalId, text, authorRole, authorName, 'EMS');

      // Step 3: HTTP 200 → permanently commit. Message stays forever.
      // No waiting for SignalR. The message IS in Cosmos — it's confirmed.
      setLocalMessages((prev) =>
        prev.map((m) =>
          m._tempId === tempId
            ? { ...m, _pending: false, _committed: true }
            : m,
        ),
      );
    } catch {
      // Mark as failed — do NOT remove. Medic can tap to retry.
      setLocalMessages((prev) =>
        prev.map((m) =>
          m._tempId === tempId ? { ...m, _pending: false, _failed: true } : m,
        ),
      );
      setSendError('Send failed — tap message to retry');
    } finally {
      setIsSending(false);
    }
  }, [composeText, isSending, bundleId, hospitalId, session]);

  const handleRetry = (msg: OptimisticMessage) => {
    setLocalMessages((prev) => prev.filter((m) => m._tempId !== msg._tempId));
    void handleSend(msg.text);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  // ── Recent messages for mini log (last 3) ────────────────────────────────
  const recentMessages = allMessages.slice(-3);

  // ── Hospital message border color ────────────────────────────────────────
  function getHospColor(role: string): string {
    for (const [key, color] of Object.entries(HOSPITAL_COLORS)) {
      if (role.includes(key)) return color;
    }
    return HOSPITAL_COLORS['CHARGE'];
  }

  // ── FULL OVERLAY ─────────────────────────────────────────────────────────
  if (isExpanded) {
    return (
      <div className={styles.overlay}>
        {/* Header */}
        <div className={styles.overlayHeader}>
          <h2 className={styles.overlayTitle}>
            💬 Chat — {hospitalId}
          </h2>
          <button
            type="button"
            className={styles.closeOverlayBtn}
            onClick={onExpandToggle}
            aria-label="Close chat"
          >✕</button>
        </div>

        {/* Message thread */}
        <div className={styles.messageList}>
          {allMessages.length === 0 && (
            <div className={styles.emptyChat}>
              No messages yet. Send the first update to the receiving team.
            </div>
          )}

          {allMessages.map((msg) => {
            const isEms = msg.authorSource === 'EMS';
            const om = msg as OptimisticMessage;
            return (
              <div
                key={msg.messageId}
                className={isEms ? styles.msgEms : styles.msgHospital}
                style={{
                  ...(!isEms ? { borderRightColor: getHospColor(msg.authorRole) } : {}),
                  ...(om._pending ? { opacity: 0.65 } : {}),
                }}
              >
                <div className={styles.msgHeader}>
                  {msg.authorRole} | {msg.authorName} | {formatMsgTime(msg.createdAt)}
                  {om._pending && <span style={{ marginLeft: 6, fontSize: '11px', color: '#64748b' }}>sending…</span>}
                </div>
                <div className={`${styles.msgText} ${om._failed ? styles.msgFailed : ''}`}>
                  {msg.text}
                </div>
                {om._failed && (
                  <div className={styles.msgRetry} onClick={() => handleRetry(om)}>
                    ↩ Send failed — tap to retry
                  </div>
                )}
              </div>
            );
          })}
          <div ref={messageEndRef} />
        </div>

        {/* Input */}
        <div className={styles.overlayInput}>
          <textarea
            className={styles.overlayTextarea}
            rows={2}
            value={composeText}
            onChange={(e) => setComposeText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message… (Enter to send)"
          />
          <button
            type="button"
            className={styles.overlaySendBtn}
            onClick={() => void handleSend()}
            disabled={!composeText.trim() || isSending}
          >
            {isSending ? '⏳ Sending…' : 'Send'}
          </button>
        </div>
      </div>
    );
  }

  // ── MINI BAR ──────────────────────────────────────────────────────────────
  return (
    <div className={styles.miniBar}>
      {/* Mini header */}
      <div className={styles.miniHeader}>
        <div className={styles.miniHeaderLeft}>
          <span>💬 Chat</span>
          {unreadCount > 0 && (
            <span className={styles.unreadBadge}>{unreadCount}</span>
          )}
        </div>
        <button
          type="button"
          className={styles.expandBtn}
          onClick={onExpandToggle}
          title="Expand chat"
          aria-label="Expand chat"
        >
          ⤢
        </button>
      </div>

      {/* Panes */}
      <div className={styles.miniPanes}>
        {/* Compose pane */}
        <div className={styles.composePane}>
          <textarea
            className={styles.composeTextarea}
            rows={2}
            value={composeText}
            onChange={(e) => setComposeText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type message…"
          />
          <button
            type="button"
            className={styles.sendBtn}
            onClick={() => void handleSend()}
            disabled={!composeText.trim() || isSending}
          >
            {isSending ? '⏳' : 'Send'}
          </button>
          {sendError && <div className={styles.sendErrorMini}>{sendError}</div>}
        </div>

        {/* Log pane (last 3 messages) */}
        <div className={styles.logPane} ref={miniLogRef}>
          {recentMessages.length === 0 && (
            <div style={{ fontSize: '11px', color: '#475569', padding: '4px' }}>No messages yet</div>
          )}
          {recentMessages.map((msg) => {
            const isEms = msg.authorSource === 'EMS';
            return (
              <div
                key={msg.messageId}
                className={`${styles.miniMsg} ${isEms ? styles.miniMsgEms : styles.miniMsgHosp}`}
              >
                <span className={styles.miniRole}>{msg.authorRole}</span>
                {' '}
                <span className={styles.miniTime}>
                  {new Date(msg.createdAt).toLocaleTimeString('en-US', {
                    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
                  })}
                </span>
                {' \u2014 '}
                {msg.text.length > 50 ? `${msg.text.slice(0, 50)}…` : msg.text}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
