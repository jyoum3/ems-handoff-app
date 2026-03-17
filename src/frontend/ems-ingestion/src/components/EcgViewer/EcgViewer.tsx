/**
 * EcgViewer.tsx — Serial ECG Viewer with History Rail
 * ====================================================
 * Phase 4 Sprint 3.2 — Overhauled from Sprint 3:
 *
 *   State A (0 records): add-new row only
 *   State B (1 record):  primary viewer + add-new row (no history rail)
 *   State C (2+ records): primary viewer + VERTICAL history rail + compare button
 *
 * Sprint 3.2 changes:
 *   - History Rail redesigned from horizontal scroll cards → vertical rows
 *   - Each row: thumbnail | formatEcgLabel text | [✏️ Edit Rhythm] [🗑️ Delete]
 *   - Inline rhythm editing (input replaces label text, Save/Cancel buttons)
 *   - Two-step delete (row turns red, Confirm? button + Cancel)
 *   - Clicking a history row now correctly updates the primary viewer
 *   - ComparisonOverlay receives bundleId, hospitalId, setUrlCache for lazy loading
 *   - formatEcgLabel: "[Rhythm] — [Label] · [HH:MM] — [Mon DD/YYYY]"
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { EcgRecord } from '../../types/fhir';
import { uploadEcg, getEcg, deleteEcg } from '../../services/api';
import ComparisonOverlay from './ComparisonOverlay';
import styles from './EcgViewer.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface EcgViewerProps {
  records: EcgRecord[];
  bundleId: string;
  hospitalId: string;
  onUpload?: (record: EcgRecord) => void;
  onRhythmSave?: (updatedRecords: EcgRecord[]) => Promise<void>; // Sprint 3.2
  onDelete?: (idx: number) => void;                               // Sprint 3.2
}

// ---------------------------------------------------------------------------
// Label format helpers (Sprint 3.2)
// ---------------------------------------------------------------------------

/**
 * Full label: "[Rhythm] — [Label] · [HH:MM] — [Mon DD, YYYY]"
 * If no rhythm: "[Label] · [HH:MM] — [Mon DD, YYYY]"
 */
export function formatEcgLabel(record: EcgRecord): string {
  try {
    const d = new Date(record.timestamp);
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    const timeDate = `${record.label} · ${time} — ${mm}/${dd}/${yyyy}`;
    if (record.rhythmInterpretation) {
      return `${record.rhythmInterpretation} — ${timeDate}`;
    }
    return timeDate;
  } catch {
    return record.label;
  }
}

/**
 * Short label for pills and tight spaces: "[Rhythm] — [Label] · [HH:MM]"
 * If no rhythm: "[Label] · [HH:MM]"
 */
export function formatEcgLabelShort(record: EcgRecord): string {
  try {
    const d = new Date(record.timestamp);
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    return record.rhythmInterpretation
      ? `${record.rhythmInterpretation} — ${record.label} · ${time}`
      : `${record.label} · ${time}`;
  } catch {
    return record.label;
  }
}

// ---------------------------------------------------------------------------
// EcgViewer
// ---------------------------------------------------------------------------

export default function EcgViewer({
  records,
  bundleId,
  hospitalId,
  onUpload,
  onRhythmSave,
  onDelete,
}: EcgViewerProps) {
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, records.length - 1));
  const [urlCache, setUrlCache] = useState<Map<number, string>>(new Map());
  // useRef (not useState) — never stale in a closure; survives React StrictMode
  // double-invoke without racing concurrent getEcg() calls.
  const requestedRef = useRef<Set<number>>(new Set());

  // Add-new row state
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  const [stagedPreviewUrl, setStagedPreviewUrl] = useState<string | null>(null);
  const [rhythmNote, setRhythmNote] = useState('');
  const [isUploading, setIsUploading] = useState(false);

  // Sprint 3.2: History Rail edit state
  const [editingRhythmIdx, setEditingRhythmIdx] = useState<number | null>(null);
  const [rhythmEditValue, setRhythmEditValue] = useState('');
  const [savingRhythmIdx, setSavingRhythmIdx] = useState<number | null>(null);

  // Sprint 3.2: History Rail delete state (two-step)
  const [deleteConfirmIdx, setDeleteConfirmIdx] = useState<number | null>(null);
  const [deletingIdx, setDeletingIdx] = useState<number | null>(null);

  // Compare overlay
  const [showCompare, setShowCompare] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Update activeIndex when records shrink ────────────────────────────────
  useEffect(() => {
    setActiveIndex((prev) => Math.min(prev, Math.max(0, records.length - 1)));
  }, [records.length]);

  // ── Load object URLs for all records ─────────────────────────────────────
  useEffect(() => {
    records.forEach((_, idx) => {
      if (!urlCache.has(idx) && !requestedRef.current.has(idx)) {
        requestedRef.current.add(idx);
        getEcg(bundleId, hospitalId, idx)
          .then((url) => {
            setUrlCache((prev) => {
              const next = new Map(prev);
              next.set(idx, url);
              return next;
            });
          })
          .catch(() => {
            // Remove from requestedRef on failure so a future effect run can re-request
            requestedRef.current.delete(idx);
          });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records.length, bundleId, hospitalId]);

  // ── Revoke object URLs on unmount ────────────────────────────────────────
  useEffect(() => {
    return () => {
      urlCache.forEach((url) => URL.revokeObjectURL(url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Staged file preview URL ───────────────────────────────────────────────
  useEffect(() => {
    if (!stagedFile) { setStagedPreviewUrl(null); return; }
    const url = URL.createObjectURL(stagedFile);
    setStagedPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [stagedFile]);

  // ── File select ───────────────────────────────────────────────────────────
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) setStagedFile(file);
  };

  const handleRemoveStaged = () => {
    setStagedFile(null);
    setRhythmNote('');
  };

  // ── Upload ────────────────────────────────────────────────────────────────
  const handleUpload = async () => {
    if (!stagedFile || isUploading || !onUpload) return;
    setIsUploading(true);
    try {
      const result = await uploadEcg(bundleId, hospitalId, stagedFile, rhythmNote.trim() || undefined);
      const newRecord: EcgRecord = {
        url: result.blob_url,
        timestamp: new Date().toISOString(),
        label: result.label,
        blobKey: result.blobKey,           // carry blobKey so section saves don't wipe it
        rhythmInterpretation: rhythmNote.trim() || undefined,
      };
      onUpload(newRecord);
      setStagedFile(null);
      setRhythmNote('');
    } catch (err) {
      console.error('[EcgViewer] upload failed:', err);
    } finally {
      setIsUploading(false);
    }
  };

  // ── Sprint 3.2: Save rhythm edit ─────────────────────────────────────────
  const handleSaveRhythm = useCallback(async (idx: number) => {
    if (!onRhythmSave) return;
    setSavingRhythmIdx(idx);
    try {
      const updatedRecords = records.map((r, i) =>
        i === idx ? { ...r, rhythmInterpretation: rhythmEditValue } : r,
      );
      await onRhythmSave(updatedRecords);
      setEditingRhythmIdx(null);
    } catch (err) {
      console.error('[EcgViewer] rhythm save failed:', err);
    } finally {
      setSavingRhythmIdx(null);
    }
  }, [onRhythmSave, records, rhythmEditValue]);

  // ── Sprint 3.2: Confirm delete ───────────────────────────────────────────
  const handleConfirmDelete = useCallback(async (idx: number) => {
    setDeletingIdx(idx);
    try {
      await deleteEcg(bundleId, hospitalId, idx);
      setDeleteConfirmIdx(null);
      // Adjust activeIndex: if we deleted at or before active, clamp down
      setActiveIndex((prev) => (prev >= idx ? Math.max(0, prev - 1) : prev));
      if (onDelete) onDelete(idx);
    } catch (err) {
      console.error('[EcgViewer] delete failed:', err);
    } finally {
      setDeletingIdx(null);
    }
  }, [bundleId, hospitalId, onDelete]);

  // ── Pill text for primary viewer ──────────────────────────────────────────
  function getPillText(): string {
    if (records.length === 0) return '';
    const rec = records[activeIndex];
    if (!rec) return '';
    if (activeIndex === records.length - 1) return 'Current';
    return formatEcgLabelShort(rec);
  }

  // ── State A: 0 records ────────────────────────────────────────────────────
  if (records.length === 0) {
    return (
      <div className={styles.container}>
        <AddNewRow
          stagedFile={stagedFile}
          stagedPreviewUrl={stagedPreviewUrl}
          rhythmNote={rhythmNote}
          isUploading={isUploading}
          onFileSelect={handleFileSelect}
          onRemove={handleRemoveStaged}
          onRhythmChange={setRhythmNote}
          onUpload={handleUpload}
          fileInputRef={fileInputRef}
          canUpload={!!onUpload}
        />
      </div>
    );
  }

  const activeUrl = urlCache.get(activeIndex);
  const isActiveLoading = requestedRef.current.has(activeIndex) && !activeUrl;

  return (
    <div className={styles.container}>
      {/* Primary Viewer */}
      <div className={styles.primaryViewer}>
        {isActiveLoading ? (
          <div className={styles.primaryImageLoading}>⏳ Loading ECG…</div>
        ) : activeUrl ? (
          <img src={activeUrl} alt={`ECG ${getPillText()}`} className={styles.primaryImage} />
        ) : (
          <div className={styles.primaryImageLoading}>⚠️ Failed to load</div>
        )}
        {records.length > 0 && (
          <div className={styles.primaryPill}>{getPillText()}</div>
        )}
      </div>

      {/* Rhythm note below primary (read-only display; edit via ✏️ in history row) */}
      {records[activeIndex]?.rhythmInterpretation && (
        <div className={styles.rhythmLine}>
          🎵 {records[activeIndex].rhythmInterpretation}
        </div>
      )}

      {/* ── History Rail — vertical rows for State C (2+ records) ── */}
      {records.length >= 2 && (
        <div className={styles.historyRail}>
          {records.map((rec, idx) => {
            const thumbUrl = urlCache.get(idx);
            const thumbLoading = requestedRef.current.has(idx) && !urlCache.has(idx);
            const isEditing = editingRhythmIdx === idx;
            const isDelConfirm = deleteConfirmIdx === idx;

            return (
              <div
                key={idx}
                className={[
                  styles.historyRow,
                  idx === activeIndex ? styles.historyRowActive : '',
                  isDelConfirm ? styles.historyRowDeleteConfirm : '',
                ].filter(Boolean).join(' ')}
                onClick={() => {
                  if (!isEditing && !isDelConfirm) setActiveIndex(idx);
                }}
              >
                {/* Thumbnail */}
                {thumbLoading || !thumbUrl ? (
                  <div className={styles.historyThumb} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: '10px' }}>
                    {thumbLoading ? '⏳' : '—'}
                  </div>
                ) : (
                  <img src={thumbUrl} alt={rec.label} className={styles.historyThumb} />
                )}

                {/* Label or inline edit input */}
                {isEditing ? (
                  <input
                    type="text"
                    className={styles.rhythmEditInput}
                    value={rhythmEditValue}
                    onChange={(e) => setRhythmEditValue(e.target.value)}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleSaveRhythm(idx);
                      if (e.key === 'Escape') setEditingRhythmIdx(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: 0, overflow: 'hidden' }}>
                    <span className={styles.historyLabel} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {formatEcgLabel(rec)}
                    </span>
                    {idx === records.length - 1 && (
                      <span style={{
                        flexShrink: 0, padding: '2px 7px', borderRadius: '4px',
                        background: 'rgba(34,197,94,0.15)', border: '1px solid #22c55e',
                        color: '#4ade80', fontSize: '10px', fontWeight: 700, letterSpacing: '0.05em',
                      }}>CURRENT</span>
                    )}
                  </div>
                )}

                {/* Action buttons */}
                <div className={styles.historyActions} onClick={(e) => e.stopPropagation()}>
                  {isEditing ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleSaveRhythm(idx)}
                        disabled={savingRhythmIdx === idx}
                        style={{ fontSize: '11px', padding: '3px 8px', borderRadius: '4px', border: '1px solid #22c55e', background: 'rgba(34,197,94,0.1)', color: '#4ade80', cursor: 'pointer' }}
                      >
                        {savingRhythmIdx === idx ? '⏳' : '💾 Save'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingRhythmIdx(null)}
                        style={{ fontSize: '11px', padding: '3px 8px', borderRadius: '4px', border: '1px solid #475569', background: 'none', color: '#94a3b8', cursor: 'pointer' }}
                      >
                        ✕
                      </button>
                    </>
                  ) : isDelConfirm ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleConfirmDelete(idx)}
                        disabled={deletingIdx === idx}
                        style={{ fontSize: '11px', padding: '3px 8px', borderRadius: '4px', border: '1px solid #ef4444', background: 'rgba(239,68,68,0.15)', color: '#f87171', cursor: 'pointer' }}
                      >
                        {deletingIdx === idx ? '⏳' : '🗑️ Confirm?'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteConfirmIdx(null)}
                        style={{ fontSize: '11px', padding: '3px 8px', borderRadius: '4px', border: '1px solid #475569', background: 'none', color: '#94a3b8', cursor: 'pointer' }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      {onRhythmSave && (
                        <button
                          type="button"
                          title="Edit rhythm interpretation"
                          onClick={() => {
                            setEditingRhythmIdx(idx);
                            setRhythmEditValue(rec.rhythmInterpretation ?? '');
                          }}
                          style={{ fontSize: '13px', padding: '3px 7px', borderRadius: '4px', border: '1px solid #475569', background: 'none', color: '#94a3b8', cursor: 'pointer' }}
                        >
                          ✏️
                        </button>
                      )}
                      {onDelete && (
                        <button
                          type="button"
                          title="Delete this ECG"
                          onClick={() => setDeleteConfirmIdx(idx)}
                          style={{ fontSize: '13px', padding: '3px 7px', borderRadius: '4px', border: '1px solid #475569', background: 'none', color: '#94a3b8', cursor: 'pointer' }}
                        >
                          🗑️
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add New ECG Row */}
      <AddNewRow
        stagedFile={stagedFile}
        stagedPreviewUrl={stagedPreviewUrl}
        rhythmNote={rhythmNote}
        isUploading={isUploading}
        onFileSelect={handleFileSelect}
        onRemove={handleRemoveStaged}
        onRhythmChange={setRhythmNote}
        onUpload={handleUpload}
        fileInputRef={fileInputRef}
        canUpload={!!onUpload}
      />

      {/* Compare button — State C: show when records.length >= 2 (fix: was > 2) */}
      {records.length >= 2 && onUpload && (
        <button
          type="button"
          className={styles.compareBtn}
          onClick={() => setShowCompare(true)}
        >
          ⚡ Compare Rhythms
        </button>
      )}

      {/* Comparison Overlay — Sprint 3.2: pass bundleId, hospitalId, setUrlCache */}
      {showCompare && (
        <ComparisonOverlay
          records={records}
          bundleId={bundleId}
          hospitalId={hospitalId}
          urlCache={urlCache}
          setUrlCache={setUrlCache}
          onClose={() => setShowCompare(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddNewRow — single compact line for staging + uploading
// ---------------------------------------------------------------------------

interface AddNewRowProps {
  stagedFile: File | null;
  stagedPreviewUrl: string | null;
  rhythmNote: string;
  isUploading: boolean;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemove: () => void;
  onRhythmChange: (v: string) => void;
  onUpload: () => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  canUpload: boolean;
}

function AddNewRow({
  stagedFile,
  stagedPreviewUrl,
  rhythmNote,
  isUploading,
  onFileSelect,
  onRemove,
  onRhythmChange,
  onUpload,
  fileInputRef,
  canUpload,
}: AddNewRowProps) {
  return (
    <div className={styles.addRow}>
      {/* File selector / preview thumbnail */}
      {stagedPreviewUrl ? (
        <img
          src={stagedPreviewUrl}
          alt="ECG preview"
          className={styles.addPreview}
        />
      ) : (
        <label className={styles.addLabel}>
          📷 Add ECG
          <input
            ref={fileInputRef as React.RefObject<HTMLInputElement>}
            type="file"
            accept="image/*,.pdf"
            style={{ display: 'none' }}
            onChange={onFileSelect}
          />
        </label>
      )}

      {/* Rhythm note input */}
      <input
        type="text"
        className={styles.rhythmInput}
        placeholder="Rhythm interpretation…"
        value={rhythmNote}
        onChange={(e) => onRhythmChange(e.target.value)}
        disabled={isUploading}
      />

      {/* Remove */}
      <button
        type="button"
        className={styles.removeBtn}
        onClick={onRemove}
        disabled={!stagedFile || isUploading}
      >
        Remove
      </button>

      {/* Upload */}
      <button
        type="button"
        className={styles.uploadBtn}
        onClick={onUpload}
        disabled={!stagedFile || isUploading || !canUpload}
      >
        {isUploading ? '⏳' : 'Upload'}
      </button>
    </div>
  );
}
