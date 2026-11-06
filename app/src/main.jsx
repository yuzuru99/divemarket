import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// near-api-js expects a node-style Buffer at module scope. Without this the
// bundle throws on load and React never mounts -- a blank page with no
// visible error.
import { Buffer } from 'buffer';
window.Buffer = Buffer;
import App from './App.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
