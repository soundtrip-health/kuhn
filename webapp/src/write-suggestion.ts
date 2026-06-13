// `/write` streamed suggestion (story 017). The writer agent drafts a passage
// in an in-document **suggestion block** that the user accepts or rejects.
//
// Architecture (story 017 decisions):
//  1. The suggestion lives OUTSIDE the document until accepted. It renders as a
//     ProseMirror **widget decoration** (this plugin), not as doc content — so
//     un-accepted text never hits Yjs, autosave, or undo history. The anchor is
//     a mapped decoration position, so edits elsewhere don't misplace it.
//  2. Stream as plain text; parse on accept. During streaming the raw text is
//     shown (cheap, robust to partial markdown). Accept parses the full string
//     into a slice (parserCtx, via `toSlice`) and inserts it in one transaction;
//     the collab plugin + debounced save persist it — no extra writeTextFile.
//  3. Compose mode: the task runs with `compose: true` so the writer returns
//     text and performs no file writes (enforced by the runtime tool filter).
//
// One suggestion is active at a time; starting another dismisses the first.

import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorState, Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Slice } from '@milkdown/kit/prose/model';

import { runAgentTask, type AgentEvent } from './api';
import { icon } from './icons';
import { addTokenUsage, setAgentActivity } from './status';
import { toast } from './toast';

const key = new PluginKey<DecorationSet>('kuhn-write-suggestion');
const WIDGET_KEY = 'kuhn-write-suggestion';

type Meta = { type: 'set'; deco: Decoration } | { type: 'clear' };

/**
 * Decoration-set plugin holding the (at most one) suggestion widget. The widget
 * DOM is owned by a Suggestion controller; the plugin only remaps its position
 * across concurrent edits (decision 1: anchor drift). Spread into Editor.use().
 */
export const writeSuggestionPlugin = $prose(
  () =>
    new Plugin<DecorationSet>({
      key,
      state: {
        init: () => DecorationSet.empty,
        apply(tr: Transaction, set: DecorationSet): DecorationSet {
          const meta = tr.getMeta(key) as Meta | undefined;
          if (meta?.type === 'set') return DecorationSet.create(tr.doc, [meta.deco]);
          if (meta?.type === 'clear') return DecorationSet.empty;
          return set.map(tr.mapping, tr.doc);
        },
      },
      props: {
        decorations: (state: EditorState) => key.getState(state),
      },
    }),
);

export interface WriteOptions {
  projectId: number;
  path: string;
  /** Parse accepted markdown into a slice (parserCtx-backed; see editor.ts). */
  toSlice: (markdown: string) => Slice;
  /** Continue / record the in-session writer SDK session for follow-ups. */
  getSession: () => string | undefined;
  setSession: (id: string) => void;
}

let active: Suggestion | null = null;

/** Open a `/write` suggestion block at the caret and await the instruction. */
export function startWrite(view: EditorView, opts: WriteOptions): void {
  active?.dismiss();
  active = new Suggestion(view, opts);
  active.mount();
}

type Phase = 'prompt' | 'streaming' | 'done' | 'error';

interface EditorContext {
  heading: string | null;
  selection: string;
  nearby: string;
  line: number;
}

const prefersReducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

class Suggestion {
  private readonly dom: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly noteEl: HTMLElement;
  private readonly errorMsgEl: HTMLElement;

  private readonly view: EditorView;
  private readonly opts: WriteOptions;
  private readonly ctx: EditorContext;
  private phase: Phase = 'prompt';
  private instruction = '';
  private text = '';
  private revealed = 0;
  private revealTimer: number | null = null;
  private abort: AbortController | null = null;
  // Esc cancels while the suggestion is being composed or streamed; bound at
  // the document level so it fires even when the (hidden) input lacks focus.
  private readonly onDocKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && (this.phase === 'prompt' || this.phase === 'streaming')) {
      e.preventDefault();
      this.dismiss();
    }
  };

  constructor(view: EditorView, opts: WriteOptions) {
    this.view = view;
    this.opts = opts;
    this.ctx = this.gatherContext();
    const section = this.ctx.heading ? `§ ${this.ctx.heading}` : 'the current section';

    this.dom = document.createElement('div');
    this.dom.className = 'write-suggestion';
    this.dom.dataset.phase = 'prompt';
    this.dom.setAttribute('contenteditable', 'false');

    const eyebrow = document.createElement('div');
    eyebrow.className = 'ws-eyebrow';
    eyebrow.innerHTML = `<span class="ws-dot"></span><span class="ws-eyebrow-text">Writer · Suggested edit</span>`;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ws-close';
    close.title = 'Dismiss';
    close.innerHTML = icon('x', { size: 14, stroke: 2 });
    close.addEventListener('mousedown', (e) => e.preventDefault());
    close.addEventListener('click', () => this.dismiss());
    eyebrow.append(close);

    // Prompt phase: inline instruction input (keeps the flow in-document).
    this.input = document.createElement('input');
    this.input.className = 'ws-input';
    this.input.type = 'text';
    this.input.placeholder = 'What should the writer draft?';
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit();
      }
      // Escape is handled by the document-level listener (it must also fire
      // while streaming, when this input is hidden).
    });
    const prompt = document.createElement('div');
    prompt.className = 'ws-prompt';
    prompt.append(this.input);

    // Streaming / done phase: the suggested text + a blinking caret (CSS).
    this.textEl = document.createElement('div');
    this.textEl.className = 'ws-text';
    const caret = document.createElement('span');
    caret.className = 'ws-caret';
    this.textEl.append(caret); // caret stays after the text node; CSS hides it off-stream

    // Action row (done).
    const actions = document.createElement('div');
    actions.className = 'ws-actions';
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'ws-accept btn btn-accent';
    accept.innerHTML = `${icon('check', { size: 14, stroke: 2.2 })}Accept`;
    accept.addEventListener('mousedown', (e) => e.preventDefault());
    accept.addEventListener('click', () => this.accept());
    const reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'ws-reject btn btn-ghost';
    reject.textContent = 'Reject';
    reject.addEventListener('mousedown', (e) => e.preventDefault());
    reject.addEventListener('click', () => this.reject());
    this.noteEl = document.createElement('span');
    this.noteEl.className = 'ws-note';
    this.noteEl.textContent = `Writer drafted from ${section} context`;
    actions.append(accept, reject, this.noteEl);

    // Error row.
    const errorRow = document.createElement('div');
    errorRow.className = 'ws-error';
    this.errorMsgEl = document.createElement('span');
    this.errorMsgEl.className = 'ws-error-msg';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'ws-retry btn btn-ghost';
    retry.textContent = 'Retry';
    retry.addEventListener('mousedown', (e) => e.preventDefault());
    retry.addEventListener('click', () => this.runTask());
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'ws-dismiss btn btn-ghost';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('mousedown', (e) => e.preventDefault());
    dismiss.addEventListener('click', () => this.dismiss());
    errorRow.append(this.errorMsgEl, retry, dismiss);

    this.dom.append(eyebrow, prompt, this.textEl, actions, errorRow);
  }

  // ---- mount / position -----------------------------------------------------

  mount(): void {
    const pos = this.anchorPos();
    const deco = Decoration.widget(pos, this.dom, {
      key: WIDGET_KEY,
      side: 1,
      ignoreSelection: true,
      // The block hosts its own inputs/buttons — keep every event out of PM.
      stopEvent: () => true,
    });
    this.view.dispatch(this.view.state.tr.setMeta(key, { type: 'set', deco }));
    document.addEventListener('keydown', this.onDocKey, true);
    // Focus after PM has rendered the widget into the DOM.
    requestAnimationFrame(() => this.input.focus());
  }

  /** Anchor at the boundary after the caret's top-level block (renders in-flow). */
  private anchorPos(): number {
    const { $from } = this.view.state.selection;
    const size = this.view.state.doc.content.size;
    if ($from.depth === 0) return Math.min($from.pos, size);
    return Math.min($from.after(1), size);
  }

  /** The live (mapped) widget position, or null once it has been cleared. */
  private currentPos(): number | null {
    const found = key.getState(this.view.state)?.find();
    return found && found.length ? found[0].from : null;
  }

  // ---- task lifecycle -------------------------------------------------------

  private submit(): void {
    const value = this.input.value.trim();
    if (!value) return;
    this.instruction = value;
    void this.runTask();
  }

  private async runTask(): Promise<void> {
    this.setPhase('streaming');
    this.text = '';
    this.revealed = 0;
    this.renderText();
    this.abort = new AbortController();
    setAgentActivity('Writer is drafting…');

    try {
      await runAgentTask(
        {
          role: 'writer',
          projectId: this.opts.projectId,
          input: this.buildInput(),
          sessionId: this.opts.getSession(),
          context: {
            selection: this.ctx.selection || undefined,
            cursor: { line: this.ctx.line },
            files: [this.opts.path],
          },
          compose: true,
        },
        (event) => this.onEvent(event),
        this.abort.signal,
      );
      this.finalizeStream();
    } catch (err) {
      if (this.abort?.signal.aborted) return; // user cancelled — block already gone
      this.showError((err as Error).message || 'The writer task failed.');
    } finally {
      setAgentActivity('');
    }
  }

  private onEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'text_delta':
        this.text += event.content ?? '';
        this.scheduleReveal();
        break;
      case 'text':
        // Finalized turn text replaces the streamed deltas (mirrors chat.ts).
        this.text = event.content ?? this.text;
        this.scheduleReveal();
        break;
      case 'done':
        if (event.sessionId) this.opts.setSession(event.sessionId);
        if (event.usage) addTokenUsage(event.usage);
        this.finalizeStream();
        break;
      case 'error':
        this.showError(event.message ?? 'The writer reported an error.');
        break;
      // file_change/citation must not occur in compose mode — ignore defensively.
    }
  }

  private buildInput(): string {
    const parts = [this.instruction];
    const ctxLines: string[] = [];
    if (this.ctx.heading) ctxLines.push(`Current section: ${this.ctx.heading}`);
    if (this.ctx.selection) ctxLines.push(`Selected text:\n${this.ctx.selection}`);
    else if (this.ctx.nearby) ctxLines.push(`Surrounding text:\n${this.ctx.nearby}`);
    if (ctxLines.length) parts.push(`<context>\n${ctxLines.join('\n\n')}\n</context>`);
    parts.push(
      'Return ONLY the markdown passage to insert at the cursor — no preamble, no ' +
        'explanation, no surrounding code fences. Do not edit any files.',
    );
    return parts.join('\n\n');
  }

  // ---- reveal animation -----------------------------------------------------

  private scheduleReveal(): void {
    if (prefersReducedMotion()) {
      this.revealed = this.text.length;
      this.renderText();
      return;
    }
    if (this.revealTimer != null) return;
    const step = (): void => {
      this.revealTimer = null;
      if (this.revealed >= this.text.length) return;
      this.revealed = Math.min(this.text.length, this.revealed + 2);
      this.renderText();
      if (this.revealed < this.text.length) this.revealTimer = window.setTimeout(step, 18);
    };
    this.revealTimer = window.setTimeout(step, 18);
  }

  private renderText(): void {
    // textContent of the first child text node; the caret span is preserved.
    const caret = this.textEl.querySelector('.ws-caret');
    this.textEl.textContent = this.text.slice(0, this.revealed);
    if (caret) this.textEl.append(caret);
  }

  private finalizeStream(): void {
    if (this.phase !== 'streaming') return;
    this.clearRevealTimer();
    this.revealed = this.text.length;
    this.renderText();
    if (!this.text.trim()) {
      this.showError('The writer returned an empty suggestion.');
      return;
    }
    this.setPhase('done');
  }

  // ---- accept / reject / error ----------------------------------------------

  private accept(): void {
    const pos = this.currentPos();
    if (pos == null) {
      this.cleanup();
      return;
    }
    let slice: Slice;
    try {
      slice = this.opts.toSlice(this.text.trim());
    } catch {
      this.showError('Could not parse the suggestion into the document.');
      return;
    }
    // One transaction: insert the parsed nodes and drop the widget. The collab
    // plugin syncs it to Yjs and the debounced save persists it (decision 2).
    const tr = this.view.state.tr.replace(pos, pos, slice);
    tr.setMeta(key, { type: 'clear' });
    this.view.dispatch(tr.scrollIntoView());
    this.flashInserted(pos);
    this.detach();
    toast('Suggestion accepted');
    this.view.focus();
  }

  private reject(): void {
    this.cleanup();
    this.view.focus();
  }

  /** Cancel from outside (new /write, Esc, ✕): abort any task and drop the block. */
  dismiss(): void {
    this.abort?.abort();
    this.cleanup();
    this.view.focus();
  }

  private showError(message: string): void {
    this.clearRevealTimer();
    this.errorMsgEl.textContent = message;
    this.setPhase('error');
  }

  /** Highlight the freshly inserted block (fade-and-rise; reduced-motion safe). */
  private flashInserted(pos: number): void {
    if (prefersReducedMotion()) return;
    try {
      const { node } = this.view.domAtPos(pos + 1);
      const el = (node.nodeType === 1 ? node : node.parentElement) as HTMLElement | null;
      const block = el?.closest('.milkdown > * > *, .milkdown > *') ?? el;
      if (block instanceof HTMLElement) {
        block.classList.add('ws-inserted');
        window.setTimeout(() => block.classList.remove('ws-inserted'), 360);
      }
    } catch {
      /* best-effort entrance animation */
    }
  }

  // ---- helpers --------------------------------------------------------------

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.dom.dataset.phase = phase;
  }

  private clearRevealTimer(): void {
    if (this.revealTimer != null) {
      clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
  }

  /** Drop the widget decoration (if still present) and release the singleton. */
  private cleanup(): void {
    if (this.currentPos() != null) {
      this.view.dispatch(this.view.state.tr.setMeta(key, { type: 'clear' }));
    }
    this.detach();
  }

  private detach(): void {
    this.clearRevealTimer();
    document.removeEventListener('keydown', this.onDocKey, true);
    if (active === this) active = null;
  }

  private gatherContext(): EditorContext {
    const state = this.view.state;
    const { from, to, $from } = state.selection;
    const selection = from !== to ? state.doc.textBetween(from, to, '\n', '\n') : '';

    // Nearest heading at or before the caret's top-level block.
    const caretTop = $from.depth >= 1 ? $from.before(1) : 0;
    let heading: string | null = null;
    state.doc.forEach((child, offset) => {
      if (offset <= caretTop && child.type.name === 'heading') heading = child.textContent;
    });

    // Current top-level block plus its predecessor, for compose context.
    const index = $from.index(0);
    const current = state.doc.maybeChild(index)?.textContent ?? '';
    const previous = index > 0 ? state.doc.maybeChild(index - 1)?.textContent ?? '' : '';
    const nearby = [previous, current].filter(Boolean).join('\n\n').slice(0, 600);

    const line = state.doc.textBetween(0, from, '\n', '\n').split('\n').length;
    return { heading, selection, nearby, line };
  }
}
