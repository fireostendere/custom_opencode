# Web production rollback — 2026-08-30

Incident: the access-fix merge changed the production web shell, authentication path and PWA cache without a real browser-to-live-backend E2E acceptance gate.

Emergency action: restore only `app/server.py`, `app/index.html` and `app/sw.js` to the last pre-access-fix state (`d24c1ea0288459b223a212df514f9f935d794dfb`). Runtime V3, RAG integration, model routing and later TUI changes remain intact.

This is an availability rollback, not acceptance of the reverted UX as final. Reintroduction of access-fix/auth/appearance changes requires a live E2E gate covering login/auth, session list/open, send/response, permission reply, queue/cancel and reload/PWA behavior.
