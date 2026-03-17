/**
 * EcgViewer.tsx — Read-Only Serial ECG Viewer (Hospital Dashboard)
 * =================================================================
 * Phase 4 Sprint 4.3 — Hospital read-only variant of EMS EcgViewer (Sprint 3.2).
 *
 * ECG Loading Fix (Post-Sprint 4 testing):
 *   Replaced loadingIndices useState with requestedRef (useRef<Set<number>>).
 *   React StrictMode invokes effects twice; using useState for the "already
 *   requested" guard created a stale-closure race where two concurrent getEcg()
 *   calls would race their .finally() handlers, each removing the index from
 *   loadingIndices before the other promise resolved — leaving the component in
 *   a state where isActiveLoading=false, isActiveFailed=false, activeUrl=undefined
 *   → perpetual "⏳ Loading ECG…" spinner. useRef is not closed over and always
 *   reflects the latest value, eliminating the race entirely.
 *
 * Lightbox (Post-Sprint 4 testing):
 *   Clicking the primary ECG image opens a fullscreen EcgLightbox overlay with
 *   wheel zoom (1× – 8×), pointer-drag pan, zoom indicator, and Escape/✕ close.
 *
 * Removed from the EMS version:
 *   - onUpload / onRhythmSave / onDelete props
 *   - "Add New ECG" row (AddNewRow component)
 *   - Inline rhythm editing (editingRhythmIdx state + ✏️ button)
 *   - Two-step delete (deleteConfirmIdx state + 🗑️ button)
 *
 * Kept from the EMS version:
 *   - Primary viewer (full-width image + orange pill + rhythm note)
 *   - History Rail (vertical rows, active glow, click-to-select)
 *   - Compare button (records.length >= 2)
 *   - ComparisonOverlay with free-float drag per panel
 *   - URL cache (Map, getEcg loading on index change, revoke on unmount)
 *   - formatEcgLabel / formatEcgLabelShort exports
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { EcgRecord, HospitalId } from '../../types/fhir';
import { getEcg } from '../../services/api';
import ComparisonOverlay from './ComparisonOverlay';
import styles from './EcgViewer.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface EcgViewerProps {
  records: EcgRecord[];
  bundleId: string;
  hospitalId: HospitalId;
}

// ---------------------------------------------------------------------------
// Label format helpers (Sprint 3.2 — exported for ComparisonOverlay)
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
// EcgLightbox — fullscreen zoom/pan overlay
// ---------------------------------------------------------------------------

interface EcgLightboxProps {
  url: string;
  altText: string;
  onClose: () => void;
}

function EcgLightbox({ url, altText, onClose }: EcgLightboxProps) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const offsetAtDrag = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Wheel zoom — zooms toward cursor position
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setScale(prev => {
      const next = Math.min(8, Math.max(1, prev * delta));
      return next;
    });
  }, []);

  // Reset pan when scale goes back to 1
  useEffect(() => {
    if (scale <= 1) setOffset({ x: 0, y: 0 });
  }, [scale]);

  // Pointer drag
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (scale <= 1) return;
    isDragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY };
    offsetAtDrag.current = { ...offset };
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  }, [scale, offset]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging.current) return;
    setOffset({
      x: offsetAtDrag.current.x + (e.clientX - dragStart.current.x),
      y: offsetAtDrag.current.y + (e.clientY - dragStart.current.y),
    });
  }, []);

  const handlePointerUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1200,
        background: 'rgba(0,0,0,0.88)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: scale > 1 ? 'grab' : 'default',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Close button */}
      <button
        onClick={onClose}
        style={{
          position: 'absolute', top: 16, right: 20, zIndex: 10,
          background: 'rgba(15,23,42,0.85)', border: '1px solid #334155',
          color: '#f1f5f9', borderRadius: '8px', padding: '6px 14px',
          fontSize: '16px', fontWeight: 700, cursor: 'pointer', lineHeight: 1,
        }}
        aria-label="Close lightbox"
      >
        ✕
      </button>

      {/* Zoom indicator */}
      <div style={{
        position: 'absolute', bottom: 20, right: 20, zIndex: 10,
        background: 'rgba(15,23,42,0.85)', border: '1px solid #334155',
        color: '#94a3b8', borderRadius: '8px', padding: '4px 10px',
        fontSize: '12px', fontWeight: 600, pointerEvents: 'none',
      }}>
        {scale.toFixed(1)}×
      </div>

      {/* Hint */}
      <div style={{
        position: 'absolute', bottom: 20, left: 20, zIndex: 10,
        color: '#475569', fontSize: '11px', pointerEvents: 'none',
      }}>
        Scroll to zoom · Drag to pan · Esc to close
      </div>

      {/* Image container — captures wheel and drag events */}
      <div
        ref={containerRef}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        style={{
          width: '90vw', height: '85vh',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden',
          cursor: scale > 1 ? (isDragging.current ? 'grabbing' : 'grab') : 'default',
          userSelect: 'none',
        }}
      >
        <img
          src={url}
          alt={altText}
          draggable={false}
          style={{
            maxWidth: '100%', maxHeight: '100%',
            objectFit: 'contain',
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: 'center center',
            transition: isDragging.current ? 'none' : 'transform 0.05s ease-out',
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EcgViewer — Read-Only
// ---------------------------------------------------------------------------

export default function EcgViewer({ records, bundleId, hospitalId }: EcgViewerProps) {
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, records.length - 1));
  const [urlCache, setUrlCache] = useState<Map<number, string>>(new Map());
  // useRef (not useState) — never stale in a closure; survives React StrictMode
  // double-invoke without creating a race condition between concurrent getEcg() calls.
  const requestedRef = useRef<Set<number>>(new Set());
  const [failedIndices, setFailedIndices] = useState<Set<number>>(new Set());
  const [retryCount, setRetryCount] = useState(0);
  const [showCompare, setShowCompare] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // ── Clamp activeIndex when records change ────────────────────────────────
  useEffect(() => {
    setActiveIndex((prev) => Math.min(prev, Math.max(0, records.length - 1)));
  }, [records.length]);

  // ── Load object URLs for all records on mount / when records grow / retry ─
  useEffect(() => {
    records.forEach((_, idx) => {
      // useRef guard: always reads the latest Set value — no stale closure
      if (!requestedRef.current.has(idx) && !urlCache.has(idx)) {
        requestedRef.current.add(idx);
        getEcg(bundleId, hospitalId, idx)
          .then((url) => {
            setUrlCache((prev) => new Map(prev).set(idx, url));
            setFailedIndices((prev) => {
              const next = new Set(prev);
              next.delete(idx);
              return next;
            });
          })
          .catch(() => {
            setFailedIndices((prev) => new Set(prev).add(idx));
            // Remove from requestedRef so a retry can re-request
            requestedRef.current.delete(idx);
          });
      }
    });
    // retryCount in deps allows the retry button to re-trigger this effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records.length, bundleId, hospitalId, retryCount]);

  // ── Revoke all object URLs on unmount (prevent memory leaks) ────────────
  useEffect(() => {
    return () => {
      urlCache.forEach((url) => URL.revokeObjectURL(url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Retry handler for a specific index ───────────────────────────────────
  const handleRetry = useCallback((idx: number) => {
    requestedRef.current.delete(idx);
    setFailedIndices((prev) => {
      const next = new Set(prev);
      next.delete(idx);
      return next;
    });
    setRetryCount((c) => c + 1);
  }, []);

  // ── Pill text for the primary viewer overlay ─────────────────────────────
  function getPillText(): string {
    if (records.length === 0) return '';
    const rec = records[activeIndex];
    if (!rec) return '';
    if (activeIndex === records.length - 1) return 'Current';
    return formatEcgLabelShort(rec);
  }

  // State A: 0 records — PatientDetailModal guards this (never reached)
  if (records.length === 0) return null;

  const activeUrl = urlCache.get(activeIndex);
  const isActiveFailed = failedIndices.has(activeIndex) && !activeUrl;

  return (
    <div className={styles.container}>

      {/* ── Primary Viewer ─────────────────────────────────────── */}
      <div className={styles.primaryViewer}>
        {isActiveFailed ? (
          <div className={styles.primaryImageLoading} style={{ flexDirection: 'column', gap: '10px' }}>
            <span>⚠️ Failed to load ECG — check that the Azure Functions host is running</span>
            <button
              onClick={() => handleRetry(activeIndex)}
              style={{
                padding: '6px 16px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                background: 'rgba(249,115,22,0.15)', border: '1px solid #F97316', color: '#fb923c',
                cursor: 'pointer',
              }}
            >
              🔄 Retry
            </button>
          </div>
        ) : activeUrl ? (
          <img
            src={activeUrl}
            alt={`ECG ${getPillText()}`}
            className={styles.primaryImage}
            onClick={() => setLightboxOpen(true)}
            style={{ cursor: 'zoom-in' }}
            title="Click to zoom"
          />
        ) : (
          <div className={styles.primaryImageLoading}>⏳ Loading ECG…</div>
        )}
        {records.length > 0 && (
          <div className={styles.primaryPill}>{getPillText()}</div>
        )}
      </div>

      {/* ── Rhythm note below primary viewer ───────────────────── */}
      {records[activeIndex]?.rhythmInterpretation && (
        <div className={styles.rhythmLine}>
          🎵 {records[activeIndex].rhythmInterpretation}
        </div>
      )}

      {/* ── History Rail — vertical rows for State C (2+ records) ── */}
      {records.length >= 2 && (
        <div className={styles.historyRail}>
          {records.map((rec, idx) => (
            <div
              key={idx}
              className={`${styles.historyRow} ${idx === activeIndex ? styles.historyRowActive : ''}`}
              onClick={() => setActiveIndex(idx)}
            >
              {urlCache.get(idx) ? (
                <img src={urlCache.get(idx)} alt="" className={styles.historyThumb} />
              ) : failedIndices.has(idx) ? (
                <div className={styles.historyThumb} style={{ background: '#1e293b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', color: '#ef4444' }}>⚠</div>
              ) : (
                <div className={styles.historyThumb} style={{ background: '#1e293b' }} />
              )}
              <span className={styles.historyLabel}>{formatEcgLabel(rec)}</span>
              {idx === records.length - 1 && (
                <span className={styles.currentBadge}>● CURRENT</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Compare button (State C: 2+ records) ─────────────── */}
      {records.length >= 2 && (
        <button
          type="button"
          className={styles.compareBtn}
          onClick={() => setShowCompare(true)}
        >
          ⚡ Compare Rhythms
        </button>
      )}

      {/* ── Comparison Overlay ────────────────────────────────── */}
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

      {/* ── Lightbox — fullscreen zoom/pan for primary ECG ───── */}
      {lightboxOpen && activeUrl && (
        <EcgLightbox
          url={activeUrl}
          altText={`ECG ${getPillText()}`}
          onClose={() => setLightboxOpen(false)}
        />
      )}

    </div>
  );
}
