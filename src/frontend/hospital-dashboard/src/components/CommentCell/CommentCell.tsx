// CommentCell.tsx — Sprint 5 Revised Layout
// Inline row: clean 2-line no-comment layout, 3-line has-comment layout (no icon).
// Dialog: bigger panel, chat log sorted OLDEST → NEWEST.

import { useState, useEffect, useRef } from 'react'
import type { HospitalId, HospitalComment } from '../../types/fhir'
import { ROLE_COLORS } from '../../types/fhir'
import { updateComment } from '../../services/api'
import { formatCommentDate } from '../../utils/fhirHelpers'
import styles from './CommentCell.module.css'

interface UserSessionLike {
  role: string
  firstName: string
  lastName: string
  displayLabel?: string
}

interface CommentCellProps {
  bundleId: string
  patientName: string
  hospitalId: HospitalId
  comments: HospitalComment[]
  userSession: UserSessionLike | null
  isArchived?: boolean
}

function getRoleColor(role: string): string {
  return ROLE_COLORS[role as keyof typeof ROLE_COLORS] ?? '#94A3B8'
}

function RoleBadge({ role, name }: { role: string; name: string }) {
  const color = getRoleColor(role)
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '3px',
        background: `${color}26`,
        border: `1px solid ${color}`,
        borderRadius: '9999px',
        padding: '2px 9px',
        fontSize: '0.72rem',
        fontWeight: 700,
        color: '#fff',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ color }}>{role}</span>
      <span style={{ color: '#cbd5e1' }}>| {name}</span>
    </span>
  )
}

export default function CommentCell({
  bundleId,
  patientName,
  hospitalId,
  comments,
  userSession,
  isArchived = false,
}: CommentCellProps) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Latest comment = last in the array (newest by insertion order from backend)
  const latestComment = comments.length > 0 ? comments[comments.length - 1] : null
  const canEdit = !isArchived && userSession !== null

  useEffect(() => {
    if (open && canEdit) setTimeout(() => textareaRef.current?.focus(), 50)
  }, [open, canEdit])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  const handleSubmit = async () => {
    if (!text.trim() || !userSession || isArchived) return
    setSubmitting(true)
    setSubmitError(null)
    const submittedText = text.trim()
    const authorName = `${userSession.firstName} ${userSession.lastName}`
    try {
      await updateComment(bundleId, hospitalId, submittedText, userSession.role, authorName)
      setText('')
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to save comment')
      setText(submittedText)
    } finally {
      setSubmitting(false)
    }
  }

  // Sorted OLDEST → NEWEST for the log (ascending chronological)
  const chronologicalLog = [...comments].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )

  return (
    <>
      {/* ── Inline Row Display ──────────────────────────────────────── */}
      {latestComment ? (
        /* HAS COMMENT — 3 line layout: [ROLE|NAME  EDIT] / [DATE-TIME] / ['comment'] */
        <div className={styles.inlineHasComment}>
          {/* Line 1: role badge + EDIT button (right-aligned) */}
          <div className={styles.inlineLine1}>
            <RoleBadge role={latestComment.authorRole} name={latestComment.authorName} />
            <button
              className={isArchived ? styles.editBtnDisabled : styles.editBtn}
              onClick={() => setOpen(true)}
              disabled={isArchived}
              title={isArchived ? 'Read-only for arrived patients' : 'Edit comments'}
            >
              EDIT
            </button>
          </div>
          {/* Line 2: date/time */}
          <div className={styles.inlineLine2}>
            {formatCommentDate(latestComment.createdAt)}
          </div>
          {/* Line 3: first 15 chars + ellipsis if longer */}
          <div className={styles.inlineLine3}>
            '{latestComment.text.length > 15
              ? `${latestComment.text.slice(0, 15)}...`
              : latestComment.text}'
          </div>
        </div>
      ) : (
        /* NO COMMENT — 2-line layout: "No comment yet.  [EDIT]" / "Press 'EDIT' to add one." */
        <div className={styles.inlineNoComment}>
          <div className={styles.inlineNoTop}>
            <span className={styles.noCommentText}>No comment yet.</span>
            <button
              className={isArchived ? styles.editBtnDisabled : styles.editBtn}
              onClick={() => setOpen(true)}
              disabled={isArchived}
            >
              EDIT
            </button>
          </div>
          <div className={styles.noCommentSub}>Press "EDIT" to add one.</div>
        </div>
      )}

      {/* ── Dialog ─────────────────────────────────────────────────── */}
      {open && (
        <div
          className={styles.overlay}
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false) }}
        >
          <div className={styles.panel} role="dialog" aria-label="Comments">

            {/* Header */}
            <div className={styles.panelHeader}>
              <span className={styles.panelTitle}>💬 Comments — {patientName}</span>
              <button className={styles.btnClose} onClick={() => setOpen(false)} aria-label="Close">×</button>
            </div>

            {/* Latest Comment (above fold) */}
            <div className={styles.latestSection}>
              <div className={styles.sectionLabel}>Latest Comment</div>
              {latestComment ? (
                <div className={styles.latestEntry}>
                  <div className={styles.entryMeta}>
                    <RoleBadge role={latestComment.authorRole} name={latestComment.authorName} />
                    <span className={styles.entryDate}>{formatCommentDate(latestComment.createdAt)}</span>
                  </div>
                  <p className={styles.commentText}>'{latestComment.text}'</p>
                </div>
              ) : (
                <p className={styles.emptyState}>No comments yet.</p>
              )}
            </div>

            {/* Textarea input */}
            <div className={styles.inputArea}>
              {submitError && <p className={styles.errorMsg}>{submitError}</p>}
              <textarea
                ref={textareaRef}
                className={styles.textarea}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  isArchived
                    ? 'Comments are read-only for arrived patients.'
                    : userSession
                    ? 'Write a comment…'
                    : 'Start your shift to add comments.'
                }
                disabled={!canEdit || submitting}
                rows={5}
                maxLength={1000}
              />
              <div className={styles.inputFooter}>
                <span className={styles.charCount}>{text.length}/1000</span>
                <div className={styles.inputActions}>
                  <button className={styles.btnCancel} onClick={() => setOpen(false)}>
                    Close
                  </button>
                  <button
                    className={styles.btnSubmit}
                    onClick={handleSubmit}
                    disabled={!canEdit || !text.trim() || submitting}
                  >
                    {submitting ? 'Saving…' : '+ Add Comment'}
                  </button>
                </div>
              </div>
            </div>

            {/* Comment Log — oldest → newest (chronological reading order) */}
            {chronologicalLog.length > 0 && (
              <div className={styles.commentLog}>
                <div className={styles.sectionLabel}>Comment Log</div>
                {chronologicalLog.map((c) => (
                  <div key={c.commentId} className={styles.commentEntry}>
                    <div className={styles.entryMeta}>
                      <RoleBadge role={c.authorRole} name={c.authorName} />
                      <span className={styles.entryDate}>{formatCommentDate(c.createdAt)}</span>
                    </div>
                    <p className={styles.commentText}>'{c.text}'</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
