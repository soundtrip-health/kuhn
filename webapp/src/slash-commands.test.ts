// Feature-guide coverage (issue #170): every slash command the editor accepts
// must be documented in docs/features/, so a new command fails CI until the
// guide explains it. The backend half of this contract (agents, front-matter
// keys) lives in agent-backend/src/db/guide.test.js.

import { describe, expect, it } from 'vitest';

import { SLASH_COMMANDS } from './slash-commands';

// Vite's glob import (no node types in this package): every guide page as raw text.
const GUIDE_PAGES = import.meta.glob('../../docs/features/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function guideText(): string {
  return Object.entries(GUIDE_PAGES)
    .filter(([path]) => !path.endsWith('/README.md'))
    .map(([, text]) => text)
    .join('\n');
}

describe('slash-command registry', () => {
  it('has unique names that match their labels', () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of SLASH_COMMANDS) expect(c.name).toBe(c.label.toLowerCase());
  });

  it('is fully documented in the feature guide', () => {
    const text = guideText();
    for (const c of SLASH_COMMANDS) {
      expect(text.includes(`\`/${c.name}\``), `/${c.name} is documented in docs/features/`).toBe(true);
    }
  });
});
