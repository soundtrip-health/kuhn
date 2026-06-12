// Milkdown editor pane: WYSIWYG markdown (commonmark + GFM + math), loading
// from and saving to the backend storage API, bound to the backend
// y-websocket room for the document (proves the collab path; single-user is
// fine for the prototype).
//
// Persistence model (story 013): Yjs is the collab/transport layer; the
// storage API is persistence. Saves happen on debounce and on Cmd/Ctrl+S.

import { Editor, rootCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { history } from '@milkdown/kit/plugin/history';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { getMarkdown } from '@milkdown/kit/utils';
import type { EditorView } from '@milkdown/kit/prose/view';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import { math } from '@milkdown/plugin-math';
import { nord } from '@milkdown/theme-nord';
import { Doc as YDoc } from 'yjs';
import { WebsocketProvider } from 'y-websocket';

import '@milkdown/theme-nord/style.css';
import 'katex/dist/katex.min.css';

import { BACKEND_WS_URL, readTextFile, writeTextFile } from './api';
import { refreshBib } from './bib';
import { citationPlugins, installCitationTooltips } from './citation';
import { openCitePicker } from './cite-picker';
import { refreshTree } from './files';
import { slash, slashMenuSpec, type SlashCommand } from './slash';
import { setDocument, setSaveState } from './status';

const SAVE_DEBOUNCE_MS = 1500;

const DEFAULT_TEMPLATE = `# Untitled draft

Start writing, or ask an agent in the chat panel.
`;

let editor: Editor | null = null;
let provider: WebsocketProvider | null = null;
let ydoc: YDoc | null = null;

let currentProjectId = 0;
let currentPath = '';
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSavedMarkdown = '';

export function currentDocumentPath(): string {
  return currentPath;
}

// Slash-command registry (story 016): /cite is the first command; later
// commands (/write, /review, …) append here.
function slashCommands(): SlashCommand[] {
  return [
    {
      name: 'cite',
      hint: 'Insert a citation (searches PubMed)',
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
          },
          onClose: () => view.focus(),
        });
      },
    },
  ];
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
  setDocument(path);
  void refreshBib(projectId);
  if (!tooltipsInstalled) {
    installCitationTooltips(document.getElementById('editor')!);
    tooltipsInstalled = true;
  }

  const stored = await readTextFile(projectId, path);
  const template = stored ?? DEFAULT_TEMPLATE;
  lastSavedMarkdown = stored ?? '';

  editor = await Editor.make()
    .config(nord)
    .config((ctx) => {
      ctx.set(rootCtx, '#editor');
      ctx.set(slash.key, slashMenuSpec(slashCommands()));
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, prev) => {
        if (prev != null && markdown !== prev) scheduleSave(markdown);
      });
    })
    .use(commonmark)
    .use(gfm)
    .use(math)
    .use(history)
    .use(clipboard)
    .use(listener)
    .use(collab)
    .use(citationPlugins)
    .use(slash)
    .create();

  editor.action((ctx) => {
    const collabService = ctx.get(collabServiceCtx);
    ydoc = new YDoc();
    provider = new WebsocketProvider(`${BACKEND_WS_URL}/yjs-websocket`, roomName(projectId, path), ydoc);
    collabService.bindDoc(ydoc).setAwareness(provider.awareness);
    provider.once('sync', (isSynced: boolean) => {
      if (!isSynced) return;
      // Seed the shared doc from storage only when the room is empty;
      // otherwise the live collaborative state wins.
      collabService.applyTemplate(template).connect();
    });
  });
}

export async function closeDocument(): Promise<void> {
  if (saveTimer) await flushSave();
  provider?.destroy();
  provider = null;
  ydoc?.destroy();
  ydoc = null;
  if (editor) await editor.destroy();
  editor = null;
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

/** Explicit save (Cmd/Ctrl+S) — serializes the current doc and writes through. */
export async function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!editor) return;
  const markdown = editor.action(getMarkdown());
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
