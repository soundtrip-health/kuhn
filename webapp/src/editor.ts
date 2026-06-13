// Editor pane: a Milkdown Crepe build (story 001) — a Notion-style WYSIWYG
// markdown editor (toolbar, block-edit slash menu, block handle, image block,
// table, CodeMirror code blocks, link tooltip, list items, placeholder, LaTeX,
// cursor) themed to the "Column" design. Collaboration (Yjs) and the custom
// agent/citation surface are layered onto Crepe's underlying editor (stories
// 002/003): citation chips, `/cite`, and `/write` re-attach as plugins, and the
// agent-routed slash commands fold into Crepe's block-edit menu as one group.
//
// Persistence model (story 013): Yjs is the collab/transport layer; the storage
// API is persistence. Saves happen on debounce and on Cmd/Ctrl+S.

import { CrepeBuilder } from '@milkdown/crepe/builder';
import { blockEdit } from '@milkdown/crepe/feature/block-edit';
import { codeMirror } from '@milkdown/crepe/feature/code-mirror';
import { cursor } from '@milkdown/crepe/feature/cursor';
import { imageBlock } from '@milkdown/crepe/feature/image-block';
import { latex } from '@milkdown/crepe/feature/latex';
import { linkTooltip } from '@milkdown/crepe/feature/link-tooltip';
import { listItem } from '@milkdown/crepe/feature/list-item';
import { placeholder } from '@milkdown/crepe/feature/placeholder';
import { table } from '@milkdown/crepe/feature/table';
import { toolbar } from '@milkdown/crepe/feature/toolbar';

import { type Editor, editorViewCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { getMarkdown, markdownToSlice, replaceAll } from '@milkdown/kit/utils';
import type { EditorView } from '@milkdown/kit/prose/view';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import { Doc as YDoc } from 'yjs';
import { WebsocketProvider } from 'y-websocket';

import '@milkdown/crepe/theme/common/style.css';
import 'katex/dist/katex.min.css';

import { BACKEND_WS_URL, readTextFile, writeTextFile } from './api';
import { agentIdentity } from './agents';
import { refreshBib } from './bib';
import { citationPlugins, installCitationTooltips } from './citation';
import { openCitePicker } from './cite-picker';
import { refreshTree } from './files';
import { icon } from './icons';
import { setDocument, setSaveState } from './status';
import { toast } from './toast';
import { startWrite, writeSuggestionPlugin } from './write-suggestion';

// On open, reflect the persisted state in the top-bar "Saved" affordance.

const SAVE_DEBOUNCE_MS = 1500;

const DEFAULT_TEMPLATE = `# Untitled draft

Start writing, or ask an agent in the chat panel.
`;

let crepe: CrepeBuilder | null = null;
let provider: WebsocketProvider | null = null;
let ydoc: YDoc | null = null;

let currentProjectId = 0;
let currentPath = '';
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSavedMarkdown = '';
// Writer SDK session for in-editor `/write` follow-ups ("make it shorter").
// In-session only — chat restore (story 020) owns cross-reload continuity.
let writerSession: string | undefined;

export function currentDocumentPath(): string {
  return currentPath;
}

/**
 * Live-update the open editor when an agent changes the file underneath it
 * (story 013 carry-over). If the editor is clean, the new content is loaded in
 * one transaction (the collab plugin propagates it, the existing save path is a
 * no-op since it matches storage). If there are unsaved local edits, we refuse
 * to clobber them and return false so the caller keeps the reload prompt.
 */
export async function applyExternalChange(path: string): Promise<boolean> {
  if (!crepe || path !== currentPath) return false;
  const current = crepe.editor.action(getMarkdown());
  const dirty = saveTimer != null || current !== lastSavedMarkdown;
  if (dirty) return false;

  const stored = await readTextFile(currentProjectId, path);
  if (stored == null || stored === lastSavedMarkdown) return true; // nothing new to apply
  // Preset lastSaved so the markdownUpdated listener's save guard short-circuits
  // (we're mirroring storage, not making a new local edit).
  lastSavedMarkdown = stored;
  crepe.editor.action(replaceAll(stored));
  setSaveState('saved');
  return true;
}

// Slash-command registry (story 016, expanded for stories 017/025). These fold
// into Crepe's block-edit menu as one "AI commands" group (story 003) — typing
// `/` at the start of a block opens the unified menu; the block types come from
// Crepe, the agent commands from here. /cite is fully wired (PubMed search →
// chip) and /write streams a suggestion; the rest route to the owning agent (a
// stub toast for now — real dispatch lands with later stories).
interface AgentCommand {
  /** Filterable label shown in the menu, e.g. 'Cite'. */
  label: string;
  /** Owning agent slug — drives the routed-toast label. */
  agent: string;
  /** One-line description (currently menu-internal; kept for parity). */
  description: string;
  /** Invoked after the typed `/...` run has been removed from the document. */
  run: (view: EditorView) => void;
}

function agentCommands(): AgentCommand[] {
  const routed = (label: string, agent: string, description: string): AgentCommand => ({
    label,
    agent,
    description,
    run: () => toast(`Routed to ${agentIdentity(agent).label}`),
  });

  return [
    {
      label: 'Cite',
      agent: 'ra',
      description: 'Search PubMed & insert a citation',
      run: (view) => {
        const coords = view.coordsAtPos(view.state.selection.from);
        openCitePicker({
          projectId: currentProjectId,
          anchor: { x: coords.left, y: coords.bottom },
          onPick: (key) => {
            insertCitation(view, key);
            // The backend already updated references.bib — refresh dependents
            void refreshBib(currentProjectId);
            void refreshTree(currentProjectId);
            toast('Citation inserted · references.bib updated');
          },
          onClose: () => view.focus(),
        });
      },
    },
    {
      label: 'Write',
      agent: 'writer',
      description: 'Writer drafts text right here',
      run: (view) =>
        startWrite(view, {
          projectId: currentProjectId,
          path: currentPath,
          // Parse the accepted markdown with the live parser (decision 2).
          toSlice: (markdown) => crepe!.editor.action(markdownToSlice(markdown)),
          getSession: () => writerSession,
          setSession: (id) => {
            writerSession = id;
          },
        }),
    },
    routed('Research', 'ra', 'Ask Research a question'),
    routed('Figure', 'analyst', 'Analyst makes a figure or table'),
    routed('Review', 'reviewer', 'Reviewer critiques this section'),
    routed('Ask', 'pm', 'Ask any agent inline'),
    routed('Status', 'pm', 'What is the team doing?'),
  ];
}

/**
 * The `/filter` run immediately before the caret, if any. Crepe's block-edit
 * menu leaves the typed `/...` text in the document and delegates removal to the
 * selected item's handler; agent commands remove just that run (not the whole
 * block) before acting.
 */
function matchSlashRun(view: EditorView): { from: number; to: number } | null {
  const { $from, empty } = view.state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return null;
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const match = textBefore.match(/(?:^|\s)\/([a-zA-Z]*)$/);
  if (!match) return null;
  return { from: $from.pos - match[1].length - 1, to: $from.pos };
}

/** Remove the typed `/...` run, then run an agent command at the caret. */
function runAgentCommand(ctx: Ctx, command: AgentCommand): void {
  const view = ctx.get(editorViewCtx);
  const run = matchSlashRun(view);
  if (run) view.dispatch(view.state.tr.delete(run.from, run.to));
  command.run(view);
}

/** Update the sub-header word count and toggle the empty-state hero. */
function updateDocMeta(markdown: string): void {
  const words = (markdown.trim().match(/\S+/g) ?? []).length;
  const wc = document.getElementById('editor-wordcount');
  if (wc) wc.textContent = `${words.toLocaleString()} word${words === 1 ? '' : 's'}`;
  const hero = document.getElementById('editor-hero');
  if (hero) hero.hidden = markdown.trim().length > 0;
}

/** Insert a citation chip atom at the current selection. */
function insertCitation(view: EditorView, key: string): void {
  const node = view.state.schema.nodes.citation.create({ key });
  view.dispatch(view.state.tr.replaceSelectionWith(node, false).scrollIntoView());
}

let tooltipsInstalled = false;

export async function openDocument(projectId: number, path: string): Promise<void> {
  await closeDocument();
  currentProjectId = projectId;
  currentPath = path;
  writerSession = undefined; // a new document starts a fresh writer thread
  setDocument(path);
  const pathEl = document.getElementById('editor-path');
  if (pathEl) pathEl.textContent = path.replace(/\//g, ' / ');
  void refreshBib(projectId);
  if (!tooltipsInstalled) {
    installCitationTooltips(document.getElementById('editor')!);
    tooltipsInstalled = true;
  }

  const stored = await readTextFile(projectId, path);
  const template = stored ?? DEFAULT_TEMPLATE;
  lastSavedMarkdown = stored ?? '';

  const commands = agentCommands();
  crepe = new CrepeBuilder({ root: '#editor' });
  crepe
    .addFeature(toolbar)
    .addFeature(blockEdit, {
      buildMenu: (builder) => {
        const group = builder.addGroup('kuhn-agents', 'AI commands');
        for (const command of commands) {
          group.addItem(command.label.toLowerCase(), {
            label: command.label,
            icon: icon('sparkle'),
            onRun: (ctx) => runAgentCommand(ctx, command),
          });
        }
      },
    })
    .addFeature(imageBlock)
    .addFeature(table)
    .addFeature(codeMirror)
    .addFeature(listItem)
    .addFeature(linkTooltip)
    .addFeature(placeholder, { text: 'Type "/" for commands', mode: 'block' })
    .addFeature(latex)
    .addFeature(cursor)
    // Custom Kuhn surface (story 003): citation chips, the `/write` suggestion
    // decoration, and the Yjs collab plugin all attach to the underlying editor.
    .addFeature((editor: Editor) => {
      editor.use(citationPlugins).use(writeSuggestionPlugin).use(collab);
    });

  crepe.on((api) => {
    api.markdownUpdated((_ctx, markdown, prev) => {
      updateDocMeta(markdown);
      if (prev != null && markdown !== prev) scheduleSave(markdown);
    });
  });

  await crepe.create();

  updateDocMeta(template);
  setSaveState('saved');

  crepe.editor.action((ctx) => {
    const collabService = ctx.get(collabServiceCtx);
    ydoc = new YDoc();
    provider = new WebsocketProvider(`${BACKEND_WS_URL}/yjs-websocket`, roomName(projectId, path), ydoc);
    collabService.bindDoc(ydoc).setAwareness(provider.awareness);
    const boundProvider = provider;
    provider.once('sync', (isSynced: boolean) => {
      // Bail if the document was switched before sync arrived (story 024).
      if (!isSynced || provider !== boundProvider) return;
      // Seed the shared doc from storage only when the room is empty;
      // otherwise the live collaborative state wins.
      collabService.applyTemplate(template).connect();
    });
  });
}

export async function closeDocument(): Promise<void> {
  // Detach the collab plugins before any teardown: late provider/awareness
  // events otherwise dispatch into the view after editor.destroy() has
  // removed the editorState ctx slice (story 024).
  crepe?.editor.action((ctx) => ctx.get(collabServiceCtx).disconnect());
  if (saveTimer) await flushSave();
  provider?.destroy();
  provider = null;
  ydoc?.destroy();
  ydoc = null;
  if (crepe) await crepe.destroy();
  crepe = null;
}

function roomName(projectId: number, path: string): string {
  return `project-${projectId}/${path}`;
}

function scheduleSave(markdown: string): void {
  if (markdown === lastSavedMarkdown) return;
  setSaveState('dirty');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void doSave(markdown), SAVE_DEBOUNCE_MS);
}

/** Cancel a pending debounced save without writing (the file is about to be
 * deleted — flushing would resurrect it). */
export function cancelPendingSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

/** Tear down the open document without persisting it (e.g. it was just deleted
 * out from under the editor). Leaves no current path. */
export async function discardDocument(): Promise<void> {
  cancelPendingSave();
  await closeDocument(); // saveTimer is null now, so this won't write back
  currentPath = '';
  setDocument('');
}

/** Explicit save (Cmd/Ctrl+S) — serializes the current doc and writes through. */
export async function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!crepe) return;
  const markdown = crepe.editor.action(getMarkdown());
  await doSave(markdown);
}

async function doSave(markdown: string): Promise<void> {
  saveTimer = null;
  if (markdown === lastSavedMarkdown) {
    setSaveState('saved');
    return;
  }
  setSaveState('saving');
  try {
    await writeTextFile(currentProjectId, currentPath, markdown);
    lastSavedMarkdown = markdown;
    setSaveState('saved');
  } catch (err) {
    setSaveState('error', (err as Error).message);
  }
}
