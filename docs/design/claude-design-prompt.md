# Kickoff prompt for Claude Design

Paste the prompt below into Claude Design and attach `ui-design-brief.md` (plus a
screenshot of the running webapp if you have one). The brief is self-contained — no repo
access needed.

---

I'm building **Kuhn**, a web app for scientific and technical writing with integrated AI
agents — think "Google Docs for clinical protocols and grants, with a team of AI research
assistants built in." The attached design brief covers the product, users, flows,
constraints, and the deliverables I want. Read it fully before designing.

The essentials:

- **Users are scientists and medical/regulatory writers** — Word people working on
  high-stakes documents (FDA submissions, NIH grants). The design must read as calm,
  precise, and trustworthy: a serious document tool, not a chat toy.
- **One workspace, three surfaces:** agent chat (left), WYSIWYG markdown editor (center,
  primary), file manager (right), plus a top bar and status bar.
- **The hard design problems** are in the brief's flows: a multi-agent seeding pipeline
  with stage progress and streaming activity; agent questions to the user that expire on
  a countdown; six distinguishable agent identities in chat; slash commands in the editor;
  and AI-suggested edits with accept/reject.
- **Hard constraint:** the app is vanilla TypeScript + CSS — no React. Deliverables must
  be **CSS design tokens and HTML/CSS mockups** I can lift directly into the codebase,
  not just pictures.

Start with **deliverable 1 only** (section 7 of the brief): two or three distinct visual
directions, each with a short rationale and one full-fidelity mockup of the key screen —
the whole workspace mid-seeding (pipeline running, an agent message streaming in, a pending
agent question with a visible countdown, file tree gaining files). Make the directions
genuinely different in personality, not three tints of the same idea. I'll pick one, then
we'll do foundations, remaining screens, and component specs in follow-up rounds.

Before you start, ask me anything that's ambiguous or missing from the brief — but keep it
to questions that would actually change the design.
