// Slash-command registry data (issue #170 split it out of editor.ts so the
// help popover, the Crepe block-edit menu and the feature-guide coverage test
// (slash-commands.test.ts) all read one list without importing the editor).
// `name` is what the user types after "/"; `label` is the menu caption.
// Commands with `implemented: false` only announce the routing today.

export interface SlashCommandSpec {
  name: string;
  label: string;
  agent: string;
  description: string;
  implemented: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { name: 'cite', label: 'Cite', agent: 'ra', description: 'Search PubMed & insert a citation', implemented: true },
  { name: 'write', label: 'Write', agent: 'writer', description: 'Writer drafts text right here', implemented: true },
  { name: 'research', label: 'Research', agent: 'ra', description: 'Ask Research a question', implemented: false },
  { name: 'figure', label: 'Figure', agent: 'analyst', description: 'Analyst makes a figure or table', implemented: false },
  { name: 'review', label: 'Review', agent: 'reviewer', description: 'Reviewer critiques this section', implemented: false },
  { name: 'ask', label: 'Ask', agent: 'pm', description: 'Ask any agent inline', implemented: false },
  { name: 'status', label: 'Status', agent: 'pm', description: 'What is the team doing?', implemented: false },
];
