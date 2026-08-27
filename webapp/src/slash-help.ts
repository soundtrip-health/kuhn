// "/ commands" help popover (STH-38): the sub-header chip opens a list of the
// slash commands the editor accepts — name, owning agent, one-line description
// — sourced from the same registry that feeds Crepe's block-edit menu
// (editor.ts agentCommands), so the two can't drift apart. Same button+menu
// idiom as agent-selector.ts.

import { agentIdentity } from './agents';
import { slashCommandCatalog } from './editor';

export function initSlashHelp(): void {
  const button = document.getElementById('slash-help-btn');
  const menu = document.getElementById('slash-help-menu');
  if (!button || !menu) return;

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

function renderMenu(menu: HTMLElement): void {
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

  const hint = document.createElement('p');
  hint.className = 'slash-help-hint';
  hint.textContent = 'Type / at the start of a line to use a command; block formatting (headings, lists, …) lives in the same menu.';

  menu.replaceChildren(...rows, hint);
}
