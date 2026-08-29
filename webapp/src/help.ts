// Help popover (STH-38, widened here): the topbar "?" button opens a short
// guide to the editor — how rich-text editing works, what the panels do —
// plus the list of slash commands the editor accepts (name, owning agent,
// one-line description), sourced from the same registry that feeds Crepe's
// block-edit menu (editor.ts agentCommands) so the two can't drift apart.
// Same button+menu idiom as agent-selector.ts and user-menu.ts.

import { agentIdentity } from './agents';
import { slashCommandCatalog } from './editor';
import { icon } from './icons';

const MOD = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl';

export function initHelp(): void {
  const button = document.getElementById('help-btn');
  const menu = document.getElementById('help-menu');
  if (!button || !menu) return;
  button.innerHTML = icon('help-circle', { size: 17, stroke: 1.8 });

  const close = (): void => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  const open = (): void => {
    renderMenu(menu);
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  };

  button.addEventListener('click', (e) => {
    e.preventDefault();
    menu.hidden ? open() : close();
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !button.contains(e.target as Node) && !menu.contains(e.target as Node)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) close();
  });
}

function heading(text: string): HTMLElement {
  const h = document.createElement('h4');
  h.className = 'help-heading';
  h.textContent = text;
  return h;
}

/** A "what → how" row; `how` may carry <kbd> markup. */
function tip(what: string, howHtml: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'help-tip';
  const label = document.createElement('span');
  label.className = 'help-tip-what';
  label.textContent = what;
  const how = document.createElement('span');
  how.className = 'help-tip-how';
  how.innerHTML = howHtml;
  row.append(label, how);
  return row;
}

const kbd = (k: string): string => `<kbd>${k}</kbd>`;

function renderMenu(menu: HTMLElement): void {
  const editing = [
    heading('Editing'),
    tip('Format as you type', `Markdown shortcuts: ${kbd('#')} heading, ${kbd('-')} list, ${kbd('**bold**')}, ${kbd('\`code\`')}, ${kbd('$math$')}. Select text for the formatting toolbar.`),
    tip('Blocks & commands', `Type ${kbd('/')} at the start of a line — headings, lists, tables, and the agent commands below.`),
    tip('Saving', `Edits autosave. ${kbd(`${MOD}+S`)} saves a named version you can restore from <em>History</em>.`),
    tip('Citations', `${kbd('/cite')} inserts a reference from the project's <code>references.bib</code>; hover a citation to see its details.`),
    tip('Comments', `Select text and open <em>Comments</em> to leave a margin note. <em>Source</em> shows the raw markdown.`),
    tip('Agent edits', `Suggestions from agents appear as diffs in the document — approve or reject each one.`),
  ];

  const rows = slashCommandCatalog().map((cmd) => {
    const agent = agentIdentity(cmd.agent);
    const row = document.createElement('div');
    row.className = 'slash-help-row';
    const name = document.createElement('code');
    name.className = 'slash-help-name';
    name.textContent = cmd.name;
    const desc = document.createElement('span');
    desc.className = 'slash-help-desc';
    desc.textContent = cmd.description;
    const who = document.createElement('span');
    who.className = 'slash-help-agent';
    who.style.setProperty('--role', `var(${agent.colorVar})`);
    const dot = document.createElement('span');
    dot.className = 'dot';
    who.append(dot, agent.label);
    row.append(name, desc, who);
    return row;
  });

  const panels = [
    heading('Around the document'),
    tip('Chat', `Talk to an agent — pick who answers with the selector in the chat box. Agents can ask you questions mid-task.`),
    tip('Files', `The project tree. A count on the button means files changed since you last looked.`),
    tip('Preview PDF', `Renders the open document with citations resolved; <em>Export</em> gives Word or LaTeX.`),
    tip('Where am I', `The breadcrumb shows organization / project / document — each part is clickable.`),
  ];

  menu.replaceChildren(...editing, heading('Slash commands'), ...rows, ...panels);
}
