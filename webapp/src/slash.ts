// Slash-command menu (story 016): typing `/` at the start of a block or
// after whitespace opens a filterable command menu at the caret. The command
// registry is frontend-extensible — /cite is the first entry; /write,
// /review etc. (story 017+) register the same way.
//
// Positioning and visibility are handled directly in the plugin view rather
// than via SlashProvider: the provider debounces updates and compares
// against the previous state, which loses keystrokes when the collab plugin
// dispatches follow-up transactions (the debounced call coalesces to a
// no-op and the menu never opens).

import { slashFactory } from '@milkdown/kit/plugin/slash';
import type { PluginSpec } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

export interface SlashCommand {
  /** Name typed after the slash, e.g. 'cite' */
  name: string;
  hint: string;
  /** Invoked after the typed `/...` text has been removed from the document */
  run: (view: EditorView) => void;
}

export const slash = slashFactory('kuhn-commands');

interface SlashMatch {
  /** Document position of the `/` */
  from: number;
  /** Caret position (end of the typed filter) */
  to: number;
  filter: string;
}

/** The `/filter` run before the caret, if the caret sits in one. */
function matchSlashRun(view: EditorView): SlashMatch | null {
  const { $from, empty } = view.state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return null;
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const match = textBefore.match(/(?:^|\s)\/([a-zA-Z]*)$/);
  if (!match) return null;
  const filter = match[1];
  return { from: $from.pos - filter.length - 1, to: $from.pos, filter };
}

/**
 * Build the plugin spec for the slash menu. Set it into the editor with
 * `ctx.set(slash.key, slashMenuSpec(commands))`.
 */
export function slashMenuSpec(commands: SlashCommand[]): PluginSpec<unknown> {
  const menu = document.createElement('div');
  menu.className = 'slash-menu';

  let visible = false;
  let matched: SlashMatch | null = null;
  let items: SlashCommand[] = [];
  let active = 0;
  let activeView: EditorView | null = null;

  const hide = (): void => {
    visible = false;
    active = 0;
    menu.dataset.show = 'false';
  };

  const show = (view: EditorView, atPos: number): void => {
    visible = true;
    menu.dataset.show = 'true';
    const coords = view.coordsAtPos(atPos);
    menu.style.left = `${Math.min(coords.left, window.innerWidth - menu.offsetWidth - 12)}px`;
    menu.style.top = `${Math.min(coords.bottom + 4, window.innerHeight - menu.offsetHeight - 12)}px`;
  };

  const render = (): void => {
    menu.replaceChildren(
      ...items.map((cmd, i) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `slash-item${i === active ? ' active' : ''}`;
        const name = document.createElement('span');
        name.className = 'slash-name';
        name.textContent = `/${cmd.name}`;
        const hint = document.createElement('span');
        hint.className = 'slash-hint';
        hint.textContent = cmd.hint;
        button.append(name, hint);
        // mousedown would blur the editor and dismiss the menu before click
        button.addEventListener('mousedown', (e) => e.preventDefault());
        button.addEventListener('click', () => select(cmd));
        return button;
      }),
    );
  };

  const select = (cmd: SlashCommand): void => {
    const view = activeView;
    if (!view || !matched) return;
    view.dispatch(view.state.tr.delete(matched.from, matched.to));
    hide();
    cmd.run(view);
  };

  const update = (view: EditorView): void => {
    matched = matchSlashRun(view);
    if (!matched) {
      if (visible) hide();
      return;
    }
    items = commands.filter((c) => c.name.startsWith(matched!.filter.toLowerCase()));
    if (items.length === 0) {
      if (visible) hide();
      return;
    }
    active = Math.min(active, items.length - 1);
    render();
    show(view, matched.from);
  };

  // Keep the fixed-position menu pinned to the caret when anything scrolls
  // (the chat log autoscrolls and the editor scrolls the caret into view —
  // hiding on those events would dismiss the menu mid-keystroke)
  const onScroll = (): void => {
    if (visible && activeView && matched) show(activeView, matched.from);
  };

  return {
    view: (editorView) => {
      activeView = editorView;
      hide();
      document.body.append(menu);
      document.addEventListener('scroll', onScroll, true);
      return {
        update: (view) => {
          activeView = view;
          update(view);
        },
        destroy: () => {
          document.removeEventListener('scroll', onScroll, true);
          menu.remove();
          activeView = null;
        },
      };
    },
    props: {
      handleKeyDown: (_view, event) => {
        if (!visible || items.length === 0) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          active = (active + delta + items.length) % items.length;
          render();
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          select(items[active]);
          return true;
        }
        if (event.key === 'Escape') {
          hide();
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        blur: () => {
          // Item mousedown is prevented, so a blur means focus truly left
          hide();
          return false;
        },
      },
    },
  };
}
