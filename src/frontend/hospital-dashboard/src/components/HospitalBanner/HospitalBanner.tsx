// HospitalBanner.tsx — Sprint 5 Items 3 & 4 + Sprint 4.1 Stale Data Guard + Sprint 4.4 Sound Toggle
// Item 3: Badge format "ROLE | Full Name" — colored pill (20% opacity bg, border, white text)
// Item 4: Session moved to LEFT (adjacent to hospital name), count+status on RIGHT
// Sprint 4.1: lastSyncAt → "Last sync: HH:MM:SS" + stale indicator after 30s of no data
// Sprint 4.4: 🔔/🔕 mute toggle — Web Audio API notifications opt-in (default muted)

import { useState, useEffect } from 'react'
import type { HospitalId } from '../../types/fhir'
import { ROLE_COLORS } from '../../types/fhir'
import type { SignalRStatus } from '../../hooks/useSignalR'
import type { UserRole } from '../../hooks/useUser'
import { useAudioMute } from '../../utils/audioNotifications'
import styles from './HospitalBanner.module.css'

interface HospitalBannerProps {
  hospitalId: HospitalId
  hospitalLabel: string
  signalRStatus: SignalRStatus
  liveCount: number
  userDisplayLabel?: string
  userRole?: UserRole
  onEndShift?: () => void
  lastSyncAt?: Date | null  // Sprint 4.1: stale data guard
}

export default function HospitalBanner({
  hospitalId,
  hospitalLabel,
  signalRStatus,
  liveCount,
  userDisplayLabel,
  userRole,
  onEndShift,
  lastSyncAt,
}: HospitalBannerProps) {
  const roleColor = userRole ? ROLE_COLORS[userRole] : undefined

  // Sprint 4.4: Sound mute toggle — self-contained (reads/writes localStorage)
  const [isMuted, toggleMute] = useAudioMute()

  // Sprint 4.1: Stale data detection — tracks seconds since last SignalR data event
  const [staleSecs, setStaleSecs] = useState<number | null>(null)

  useEffect(() => {
    const tick = () => {
      if (!lastSyncAt) { setStaleSecs(null); return }
      setStaleSecs(Math.floor((Date.now() - lastSyncAt.getTime()) / 1000))
    }
    tick() // run immediately
    const id = setInterval(tick, 5_000)
    return () => clearInterval(id)
  }, [lastSyncAt])

  // Sprint 4.1: Compute connection dot state (stale overrides SignalR status)
  const isStale     = signalRStatus === 'connected' && staleSecs !== null && staleSecs > 30
  const isVeryStale = isStale && staleSecs! > 60

  const syncLabel = lastSyncAt
    ? lastSyncAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    : null

  const connectionDot = isVeryStale
    ? { label: `Data Stale (${staleSecs}s ago)`, color: '#ef4444' }
    : isStale
    ? { label: `Stale (${staleSecs}s ago)`, color: '#f59e0b' }
    : signalRStatus === 'connected'
    ? { label: 'Live', color: '#22c55e' }
    : signalRStatus === 'reconnecting'
    ? { label: 'Reconnecting…', color: '#f59e0b' }
    : { label: 'Disconnected', color: '#ef4444' }

  // Parse "CHARGE — Jane Doe" → fullName "Jane Doe" for badge
  let badgeLabel = userDisplayLabel ?? ''
  if (userRole && userDisplayLabel) {
    // userDisplayLabel format: "CHARGE — Jane Doe" → extract name after " — "
    const parts = userDisplayLabel.split(' — ')
    const fullName = parts.slice(1).join(' — ')
    badgeLabel = `${userRole} | ${fullName}`
  }

  return (
    <header className={styles.banner}>
      {/* LEFT: Hospital identity + session badge + switch role */}
      <div className={styles.left}>
        <span className={styles.icon}>🏥</span>
        <div className={styles.hospitalInfo}>
          <span className={styles.hospitalName}>{hospitalLabel}</span>
          <span className={styles.hospitalId}>{hospitalId}</span>
        </div>

        {/* Session: role+name badge immediately right of hospital info (Item 4) */}
        {userDisplayLabel && userRole && roleColor && (
          <>
            <span
              className={styles.roleBadge}
              style={{
                color: '#fff',
                borderColor: roleColor,
                backgroundColor: `${roleColor}33`, // 20% opacity
              }}
            >
              {badgeLabel}
            </span>
            {onEndShift && (
              <button
                className={styles.btnSwitchRole}
                onClick={onEndShift}
                title="End shift / Switch role"
              >
                Switch Role
              </button>
            )}
          </>
        )}
      </div>

      {/* RIGHT: Inbound count + connection status */}
      <div className={styles.right}>
        {liveCount > 0 && (
          <div className={styles.liveCountBadge}>
            <span className={styles.liveCountNumber}>{liveCount}</span>
            <span className={styles.liveCountLabel}>Inbound</span>
          </div>
        )}
        {/* Sprint 4.1: connectionDot replaces static status pill — supports stale data state */}
        <span style={{ color: connectionDot.color, fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: connectionDot.color, display: 'inline-block' }} />
          {connectionDot.label}
        </span>
        {syncLabel && (
          <span style={{ fontSize: '11px', color: '#475569', marginLeft: '6px' }}>
            Last sync: {syncLabel}
          </span>
        )}

        {/* Sprint 4.4: Sound mute toggle — 🔔 = sounds ON, 🔕 = muted (default) */}
        <button
          onClick={toggleMute}
          title={isMuted ? 'Notifications muted — click to enable sounds' : 'Sounds enabled — click to mute'}
          style={{
            background: 'none',
            border: `1px solid ${isMuted ? '#334155' : '#F97316'}`,
            borderRadius: '6px',
            color: isMuted ? '#475569' : '#F97316',
            cursor: 'pointer',
            fontSize: '14px',
            padding: '2px 7px',
            lineHeight: 1.4,
            marginLeft: '8px',
            transition: 'border-color 0.15s, color 0.15s',
          }}
        >
          {isMuted ? '🔕' : '🔔'}
        </button>
      </div>
    </header>
  )
}
