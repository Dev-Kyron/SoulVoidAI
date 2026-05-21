import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { SettingsRoot } from './SettingsRoot'
import './index.css'

/**
 * One renderer entry serves two windows. The main floating widget loads as
 * normal; the dedicated Settings window is opened with `?view=settings` and
 * mounts a full-window layout instead of the orb. Keeps build artefacts
 * simple (single HTML, single bundle entry) while letting the two surfaces
 * diverge cleanly.
 */
const params = new URLSearchParams(window.location.search)
const view = params.get('view')

const Root = view === 'settings' ? <SettingsRoot /> : <App />

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{Root}</React.StrictMode>
)
