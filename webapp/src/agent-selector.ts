// Agent-selector pill (story 025): replaces the native <select> in the chat
// input with a colored-dot pill + popover. The hidden <select id="chat-role">
// stays in the DOM and remains the source of truth — chat.ts reads its
// `.value`, so this only mirrors the selection into it.

import { agentIdentity, selectableAgents, type AgentIdentity } from './agents';
import { icon } from './icons';

export function initAgentSelector(): void {
  const select = document.getElementById('chat-role') as HTMLSelectElement | null;
  const button = document.getElementById('agent-selector-btn');
  const menu = document.getElementById('agent-selector-menu');
  if (!select || !button || !menu) return;

  const setValue = (slug: string): void => {
    select.value = slug;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    renderButton(button, agentIdentity(slug));
    renderMenu(menu, slug, setValue, close);
  };

  const close = (): void => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  const open = (): void => {
    renderMenu(menu, select.value, setValue, close);
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    (menu.querySelector('.agent-option.active') as HTMLElement | null)?.focus();
  };

  button.addEventListener('click', (e) => {
    e.preventDefault();
    menu.hidden ? open() : close();
  });
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); open(); }
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !button.contains(e.target as Node) && !menu.contains(e.target as Node)) close();
  });

  renderButton(button, agentIdentity(select.value));
}

function renderButton(button: HTMLElement, agent: AgentIdentity): void {
  button.style.setProperty('--role', `var(${agent.colorVar})`);
  button.innerHTML =
    `<span class="dot"></span><span class="agent-pill-label">${agent.label}</span>${icon('chevron-down', { size: 11, stroke: 2 })}`;
}

function renderMenu(
  menu: HTMLElement,
  current: string,
  onPick: (slug: string) => void,
  close: () => void,
): void {
  menu.replaceChildren(
    ...selectableAgents().map((agent) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = `agent-option${agent.slug === current ? ' active' : ''}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(agent.slug === current));
      option.style.setProperty('--role', `var(${agent.colorVar})`);
      const dot = document.createElement('span');
      dot.className = 'dot';
      const label = document.createElement('span');
      label.textContent = agent.label;
      option.append(dot, label);
      option.addEventListener('click', () => { onPick(agent.slug); close(); });
      return option;
    }),
  );
  // Arrow-key navigation within the open menu
  menu.onkeydown = (e: KeyboardEvent) => {
    const options = [...menu.querySelectorAll<HTMLElement>('.agent-option')];
    const idx = options.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); options[Math.min(idx + 1, options.length - 1)]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); options[Math.max(idx - 1, 0)]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
}
