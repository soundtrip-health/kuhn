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
  events over SSE); follow-ups continue the same SDK session per role. Agents
  can ask questions mid-task (story 012): the input box switches to answer mode
  and exits it visibly if the question times out or the task ends (story 020).
  On reload the panel restores the recent transcript from the conversation log
  and resumes each agent's SDK session.
- **Seed project** (topbar button, story 015) — runs the seeding pipeline: PM
  interview (answered in the chat), RA + Advisor research in parallel, Writer
  skeleton draft. Stage progress is narrated as system lines.
- **Files** — project tree from the storage API; `.md` files open in the editor.
  Upload/preview lands with story 014.
- **Preview & export** (topbar Preview button, story 019) — PDF preview pane of
  the open document (rendered on the backend: markdown → Typst → PDF, citations
  resolved against `references.bib`), plus `.docx`/`.tex` download buttons.
  Compile errors show in the pane's status line. Needs the Typst/Pandoc Docker
  images (see ../agent-backend/README.md).
- On first run with an empty database the app creates a "Demo Manuscript"
  project through the API.

Browser smoke tests (need backend + webapp running; `smoke:chat` spends a few
agent tokens):

```bash
npm run smoke        # load, edit, debounced save persists, two-page collab sync
npm run smoke:chat   # live agent round-trip through the chat UI
node scripts/cite-check.mjs    # slash menu → /cite picker → chip → bib round-trip (no tokens)
node scripts/render-check.mjs  # PDF render, docx/tex export, error surface (no tokens)
node scripts/reload-check.mjs  # reload against a warm Yjs room: no errors, no lost edits (no tokens)
node scripts/collab-check.mjs  # two-page collab sync (no tokens)
```

Live verification scripts for story 022 (expensive — they drive real Opus/Haiku
agent runs; run deliberately, see the story for details):

```bash
node scripts/reload-resume-check.mjs   # transcript restore + session resume after a mid-interview reload
node scripts/seed-check.mjs            # full seeding pipeline with canned interview answers
```
