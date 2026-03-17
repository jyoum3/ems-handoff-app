/**
 * EmsBanner.tsx — EMS Ingestion PWA: Persistent Top Bar
 * =======================================================
 * Phase 4 Sprint 2.5: Added ALS/BLS unit type pill badge before "Medic #".
 *   ALS → orange-filled pill (#F97316 bg, white text)
 *   BLS → blue-filled pill (#3B82F6 bg, white text)
 */

import { useState, useEffect } from 'react';
import type { EmsSession } from '../../types/fhir';
import type { SignalRConnectionState } from '../../hooks/useEmsSignalR';
import styles from './EmsBanner.module.css';

interface EmsBannerProps {
  session: EmsSession;
  onSwitchShift: () => void;
  /** Real-time SignalR connection state — wired from LiveHandoffView via App.tsx */
  connectionState?: SignalRConnectionState;
  /** Sprint 4.1: timestamp of last received SignalR data event for stale guard */
  lastSyncAt?: Date | null;
}

export default function EmsBanner({ session, onSwitchShift, connectionState, lastSyncAt }: EmsBannerProps) {
  // Sprint 4.1: Stale data detection
  const [staleSecs, setStaleSecs] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => {
      if (!lastSyncAt) { setStaleSecs(null); return; }
      setStaleSecs(Math.floor((Date.now() - lastSyncAt.getTime()) / 1000));
    };
    tick();
    const id = setInterval(tick, 5_000);
    return () => clearInterval(id);
  }, [lastSyncAt]);

  const isStale     = connectionState === 'live' && staleSecs !== null && staleSecs > 30;
  const isVeryStale = isStale && staleSecs! > 60;

  const syncLabel = lastSyncAt
    ? lastSyncAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    : null;

  const connectionDot = isVeryStale
    ? { label: `Data Stale (${staleSecs}s ago)`, color: '#ef4444' }
    : isStale
    ? { label: `Stale (${staleSecs}s ago)`, color: '#f59e0b' }
    : connectionState === 'live'
    ? { label: 'Live', color: '#22c55e' }
    : connectionState === 'reconnecting'
    ? { label: 'Reconnecting', color: '#f59e0b' }
    : connectionState === 'disconnected'
    ? { label: 'Disconnected', color: '#ef4444' }
    : { label: 'Connecting', color: '#eab308' };
  const unitTypeBg = session.medicUnitType === 'ALS' ? '#F97316' : '#3B82F6';

  return (
    <header className={styles.banner}>
      {/* ── Left: Crew Identity ─────────────────────────────────────── */}
      <div className={styles.left}>
        {/* ALS/BLS pill badge */}
        {session.medicUnitType && (
          <span
            className={styles.unitTypePill}
            style={{ background: unitTypeBg }}
          >
            {session.medicUnitType}
          </span>
        )}
        <span className={styles.unitBadge}>
          Medic #{session.medicUnit}
        </span>
        <span className={styles.separator}>|</span>
        <span className={styles.medicName}>{session.medicName}</span>
      </div>

      {/* ── Center: Real-time connection status + stale guard (Sprint 4.1) ── */}
      <div className={styles.center}>
        {connectionState && (
          <span className={styles.wsIndicator}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: connectionDot.color, display: 'inline-block', flexShrink: 0 }} />
            <span className={styles.wsLabel} style={{ color: connectionDot.color }}>
              {connectionDot.label}
            </span>
            {syncLabel && (
              <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '6px' }}>
                Last sync: {syncLabel}
              </span>
            )}
          </span>
        )}
      </div>

      {/* ── Right: Phone + Switch Shift ─────────────────────────────── */}
      <div className={styles.right}>
        <span className={styles.phone}>
          📞 {session.medicPhone}
        </span>
        <button
          type="button"
          className={styles.btnSwitch}
          onClick={onSwitchShift}
          title="End current shift and start a new session"
        >
          Switch Shift
        </button>
      </div>
    </header>
  );
}
