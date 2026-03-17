/**
 * ComparisonOverlay.tsx — Side-by-Side ECG Comparison
 * ======================================================
 * Phase 4 Sprint 3.5 — Simplified free-mode only (Lock Alignment removed).
 *
 * Layout per panel:
 *   [ Left sidebar (~180px): ECG selector + Reset button ]
 *   [ Right content (flex:1): ECG image, draggable + zoomable ]
 *
 * Orange dividing line separates top and bottom panels.
 * Control bar at bottom: Reset All button.
 * ✕ Close button: absolute top-right.
 */

import { useState, useRef, useEffect } from 'react';
import type { EcgRecord } from '../../types/fhir';
import { getEcg } from '../../services/api';
import { formatEcgLabel } from './EcgViewer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PanelState {
  dx: number;
  dy: number;
  zoom: number;
}

const DEFAULT_PANEL: PanelState = { dx: 0, dy: 0, zoom: 1 };

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ComparisonOverlayProps {
  records: EcgRecord[];
  bundleId: string;
  hospitalId: string;
  urlCache: Map<number, string>;
  setUrlCache: React.Dispatch<React.SetStateAction<Map<number, string>>>;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// ECGPanel — draggable + zoomable image panel
// ---------------------------------------------------------------------------

interface ECGPanelProps {
  url?: string;
  label: string;
  state: PanelState;
  onChange: (updater: (prev: PanelState) => PanelState) => void;
}

function ECGPanel({ url, label, state, onChange }: ECGPanelProps) {
  const isDragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    isDragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const ddx = e.clientX - lastPos.current.x;
    const ddy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    onChange((p) => ({ ...p, dx: p.dx + ddx, dy: p.dy + ddy }));
  };

  const handlePointerUp = () => { isDragging.current = false; };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.15 : 0.15;
      onChange((p) => ({ ...p, zoom: Math.min(8, Math.max(1, p.zoom + delta)) }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onChange]);

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      style={{
        flex: 1,
        overflow: 'hidden',
        cursor: 'grab',
        background: '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none',
        touchAction: 'none',
      }}
    >
      {url ? (
        <img
          src={url}
          alt={label}
          draggable={false}
          style={{
            transform: `translate(${state.dx}px, ${state.dy}px) scale(${state.zoom})`,
            transformOrigin: 'center center',
            transition: 'none',
            maxWidth: '100%',
            maxHeight: '100%',
            pointerEvents: 'none',
          }}
        />
      ) : (
        <div style={{ color: '#475569', fontSize: '13px' }}>Loading…</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PanelWithSidebar — selector LEFT + image fills RIGHT
// ---------------------------------------------------------------------------

interface PanelWithSidebarProps {
  records: EcgRecord[];
  selectedIndex: number;
  onSelect: (i: number) => void;
  onReset: () => void;
  showReset: boolean;
  url?: string;
  label: string;
  state: PanelState;
  onChange: (updater: (prev: PanelState) => PanelState) => void;
}

function PanelWithSidebar({
  records,
  selectedIndex,
  onSelect,
  onReset,
  showReset,
  url,
  label,
  state,
  onChange,
}: PanelWithSidebarProps) {
  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      {/* Left sidebar — selector + Reset */}
      <div style={{
        width: '180px',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        padding: '8px',
        background: 'rgba(15,23,42,0.97)',
        borderRight: '1px solid #334155',
        gap: '8px',
      }}>
        <select
          value={selectedIndex}
          onChange={(e) => onSelect(Number(e.target.value))}
          style={{
            background: '#1e293b',
            border: '1px solid #334155',
            color: '#f1f5f9',
            fontSize: '12px',
            padding: '6px 8px',
            borderRadius: '5px',
            outline: 'none',
            cursor: 'pointer',
            width: '100%',
          }}
        >
          {records.map((rec, i) => (
            <option key={i} value={i}>{formatEcgLabel(rec)}</option>
          ))}
        </select>
        {showReset && (
          <button
            type="button"
            onClick={onReset}
            style={{
              background: 'none',
              border: '1px solid #334155',
              color: '#64748b',
              fontSize: '11px',
              padding: '4px 8px',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            🔄 Reset
          </button>
        )}
      </div>
      {/* Right: ECG image */}
      <ECGPanel url={url} label={label} state={state} onChange={onChange} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ComparisonOverlay
// ---------------------------------------------------------------------------

export default function ComparisonOverlay({
  records,
  bundleId,
  hospitalId,
  urlCache,
  setUrlCache,
  onClose,
}: ComparisonOverlayProps) {
  const [topIndex, setTopIndex] = useState(0);
  const [bottomIndex, setBottomIndex] = useState(Math.min(1, records.length - 1));
  const [topPanel, setTopPanel] = useState<PanelState>(DEFAULT_PANEL);
  const [bottomPanel, setBottomPanel] = useState<PanelState>(DEFAULT_PANEL);

  // ── Escape key ──────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // ── Lazy-load top URL ────────────────────────────────────────────────────
  useEffect(() => {
    if (!urlCache.has(topIndex)) {
      getEcg(bundleId, hospitalId, topIndex)
        .then((url) => setUrlCache((prev) => new Map(prev).set(topIndex, url)))
        .catch(() => { /* silently ignore */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topIndex]);

  // ── Lazy-load bottom URL ─────────────────────────────────────────────────
  useEffect(() => {
    if (!urlCache.has(bottomIndex)) {
      getEcg(bundleId, hospitalId, bottomIndex)
        .then((url) => setUrlCache((prev) => new Map(prev).set(bottomIndex, url)))
        .catch(() => { /* silently ignore */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bottomIndex]);

  const handleResetAll = () => {
    setTopPanel(DEFAULT_PANEL);
    setBottomPanel(DEFAULT_PANEL);
  };

  const topRecord = records[topIndex];
  const bottomRecord = records[bottomIndex];
  const topUrl = urlCache.get(topIndex);
  const bottomUrl = urlCache.get(bottomIndex);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.88)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* ── ✕ Close button — absolute top-right ── */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close comparison"
        style={{
          position: 'absolute',
          top: 8,
          right: 12,
          zIndex: 1010,
          background: 'none',
          border: 'none',
          color: '#94a3b8',
          fontSize: '22px',
          cursor: 'pointer',
          lineHeight: 1,
          padding: '4px',
        }}
      >
        ✕
      </button>

      {/* ── Top Panel ─────────────────────────────────────────────────── */}
      <PanelWithSidebar
        records={records}
        selectedIndex={topIndex}
        onSelect={setTopIndex}
        onReset={() => setTopPanel(DEFAULT_PANEL)}
        showReset={topPanel.dx !== 0 || topPanel.dy !== 0 || topPanel.zoom !== 1}
        url={topUrl}
        label={topRecord?.label ?? ''}
        state={topPanel}
        onChange={setTopPanel}
      />

      {/* ── Orange dividing line between panels ─────────────────────── */}
      <div style={{ height: '2px', background: '#F97316', flexShrink: 0 }} />

      {/* ── Bottom Panel ─────────────────────────────────────────────── */}
      <PanelWithSidebar
        records={records}
        selectedIndex={bottomIndex}
        onSelect={setBottomIndex}
        onReset={() => setBottomPanel(DEFAULT_PANEL)}
        showReset={bottomPanel.dx !== 0 || bottomPanel.dy !== 0 || bottomPanel.zoom !== 1}
        url={bottomUrl}
        label={bottomRecord?.label ?? ''}
        state={bottomPanel}
        onChange={setBottomPanel}
      />

      {/* ── Control Bar ─────────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 14px',
        background: '#0f172a',
        borderTop: '1px solid #334155',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: '12px', color: '#64748b' }}>
          Scroll to zoom · Drag to pan · Independent panels
        </span>
        <button
          type="button"
          onClick={handleResetAll}
          style={{
            padding: '5px 14px',
            borderRadius: '6px',
            border: '1px solid #475569',
            background: 'rgba(51,65,85,0.5)',
            color: '#94a3b8',
            fontSize: '12px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          🔄 Reset All
        </button>
      </div>
    </div>
  );
}
