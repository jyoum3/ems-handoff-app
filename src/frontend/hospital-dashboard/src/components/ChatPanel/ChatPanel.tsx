/**
 * ChatPanel.tsx — Bidirectional EMS ↔ Hospital Chat (Hospital-SWA)
 * ==================================================================
 * Displays the full chat thread for a patient and allows CHARGE-role
 * users to send messages to the EMS medic.
 *
 * Layout (right pane of PatientDetailModal):
 *   Header:  "📡 Inbound Update Hub" with orange left-border accent
 *   Body:    Scrollable message thread (flex-column, grows to fill pane)
 *   Footer:  CHARGE only — textarea + Send button (sticky bottom)
 *            Non-CHARGE — read-only note
 *
 * Message alignment (mirroring EMS-SWA ChatHub, roles swapped):
 *   HOSPITAL messages (authorSource='HOSPITAL'): LEFT-aligned, ROLE_COLORS border
 *   EMS messages      (authorSource='EMS'):      RIGHT-aligned, orange (#F97316) border
 *
 * Message format (matches EMS ChatHub log format):
 *   Line 1: "[Role] | [Name]"         — bold header
 *   Line 2: "[HH:MM:SS · Mon DD YYYY]" — muted timestamp
 *   Line 3: message text
 *
 * On mount: calls getChat() to hydrate thread.
 * Optimistic send: message appended locally → sendChat() → on fail: inline error.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { FHIRBundle, HospitalId, ChatMessage } from '../../types/fhir'
import { ROLE_COLORS } from '../../types/fhir'
import { getChat, sendChat } from '../../services/api'
import type { UserSession } from '../../hooks/useUser'
import styles from './ChatPanel.module.css'

interface ChatPanelProps {
  bundle: FHIRBundle
  hospitalId: HospitalId
  userSession: UserSession
  messages: ChatMessage[]
  onMessagesLoaded: (messages: ChatMessage[]) => void
  onNewMessage: (messages: ChatMessage[]) => void
}

function formatChatTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    const date = d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })
    return `${time} · ${date}`
  } catch { return iso }
}

export default function ChatPanel({
  bundle,
  hospitalId,
  userSession,
  messages,
  onMessagesLoaded,
  onNewMessage,
}: ChatPanelProps) {
  const [draft, setDraft] = useState('')
  const [sendError, setSendError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const isCharge = userSession.role === 'CHARGE'

  // Hydrate chat on mount
  useEffect(() => {
    setIsLoading(true)
    getChat(bundle.id, hospitalId)
      .then((msgs) => { onMessagesLoaded(msgs) })
      .catch((err) => console.error('[ChatPanel] getChat failed:', err))
      .finally(() => setIsLoading(false))
  }, [bundle.id, hospitalId]) // onMessagesLoaded intentionally omitted — stable callback

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  const handleSend = useCallback(async () => {
    const text = draft.trim()
    if (!text || isSending) return

    setSendError(null)
    setIsSending(true)

    const optimistic: ChatMessage = {
      messageId: `optimistic-${Date.now()}`,
      text,
      authorRole: userSession.role,
      authorName: `${userSession.firstName} ${userSession.lastName}`,
      authorSource: 'HOSPITAL',
      createdAt: new Date().toISOString(),
    }

    // Optimistic append — shown immediately, NOT removed on failure
    onNewMessage([...messages, optimistic])
    setDraft('')

    try {
      await sendChat(
        bundle.id,
        hospitalId,
        text,
        userSession.role,
        `${userSession.firstName} ${userSession.lastName}`,
      )
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Send failed — tap to retry')
    } finally {
      setIsSending(false)
    }
  }, [draft, isSending, messages, bundle.id, hospitalId, userSession, onNewMessage])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className={styles.panel}>
      {/* ── Header ── */}
      <div className={styles.header}>
        <span className={styles.headerTitle}>📡 Inbound Update Hub</span>
      </div>

      {/* ── Message Thread ── */}
      <div className={styles.thread}>
        {isLoading && (
          <div className={styles.loadingText}>Loading messages…</div>
        )}
        {!isLoading && messages.length === 0 && (
          <div className={styles.emptyState}>No inbound updates from EMS yet.</div>
        )}
        {messages.map((msg) => {
          const isHospital = msg.authorSource === 'HOSPITAL'
          const roleColor = isHospital
            ? (ROLE_COLORS[msg.authorRole] ?? '#94a3b8')
            : '#F97316'
          return (
            <div
              key={msg.messageId}
              className={`${styles.bubble} ${isHospital ? styles.bubbleLeft : styles.bubbleRight}`}
              style={{ borderColor: roleColor }}
            >
              <div className={styles.bubbleHeader} style={{ color: roleColor }}>
                {msg.authorRole} | {msg.authorName}
              </div>
              <div className={styles.bubbleTimestamp}>
                {formatChatTimestamp(msg.createdAt)}
              </div>
              <div className={styles.bubbleText}>{msg.text}</div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* ── Compose Footer ── */}
      <div className={styles.footer}>
        {sendError && (
          <div className={styles.sendError}>{sendError}</div>
        )}
        {isCharge ? (
          <div className={styles.composeArea}>
            <textarea
              className={styles.textarea}
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Reply to EMS… (Enter to send)"
              disabled={isSending}
            />
            <button
              className={styles.sendBtn}
              onClick={handleSend}
              disabled={!draft.trim() || isSending}
            >
              {isSending ? 'Sending…' : 'Send'}
            </button>
          </div>
        ) : (
          <div className={styles.readOnlyNote}>
            Only CHARGE can respond to EMS via this channel.
          </div>
        )}
      </div>
    </div>
  )
}
