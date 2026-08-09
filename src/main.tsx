import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initAuthFromHash } from './auth.ts'

// Capture and persist any passcode in the URL fragment before anything else
// reads it, then strip the fragment from the address bar.
initAuthFromHash()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
