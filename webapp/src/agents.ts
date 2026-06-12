// Agent identities (story 025). The single source of truth for an agent's
// display label, two-letter avatar initials, and role color token. Role color
// is applied ONLY to the currently active/speaking agent (chat spine, avatar,
// name, dot; doc writer spine) — every idle agent renders neutral ink. The
// color-discipline rule from the design handoff.

export interface AgentIdentity {
  slug: string;
  /** Full display name, e.g. "Research" */
  label: string;
  /** Two-letter avatar initials, e.g. "Re" */
  initials: string;
  /** CSS custom-property name carrying the role color, e.g. "--ra" */
  colorVar: string;
}

const AGENTS: Record<string, AgentIdentity> = {
  pm: { slug: 'pm', label: 'PM', initials: 'PM', colorVar: '--pm' },
  writer: { slug: 'writer', label: 'Writer', initials: 'Wr', colorVar: '--writer' },
  ra: { slug: 'ra', label: 'Research', initials: 'Re', colorVar: '--ra' },
  advisor: { slug: 'advisor', label: 'Advisor', initials: 'Ad', colorVar: '--advisor' },
  reviewer: { slug: 'reviewer', label: 'Reviewer', initials: 'Rv', colorVar: '--reviewer' },
  analyst: { slug: 'analyst', label: 'Analyst', initials: 'An', colorVar: '--analyst' },
};

const FALLBACK: AgentIdentity = { slug: '', label: '', initials: '··', colorVar: '--ink-3' };

/** Identity for an agent slug; a neutral fallback for unknown slugs. */
export function agentIdentity(slug: string): AgentIdentity {
  const known = AGENTS[slug];
  if (known) return known;
  const label = slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : '';
  return { ...FALLBACK, slug, label, initials: label.slice(0, 2) || '··' };
}

/** Ordered list of selectable agents for the chat input pill. */
export function selectableAgents(): AgentIdentity[] {
  return Object.values(AGENTS);
}
