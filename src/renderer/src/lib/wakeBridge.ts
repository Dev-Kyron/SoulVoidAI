/**
 * v1.7.3 — cross-renderer wake-word state sync.
 *
 * Stores are per-renderer in Electron. The wake-word engine runs in the
 * main panel renderer (App.tsx → useWakeWord()), but the only UI to
 * arm/disarm it lives in the Settings window (ArmRow inside WakeWordBody).
 * Without explicit sync, clicking "Arm now" in Settings updates the
 * Settings store but NEVER reaches the main panel — so useWakeWord
 * sees `wakeArmed=false` and the engine never boots. Diagnostic panel
 * shows "Listening for wake word" green dot (a lie — it's Settings's
 * own state) while Scans stays at 0.
 *
 * Fix: every write to a wake-* field in any window calls `relayWakeState`,
 * which round-trips through main and broadcasts to OTHER windows. They
 * mirror the snapshot into their local stores. Both windows converge.
 *
 * Mount `useWakeBroadcastSync()` in both App.tsx (main panel) and
 * SettingsRoot.tsx (Settings window) so each subscribes to incoming
 * snapshots. The subscriber uses raw `setState` (not the named setters)
 * so it doesn't trigger another relay — main's exceptSenderId would
 * skip the source anyway, but it keeps things clean.
 */
import { useEffect } from 'react'
import { vs } from './bridge'
import { useWidgetStore } from '../store/useWidgetStore'

/** Fire-and-forget snapshot relay. Reads current store state and ships
 *  it to main → other renderers. Call AFTER mutating the local store
 *  with one of the wake-* setters. */
export function relayWakeState(): void {
  const w = useWidgetStore.getState()
  void vs.wakeDiagnostic.relay({
    armed: w.wakeArmed,
    listening: w.wakeListening,
    scans: w.wakeScans,
    blockedReason: w.wakeLastBlockedReason,
    heard: w.wakeHeard
  })
}

/** Subscribes the current renderer to incoming wake-state snapshots
 *  from main. Updates the local store via raw setState (no re-relay). */
export function useWakeBroadcastSync(): void {
  useEffect(
    () =>
      vs.events.onWakeDiagnostic((snapshot) => {
        useWidgetStore.setState({
          wakeArmed: snapshot.armed,
          wakeListening: snapshot.listening,
          wakeScans: snapshot.scans,
          wakeLastBlockedReason: snapshot.blockedReason,
          wakeHeard: snapshot.heard
        })
      }),
    []
  )
}
