import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { SettingsRoot } from './SettingsRoot'
import { ClickPreviewRoot } from './ClickPreviewRoot'
import './index.css'

/**
 * One renderer entry serves three windows:
 *  · default          → the main floating widget (orb + panel)
 *  · ?view=settings   → the de-docked Settings window
 *  · ?view=click-preview → v1.8.0 transparent overlay for vision-guided
 *                          click confirmation. Loaded by clickPreview.ts
 *                          with token + description + countdown in the
 *                          query string.
 *
 * Keeps build artefacts simple (single HTML, single bundle entry) while
 * letting the three surfaces diverge cleanly.
 */
const params = new URLSearchParams(window.location.search)
const view = params.get('view')

const Root =
  view === 'settings' ? (
    <SettingsRoot />
  ) : view === 'click-preview' ? (
    <ClickPreviewRoot />
  ) : (
    <App />
  )

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{Root}</React.StrictMode>
)
