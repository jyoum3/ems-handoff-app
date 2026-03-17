/**
 * audioNotifications.ts — Web Audio API Programmatic Tones
 * =========================================================
 * Generates notification sounds using the Web Audio API — no audio files,
 * no network requests, works fully offline inside a PWA.
 *
 * TWO SOUND TYPES:
 *   playChatPing()     — soft double-ping (new EMS chat message)
 *   playHandoffChime() — notification bell chord (new patient / PHI edit)
 *
 * AUTOPLAY POLICY:
 *   AudioContext MUST be created after the first user gesture (browser
 *   autoplay policy). The context is lazily instantiated on the first call
 *   to either play function — by which point the user has already clicked
 *   through the RolePicker, satisfying the gesture requirement.
 *
 * MUTE STATE:
 *   Default: MUTED (opt-in for clinical environments where unexpected audio
 *   is disruptive). Toggle via toggleSoundMuted() or the 🔔/🔕 button in
 *   HospitalBanner. Persists to localStorage key "ems_sounds_muted".
 *   Value "false" = unmuted (sounds ON). Anything else (including absent) = muted.
 *
 * USAGE:
 *   import { playChatPing, playHandoffChime } from '../utils/audioNotifications';
 *   import { useAudioMute } from '../utils/audioNotifications';
 *
 *   // In component or hook callback:
 *   playChatPing();       // fires only if not muted
 *   playHandoffChime();   // fires only if not muted
 *
 *   // In React component for mute toggle:
 *   const [isMuted, toggleMute] = useAudioMute();
 */

import { useState, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MUTE_KEY = 'ems_sounds_muted';

// ---------------------------------------------------------------------------
// AudioContext singleton — lazy, post-gesture creation
// ---------------------------------------------------------------------------

let _audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!_audioCtx || _audioCtx.state === 'closed') {
      _audioCtx = new AudioContext();
    }
    // Resume if suspended (e.g., browser tab backgrounded)
    if (_audioCtx.state === 'suspended') {
      void _audioCtx.resume();
    }
    return _audioCtx;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mute state helpers (non-reactive, for use outside React)
// ---------------------------------------------------------------------------

/** Returns true if sounds are muted. Default: true (muted). */
export function isSoundMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) !== 'false';
  } catch {
    return true; // localStorage unavailable — default to muted
  }
}

/**
 * Toggle mute state. Returns the NEW muted value.
 * Write "false" to localStorage to enable sounds; remove key to mute.
 */
export function toggleSoundMuted(): boolean {
  const currentlyMuted = isSoundMuted();
  try {
    if (currentlyMuted) {
      localStorage.setItem(MUTE_KEY, 'false'); // unmute → sounds ON
    } else {
      localStorage.removeItem(MUTE_KEY); // mute → key absent = muted
    }
  } catch {
    // localStorage unavailable — no-op
  }
  return !currentlyMuted; // return NEW muted state
}

// ---------------------------------------------------------------------------
// Sound: Chat double-ping
// ---------------------------------------------------------------------------

/**
 * playChatPing — two quick sine-wave pings spaced 200ms apart.
 *
 * Sound profile:
 *   Ping 1: 880 Hz (A5), sine, ~150ms with fast attack + exponential decay
 *   Ping 2: 1047 Hz (C6), sine, ~150ms with fast attack + exponential decay
 *   Gap: 200ms between starts (~50ms silence between end of ping 1 and start of ping 2)
 *   Peak volume: 0.16 (quiet — suitable for clinical environment)
 */
export function playChatPing(): void {
  if (isSoundMuted()) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  const t = ctx.currentTime;

  // Ping 1 — A5 (880 Hz)
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.connect(gain1);
  gain1.connect(ctx.destination);
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(880, t);
  gain1.gain.setValueAtTime(0, t);
  gain1.gain.linearRampToValueAtTime(0.16, t + 0.012);
  gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
  osc1.start(t);
  osc1.stop(t + 0.15);

  // Ping 2 — C6 (1047 Hz), starts 200ms after ping 1
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.connect(gain2);
  gain2.connect(ctx.destination);
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(1047, t + 0.2);
  gain2.gain.setValueAtTime(0, t + 0.2);
  gain2.gain.linearRampToValueAtTime(0.16, t + 0.212);
  gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
  osc2.start(t + 0.2);
  osc2.stop(t + 0.35);
}

// ---------------------------------------------------------------------------
// Sound: Handoff notification chord
// ---------------------------------------------------------------------------

/**
 * playHandoffChime — single G-major chord notification bell.
 *
 * Sound profile:
 *   Three sine waves (G4 + B4 + D5 = G major triad), staggered 20ms apart
 *   for a "chord bloom" effect. Duration ~350ms. Peak volume: 0.12 each.
 *   Lower register than the chat ping — sonically distinct.
 *   The stagger gives it a gentle "chime" character vs. a harsh simultaneous hit.
 */
export function playHandoffChime(): void {
  if (isSoundMuted()) return;
  const ctx = getAudioContext();
  if (!ctx) return;

  const t = ctx.currentTime;
  const freqs = [392, 494, 587]; // G4, B4, D5
  const volumes = [0.12, 0.10, 0.08]; // Descending volume for harmonic balance

  freqs.forEach((freq, i) => {
    const delay = i * 0.02; // 20ms stagger per partial
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t + delay);
    gain.gain.setValueAtTime(0, t + delay);
    gain.gain.linearRampToValueAtTime(volumes[i], t + delay + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.35);
    osc.start(t + delay);
    osc.stop(t + delay + 0.35);
  });
}

// ---------------------------------------------------------------------------
// React hook — reactive mute toggle for UI components
// ---------------------------------------------------------------------------

/**
 * useAudioMute — React hook for the 🔔/🔕 mute toggle button.
 *
 * Returns [isMuted: boolean, toggleMute: () => void].
 *   isMuted  — current mute state (true = muted, sounds OFF)
 *   toggleMute — flips mute state, persists to localStorage, triggers re-render
 *
 * @example
 *   const [isMuted, toggleMute] = useAudioMute();
 *   <button onClick={toggleMute}>{isMuted ? '🔕' : '🔔'}</button>
 */
export function useAudioMute(): [boolean, () => void] {
  const [muted, setMuted] = useState<boolean>(() => isSoundMuted());

  const toggle = useCallback(() => {
    const newMuted = toggleSoundMuted();
    setMuted(newMuted);
  }, []);

  return [muted, toggle];
}
