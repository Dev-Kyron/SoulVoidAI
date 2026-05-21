/**
 * Tracks whether the app is genuinely quitting versus merely closing the
 * window to the system tray. The tray "Quit" item is the only thing that
 * flips this flag.
 */
let quitting = false

export function beginQuit(): void {
  quitting = true
}

export function isQuitting(): boolean {
  return quitting
}
