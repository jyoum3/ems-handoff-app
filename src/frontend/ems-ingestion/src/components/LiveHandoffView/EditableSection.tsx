/**
 * EditableSection.tsx — Generic Collapsible + Editable Section Wrapper
 * ======================================================================
 * Phase 4 Sprint 3 — Used by all 8 LiveHandoffView sections.
 *
 * UX:
 *   - Header: [▶/▼ chevron] [Title] ... [badge] [✏️ Edit / 💾 Save + ✕ Cancel]
 *   - defaultExpanded=true — all sections open on first load
 *   - ✏️ Edit on a collapsed section auto-expands + enters edit mode
 *   - Content area: max-height CSS transition for smooth open/close
 *   - Flash animation: applies orange highlight to element with data-field-id
 *   - Section footer: "Updated HH:MM" shown after at least one save
 *   - Save failure: inline "⚠️ Save failed — try again" error in header
 *
 * Post-Phase-4 fix: Added `onEditOpen` prop — called immediately BEFORE
 * entering edit mode. LiveHandoffView uses this to re-initialize each
 * section's edit form from the latest currentBundle at the exact moment
 * the Edit button is clicked, preventing stale/blank fields.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface EditableSectionProps {
  sectionId: string;
  title: string;
  badgeContent?: React.ReactNode;
  children: React.ReactNode;
  editForm?: React.ReactNode;
  onSave?: () => Promise<void>;
  isSaving?: boolean;
  editLabel?: string;
  hideEdit?: boolean;
  defaultExpanded?: boolean;
  flashFieldId?: string | null;
  onFlashComplete?: () => void;
  // Allows parent to provide a ref for scroll-to navigation
  sectionRef?: React.RefObject<HTMLDivElement | null>;
  /**
   * Called immediately BEFORE entering edit mode (before isEditing becomes true).
   * LiveHandoffView uses this to re-initialize the section's edit form from
   * the latest currentBundle at the exact moment Edit is clicked — ensuring
   * the medic never sees stale/blank fields even if currentBundle updated
   * since the component last mounted.
   */
  onEditOpen?: () => void;
}

// ---------------------------------------------------------------------------
// Flash keyframes — injected once as a <style> tag
// ---------------------------------------------------------------------------

const FLASH_STYLE_ID = 'ems-flash-keyframes';
if (typeof document !== 'undefined' && !document.getElementById(FLASH_STYLE_ID)) {
  const style = document.createElement('style');
  style.id = FLASH_STYLE_ID;
  style.textContent = `
    @keyframes flashHighlight {
      0%   { background: rgba(249,115,22,0.25); border-radius: 4px; }
      100% { background: transparent; }
    }
    .ems-flash-field {
      animation: flashHighlight 2s ease-out forwards;
    }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// EditableSection
// ---------------------------------------------------------------------------

export default function EditableSection({
  sectionId,
  title,
  badgeContent,
  children,
  editForm,
  onSave,
  isSaving,
  editLabel = '✏️ Edit',
  hideEdit = false,
  defaultExpanded = true,
  flashFieldId,
  onFlashComplete,
  sectionRef,
  onEditOpen,
}: EditableSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultExpanded);
  const [isEditing, setIsEditing] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [lastSavedTime, setLastSavedTime] = useState('');
  const [showTooltip, setShowTooltip] = useState(false);
  const innerRef = useRef<HTMLDivElement>(null);

  // Use provided sectionRef or internal ref
  const containerRef = (sectionRef as React.RefObject<HTMLDivElement>) ?? innerRef;

  // ── Flash animation: apply to target field when flashFieldId changes ─────
  useEffect(() => {
    if (!flashFieldId) return;
    const target = containerRef.current?.querySelector(
      `[data-field-id="${flashFieldId}"]`,
    ) as HTMLElement | null;
    if (!target) return;

    target.classList.remove('ems-flash-field');
    // Force reflow
    void target.offsetWidth;
    target.classList.add('ems-flash-field');

    const timer = setTimeout(() => {
      target.classList.remove('ems-flash-field');
      setShowTooltip(true);
      onFlashComplete?.();
      setTimeout(() => setShowTooltip(false), 3000);
    }, 2000);

    return () => clearTimeout(timer);
  }, [flashFieldId, onFlashComplete, containerRef]);

  // ── Edit button ───────────────────────────────────────────────────────────
  const handleEdit = () => {
    // Fire onEditOpen FIRST so the parent can re-initialize the edit form
    // from the latest currentBundle before isEditing becomes true.
    // Without this, if currentBundle updated via SignalR after mount,
    // the edit form would show stale (or blank) field values.
    onEditOpen?.();
    setIsOpen(true);   // auto-expand if collapsed
    setIsEditing(true);
    setSaveError('');
  };

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!onSave) return;
    setSaveError('');
    try {
      await onSave();
      setIsEditing(false);
      const now = new Date();
      setLastSavedTime(
        now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
      );
    } catch {
      setSaveError('⚠️ Save failed — try again');
    }
  }, [onSave]);

  // ── Cancel ────────────────────────────────────────────────────────────────
  const handleCancel = () => {
    setIsEditing(false);
    setSaveError('');
  };

  // ── Collapse toggle ───────────────────────────────────────────────────────
  const toggleOpen = () => {
    if (!isEditing) setIsOpen((v) => !v);
  };

  return (
    <div
      ref={containerRef as React.RefObject<HTMLDivElement>}
      data-section-id={sectionId}
      style={{
        borderRadius: '8px',
        border: '1px solid #334155',
        background: '#1e293b',
        marginBottom: '10px',
        overflow: 'hidden',
      }}
    >
      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '10px 14px',
          background: '#0f172a',
          borderBottom: isOpen ? '1px solid #334155' : 'none',
          flexWrap: 'wrap',
          minHeight: '44px',
        }}
      >
        {/* Chevron */}
        <button
          type="button"
          onClick={toggleOpen}
          style={{
            background: 'none',
            border: 'none',
            color: '#64748b',
            cursor: 'pointer',
            fontSize: '14px',
            padding: '2px 4px',
            lineHeight: 1,
            transition: 'transform 0.2s',
            transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
          }}
          aria-label={isOpen ? 'Collapse section' : 'Expand section'}
        >
          ▾
        </button>

        {/* Title */}
        <button
          type="button"
          onClick={toggleOpen}
          style={{
            flex: 1,
            background: 'none',
            border: 'none',
            color: '#f1f5f9',
            fontSize: '13px',
            fontWeight: 700,
            textAlign: 'left',
            cursor: 'pointer',
            padding: 0,
            letterSpacing: '0.02em',
          }}
        >
          {title}
        </button>

        {/* Badge */}
        {badgeContent && (
          <span style={{ fontSize: '11px', color: '#64748b' }}>{badgeContent}</span>
        )}

        {/* Save error inline */}
        {saveError && (
          <span style={{ fontSize: '11px', color: '#f87171', fontWeight: 600 }}>
            {saveError}
          </span>
        )}

        {/* Edit / Save+Cancel controls */}
        {!hideEdit && !isEditing && (
          <button
            type="button"
            onClick={handleEdit}
            style={{
              padding: '4px 10px',
              borderRadius: '5px',
              background: 'rgba(51,65,85,0.6)',
              border: '1px solid #475569',
              color: '#94a3b8',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {editLabel}
          </button>
        )}

        {isEditing && (
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              style={{
                padding: '4px 12px',
                borderRadius: '5px',
                background: isSaving ? '#374151' : '#F97316',
                border: 'none',
                color: '#fff',
                fontSize: '12px',
                fontWeight: 700,
                cursor: isSaving ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                whiteSpace: 'nowrap',
              }}
            >
              {isSaving ? '⏳ Saving…' : '💾 Save'}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={isSaving}
              style={{
                padding: '4px 10px',
                borderRadius: '5px',
                background: 'rgba(51,65,85,0.5)',
                border: '1px solid #475569',
                color: '#94a3b8',
                fontSize: '12px',
                fontWeight: 600,
                cursor: isSaving ? 'not-allowed' : 'pointer',
              }}
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* ── CONTENT ────────────────────────────────────────────────────── */}
      <div
        style={{
          maxHeight: isOpen ? '2400px' : '0px',
          overflow: 'hidden',
          transition: 'max-height 0.3s ease-in-out',
        }}
      >
        <div style={{ padding: '12px 14px' }}>
          {/* Show edit form or read view */}
          {isEditing && editForm ? editForm : children}
        </div>

        {/* ── FOOTER: "Updated HH:MM" — outside edit mode ────────── */}
        {!isEditing && lastSavedTime && (
          <div
            style={{
              padding: '4px 14px 8px',
              fontSize: '11px',
              color: '#64748b',
              fontStyle: 'italic',
            }}
          >
            Updated {lastSavedTime}
          </div>
        )}

        {/* Flash tooltip */}
        {showTooltip && (
          <div
            style={{
              margin: '0 14px 8px',
              padding: '6px 10px',
              borderRadius: '6px',
              background: 'rgba(249,115,22,0.12)',
              border: '1px solid rgba(249,115,22,0.3)',
              color: '#fb923c',
              fontSize: '11px',
            }}
          >
            ← Tap ✏️ Edit to update this field
          </div>
        )}
      </div>
    </div>
  );
}
