# Story 001: Survey Candidate Projects

**Status:** ready
**Epic:** [001 — Editor Foundation Research](../index.md)
**Estimate:** M

## Goal

Identify all viable open-source browser-based LaTeX/Typst editor projects and produce a comparison matrix covering our key decision factors.

## Acceptance Criteria

- [ ] At least 5 candidates identified and briefly evaluated
- [ ] Comparison matrix created covering: license, features, Typst support, extensibility, compilation model, community activity
- [ ] Known candidates include: TeXlyre, BusyIDE/BusyTeX, Overleaf CE, SwiftLaTeX, and any others found
- [ ] Also evaluate "build from primitives" approach (CodeMirror 6 + custom)
- [ ] Top 2-3 candidates identified for deeper investigation

## Notes

- Start with GitHub search, awesome-latex lists, and web search
- Check npm/PyPI for relevant packages (e.g., CodeMirror LaTeX modes)
- Note last commit date and contributor count as community health signals
- Typst is newer so native support will be rare — assess how hard it would be to add
