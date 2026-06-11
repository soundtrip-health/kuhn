# Kuhn Webapp

Single-app frontend (story 013): agent chat, Milkdown WYSIWYG markdown editor,
and a file panel, talking to the agent backend.

```bash
# prerequisites: agent backend running (see ../agent-backend/README.md)
npm install
npm run dev        # http://localhost:5174 (pinned; backend CORS allows it)
```

- **Editor** — Milkdown (commonmark + GFM + math), loads/saves `draft/main.md`
  of the active project via the storage API (debounced + Cmd/Ctrl+S), bound to
  the backend y-websocket room for real-time collab.
- **Chat** — pick an agent role, stream replies token-by-token (`text_delta`
  events over SSE); follow-ups continue the same SDK session per role.
- **Files** — project tree from the storage API; `.md` files open in the editor.
  Upload/preview lands with story 014.
- On first run with an empty database the app creates a "Demo Manuscript"
  project through the API.

Browser smoke tests (need backend + webapp running; `smoke:chat` spends a few
agent tokens):

```bash
npm run smoke        # load, edit, debounced save persists, two-page collab sync
npm run smoke:chat   # live agent round-trip through the chat UI
```
