// Editor core (epic 013, story 002): the collaborative Crepe assembly
// extracted from editor.ts so the member app and the external-reviewer surface
// (webapp/src/review/) share one engine. This module owns:
//
//  - the Crepe build (features gated by `DocFeatures`),
//  - the Yjs provider + seed-grant / seed-fallback logic (seeding is gated on
//    `editable` — a read-only client must never apply a template, because its
//    bytes would become room truth that a member later autosaves),
//  - debounced save scheduling through an injected transport,
//  - terminal close-code routing (4001 evicted / 4002 moved / 4003 link
//    revoked / 4004 link expired) to the caller's `onClose`,
//  - the awareness `user` field, and the server-attributed MSG_REVIEWERS(65)
//    presence broadcast → `onReviewers` (the trust-bearing "an outsider is on
//    this doc" signal; awareness names are cosmetic and client-claimed).
//
// Everything member-specific (slash commands, suggestions, bib refresh, source
// mode, move-follow) stays in editor.ts, injected via the options object.
// Everything reviewer-specific (claim screens, mode UX) lives in review/.

import { CrepeBuilder } from '@milkdown/crepe/builder';
import { blockEdit, type BlockEditFeatureConfig } from '@milkdown/crepe/feature/block-edit';
import { codeMirror } from '@milkdown/crepe/feature/code-mirror';
import { cursor } from '@milkdown/crepe/feature/cursor';
import { imageBlock } from '@milkdown/crepe/feature/image-block';
import { latex } from '@milkdown/crepe/feature/latex';
import { linkTooltip } from '@milkdown/crepe/feature/link-tooltip';
import { listItem } from '@milkdown/crepe/feature/list-item';
import { placeholder } from '@milkdown/crepe/feature/placeholder';
import { table } from '@milkdown/crepe/feature/table';
import { toolbar, type ToolbarFeatureConfig } from '@milkdown/crepe/feature/toolbar';

import { type Editor, editorViewCtx, editorViewOptionsCtx } from '@milkdown/kit/core';
import { getMarkdown, replaceAll } from '@milkdown/kit/utils';
import type { EditorView } from '@milkdown/kit/prose/view';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import * as decoding from 'lib0/decoding';
import { Doc as YDoc } from 'yjs';
import { WebsocketProvider } from 'y-websocket';

import '@milkdown/crepe/theme/common/style.css';
import 'katex/dist/katex.min.css';

import { citationPlugins } from './citation';
import {
  attachComments,
  beginCommentFromSelection,
  commentsPlugin,
  detachComments,
  type CommentsIdentity,
  type CommentsTransport,
} from './comments';
import { icon } from './icons';
import { suggestionHunksPlugin } from './suggestion-hunks';
import { writeSuggestionPlugin } from './write-suggestion';

// ---- Protocol constants (mirror agent-backend/src/yjs-websocket.js) ---------

// Custom y-websocket message naming this connection the room's template seeder
// (story 041). The server grants it only to a write-capable connection.
export const MSG_SEED_GRANT = 64;
// Server-attributed external-reviewer presence (epic 013): a varString JSON
// payload `{"reviewers":[{"linkId":3,"name":"Jane","mode":"comment"}]}`
// broadcast to every connection on reviewer join/leave.
export const MSG_REVIEWERS = 65;
// Terminal close codes: the room was evicted (file deleted/replaced, story
// 038) or its document moved (story 012-002)…
export const CLOSE_ROOM_EVICTED = 4001;
export const CLOSE_ROOM_MOVED = 4002;
// …or, for reviewer connections (epic 013), the review link was revoked or
// expired. All four stop auto-reconnect and surface through `onClose`.
export const CLOSE_LINK_REVOKED = 4003;
export const CLOSE_LINK_EXPIRED = 4004;

const TERMINAL_CLOSE_CODES = new Set([
  CLOSE_ROOM_EVICTED,
  CLOSE_ROOM_MOVED,
  CLOSE_LINK_REVOKED,
  CLOSE_LINK_EXPIRED,
]);

export const SAVE_DEBOUNCE_MS = 1500;
// If the granted seeder dies before seeding, seed ourselves once the room has
// stayed empty this long (re-checked at apply time). Editable clients only.
export const SEED_FALLBACK_MS = 3000;

export const DEFAULT_TEMPLATE = `# Untitled draft

Start writing, or ask an agent in the chat panel.
`;

// ---- Shared types -----------------------------------------------------------

export type SaveStateName = 'saved' | 'saving' | 'dirty' | 'error';

/** Awareness `user` field for cursor labels (cosmetic — never trust-bearing). */
export interface AwarenessUser {
  name: string;
  /** Set for external reviewers so member cursors can style them apart. */
  external?: boolean;
  color?: string;
}

/** One external reviewer on the room, as attributed by the SERVER (msg 65). */
export interface ReviewerPresence {
  linkId: number;
  name: string;
  mode: 'view' | 'comment' | 'edit';
}

export interface DocFeatures {
  /** Agent slash-command group in the block-edit menu + `/write` plugin. */
  slashCommands: boolean;
  /** Pending-suggestion hunk decorations (attach stays wrapper-side). */
  suggestions: boolean;
  /** Bibliography integration (wrapper-side: refreshBib + tooltips; citation
   *  chips themselves always render from the doc schema). */
  bib: boolean;
  /** Margin comments: plugin, toolbar entry, and (with `commentsIdentity`)
   *  the panel attach/detach lifecycle. */
  comments: boolean;
}

/** Backend access, injected so the member app and the reviewer surface can
 *  drive the same editor through different REST namespaces. */
export interface DocTransport {
  readFile: (projectId: number, path: string) => Promise<string | null>;
  /** Absent = this surface can never persist (view/comment reviewer modes). */
  writeFile?: (
    projectId: number,
    path: string,
    content: string,
    opts?: { checkpoint?: boolean },
  ) => Promise<void>;
  commentsApi: CommentsTransport;
  /** WS origin (no path), e.g. api.ts BACKEND_WS_URL; the provider connects
   *  to `${wsUrl}/yjs-websocket`. */
  wsUrl: string;
}

export interface OpenDocOptions {
  projectId: number;
  path: string;
  /** false plumbs ProseMirror's read-only mode AND gates seeding + saves. */
  editable: boolean;
  features: DocFeatures;
  transport: DocTransport;
  /** Local awareness user field; null sets nothing. */
  awarenessUser: AwarenessUser | null;
  /** Terminal close (4001/4002/4003/4004) after the provider is disconnected.
   *  Not called after destroy(). */
  onClose?: (code: number, reason: string) => void;
  /** Server-attributed reviewer presence (MSG_REVIEWERS). Empty array =
   *  the last reviewer left. */
  onReviewers?: (reviewers: ReviewerPresence[]) => void;
  /** Required for the comments panel to attach (with features.comments). */
  commentsIdentity?: CommentsIdentity;
  /** Pre-read stored bytes (null = file absent). undefined → the core reads
   *  via transport.readFile itself. */
  stored?: string | null;
  /** Seed content for an empty room; defaults to stored ?? DEFAULT_TEMPLATE. */
  template?: string;
  /** default true. false = static render of `stored`, no room/provider/saves
   *  (the reviewer empty-room fallback, plan §3.3). */
  collab?: boolean;
  /** Force local content over whatever the room replays after sync:
   *  `restore` carries an explicit buffer (moved doc, story 012-002) and
   *  persists it; `preferStored` forces the stored bytes (source-mode return,
   *  story 039). */
  override?: { restore?: string; preferStored?: boolean };
  /** Selector for the editor root element (default '#editor'). */
  root?: string;
  /** Editable-mode placeholder text (default: the member slash hint). */
  placeholder?: string;
  /** Member wrapper injection: the agent-command group (features.slashCommands). */
  buildBlockEditMenu?: NonNullable<BlockEditFeatureConfig['buildMenu']>;
  /** Extra selection-toolbar entries beyond the built-in comment item. */
  buildToolbar?: NonNullable<ToolbarFeatureConfig['buildToolbar']>;
  /** Extra Milkdown plugins (member: none today; reserved). */
  extraPlugins?: (editor: Editor) => void;
  /** Word count / hero / any per-keystroke meta. Also called once on load. */
  onMarkdownUpdated?: (markdown: string) => void;
  onSaveState?: (state: SaveStateName, detail?: string) => void;
  /** Returning false suppresses scheduling AND writing (member: moved-away). */
  beforeSave?: () => boolean;
  /** First provider sync; `empty` = the shared fragment had no content. */
  onSynced?: (info: { empty: boolean }) => void;
  /** After create + collab wiring, before comments attach — the member
   *  wrapper attaches suggestions here. */
  onReady?: (view: EditorView) => void;
}

export interface DocHandle {
  readonly crepe: CrepeBuilder;
  readonly provider: WebsocketProvider | null;
  readonly ydoc: YDoc | null;
  view(): EditorView;
  /** Serialized markdown of the live doc, or null after destroy. */
  getMarkdown(): string | null;
  /** Replace the whole doc (propagates to peers via collab). */
  replaceContent(markdown: string): void;
  isDirty(): boolean;
  /** A debounced save is scheduled but not yet written. */
  pendingSave(): boolean;
  /** Mark `markdown` as the persisted content (guards save short-circuits). */
  noteSaved(markdown: string): void;
  lastSaved(): string;
  flushSave(opts?: { checkpoint?: boolean }): Promise<void>;
  cancelPendingSave(): void;
  /** Retarget saves to a new path (move-follow: path FIRST, then flush). */
  setPath(path: string): void;
  destroy(): Promise<void>;
}

// ---- Save engine ------------------------------------------------------------
// Shared by the collab handle and by editor.ts's source/raw-text modes, so the
// debounce + checkpoint + state-reporting semantics stay identical everywhere.

export interface SaveEngine {
  schedule(content: string): void;
  /** Write through now (null content = nothing open, no-op). A checkpoint
   *  writes even when clean — the history version is cut by the request. */
  flush(content: string | null, opts?: { checkpoint?: boolean }): Promise<void>;
  cancel(): void;
  pending(): boolean;
  noteSaved(content: string): void;
  lastSaved(): string;
  isDirty(current: string | null): boolean;
}

export function createSaveEngine(opts: {
  write: (content: string, opts: { checkpoint: boolean }) => Promise<void>;
  onState: (state: SaveStateName, detail?: string) => void;
  beforeSave?: () => boolean;
  debounceMs?: number;
}): SaveEngine {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSaved = '';
  const allowed = (): boolean => opts.beforeSave?.() ?? true;

  async function doSave(content: string, checkpoint: boolean): Promise<void> {
    timer = null;
    if (!allowed()) return;
    if (content === lastSaved && !checkpoint) {
      opts.onState('saved');
      return;
    }
    opts.onState('saving');
    try {
      await opts.write(content, { checkpoint });
      lastSaved = content;
      opts.onState('saved');
    } catch (err) {
      opts.onState('error', (err as Error).message);
    }
  }

  return {
    schedule(content: string): void {
      if (content === lastSaved || !allowed()) return;
      opts.onState('dirty');
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void doSave(content, false), opts.debounceMs ?? SAVE_DEBOUNCE_MS);
    },
    async flush(content, o = {}): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (content == null) return;
      await doSave(content, o.checkpoint ?? false);
    },
    cancel(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    pending: () => timer != null,
    noteSaved(content: string): void {
      lastSaved = content;
    },
    lastSaved: () => lastSaved,
    isDirty(current: string | null): boolean {
      return timer != null || (current != null && current !== lastSaved);
    },
  };
}

// ---- openDoc ----------------------------------------------------------------

export function roomName(projectId: number, path: string): string {
  return `project-${projectId}/${path}`;
}

export async function openDoc(options: OpenDocOptions): Promise<DocHandle> {
  const { projectId, editable, features, transport } = options;
  let path = options.path;
  const collabEnabled = options.collab ?? true;
  const onSaveState = options.onSaveState ?? ((): void => {});

  const stored =
    options.stored !== undefined ? options.stored : await transport.readFile(projectId, path);
  const template = options.template ?? stored ?? DEFAULT_TEMPLATE;

  let destroyed = false;
  let provider: WebsocketProvider | null = null;
  let ydoc: YDoc | null = null;

  const engine = createSaveEngine({
    // `path` is read at write time so a racing autosave lands on the
    // retargeted path (setPath runs before the flush — move-follow rule 1).
    write: (content, o) => transport.writeFile!(projectId, path, content, o),
    onState: onSaveState,
    beforeSave: options.beforeSave,
  });
  engine.noteSaved(stored ?? '');
  const canSave = editable && transport.writeFile != null;

  const crepe = new CrepeBuilder({ root: options.root ?? '#editor' });

  // Selection toolbar: editable surfaces only (read-only clients get their own
  // affordances). The margin-comment entry point lives beside bold/italic,
  // where Docs users expect it (story 008-004).
  if (editable) {
    crepe.addFeature(toolbar, {
      buildToolbar: (builder) => {
        if (features.comments) {
          builder.addGroup('kuhn-comment', 'Comment').addItem('comment', {
            active: () => false,
            icon: icon('comment'),
            onRun: (ctx) => beginCommentFromSelection(ctx.get(editorViewCtx)),
          });
        }
        options.buildToolbar?.(builder);
      },
    });
    if (features.slashCommands && options.buildBlockEditMenu) {
      crepe.addFeature(blockEdit, { buildMenu: options.buildBlockEditMenu });
    } else {
      crepe.addFeature(blockEdit);
    }
  }
  crepe
    .addFeature(imageBlock)
    .addFeature(table)
    .addFeature(codeMirror)
    .addFeature(listItem)
    .addFeature(linkTooltip);
  if (editable) {
    crepe.addFeature(placeholder, {
      text: options.placeholder ?? 'Type "/" for commands',
      mode: 'block',
    });
  }
  crepe
    .addFeature(latex)
    .addFeature(cursor)
    // Custom Kuhn surface (story 003): citation chips always (they render from
    // the doc schema); the rest per feature flags.
    .addFeature((editor: Editor) => {
      editor.use(citationPlugins);
      if (features.slashCommands) editor.use(writeSuggestionPlugin);
      if (features.suggestions) editor.use(suggestionHunksPlugin);
      if (features.comments) editor.use(commentsPlugin);
      if (collabEnabled) editor.use(collab);
      options.extraPlugins?.(editor);
      if (!editable) {
        editor.config((ctx) => {
          ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => false }));
        });
      }
    });

  crepe.on((api) => {
    api.markdownUpdated((_ctx, markdown, prev) => {
      options.onMarkdownUpdated?.(markdown);
      if (canSave && prev != null && markdown !== prev) engine.schedule(markdown);
    });
  });

  await crepe.create();

  if (!collabEnabled && stored != null && stored !== '') {
    // Static render (reviewer empty-room fallback): content straight from
    // storage, no room bytes ever sent.
    crepe.editor.action(replaceAll(stored));
  }
  options.onMarkdownUpdated?.(collabEnabled ? template : (stored ?? ''));
  onSaveState('saved');

  const currentMarkdown = (): string | null =>
    destroyed ? null : (crepe.editor.action(getMarkdown()) as string);

  const flush = async (o: { checkpoint?: boolean } = {}): Promise<void> => {
    if (!canSave) {
      engine.cancel();
      return;
    }
    await engine.flush(currentMarkdown(), o);
  };

  if (collabEnabled) {
    crepe.editor.action((ctx) => {
      const collabService = ctx.get(collabServiceCtx);
      ydoc = new YDoc();
      provider = new WebsocketProvider(
        `${transport.wsUrl}/yjs-websocket`,
        roomName(projectId, path),
        ydoc,
      );
      collabService.bindDoc(ydoc).setAwareness(provider.awareness);
      if (options.awarenessUser) {
        provider.awareness.setLocalStateField('user', options.awarenessUser);
      }
      const boundProvider = provider;
      const boundYdoc = ydoc;
      // The server names exactly one connection per empty room as its seeder
      // (story 041) — deciding client-side let two simultaneous openers both
      // observe an empty room and both apply the template. Epic 013: the
      // server only grants write-capable connections; the editable gates
      // below are the client half of the same invariant.
      let seedGranted = false;
      boundProvider.messageHandlers[MSG_SEED_GRANT] = (_encoder, decoder) => {
        seedGranted = decoding.readVarUint(decoder) === 1;
      };
      boundProvider.messageHandlers[MSG_REVIEWERS] = (_encoder, decoder) => {
        const payload = decoding.readVarString(decoder);
        if (!options.onReviewers) return;
        try {
          const parsed = JSON.parse(payload) as { reviewers?: ReviewerPresence[] };
          options.onReviewers(Array.isArray(parsed.reviewers) ? parsed.reviewers : []);
        } catch {
          // Malformed frame — ignore; presence is advisory UI.
        }
      };
      // Terminal closes: auto-reconnecting would repopulate a fresh room from
      // this client's local state (4001/4002, story 038/012-002) or hammer a
      // dead credential (4003/4004, epic 013) — stop for good and let the
      // caller's onClose decide the UX. y-websocket re-enters this handler
      // with a null event when disconnect() closes the socket, so everything
      // below must be idempotent.
      boundProvider.on('connection-close', (event: CloseEvent | null) => {
        if (event == null || !TERMINAL_CLOSE_CODES.has(event.code)) return;
        boundProvider.disconnect();
        if (destroyed || provider !== boundProvider) return;
        options.onClose?.(event.code, event.reason ?? '');
      });
      boundProvider.once('sync', (isSynced: boolean) => {
        // Bail if the document was switched before sync arrived (story 024).
        if (!isSynced || destroyed || provider !== boundProvider) return;
        if (seedGranted && editable) {
          // Sole seeder: apply the storage template (its own empty-room
          // condition still re-checks at apply time).
          collabService.applyTemplate(template).connect();
        } else {
          collabService.connect();
          // Seeder-death fallback: if nobody has seeded the room after a
          // grace period, do it ourselves. Gated on editable — a read-only
          // client must never inject template bytes into the room.
          if (editable) {
            setTimeout(() => {
              if (destroyed || provider !== boundProvider) return;
              if (boundYdoc.getXmlFragment('prosemirror').length > 0) return;
              collabService.disconnect();
              collabService.applyTemplate(template).connect();
            }, SEED_FALLBACK_MS);
          }
        }
        options.onSynced?.({ empty: boundYdoc.getXmlFragment('prosemirror').length === 0 });
        // Force local text over whatever the room replayed (it propagates to
        // peers via collab). Two callers: returning from source mode (story
        // 039 — edits went straight to storage, which any still-warm room
        // predates), and a move retarget (story 012-002 — the unsaved buffer
        // rides into the new room, then persists to the new path).
        const override = options.override?.restore ?? (options.override?.preferStored ? template : null);
        if (override == null) return;
        setTimeout(() => {
          if (destroyed || provider !== boundProvider) return;
          const same = currentMarkdown() === override;
          if (!same) {
            engine.noteSaved(template);
            crepe.editor.action(replaceAll(override));
          }
          if (options.override?.restore != null) void flush();
          else if (!same) onSaveState('saved');
        }, 0);
      });
    });
  }

  const commentsAttached = features.comments && options.commentsIdentity != null;
  let attachedView: EditorView | null = null;
  crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    attachedView = view;
    // Member wrapper attaches suggestions here (matching the pre-extraction
    // order: suggestions first, then comments).
    options.onReady?.(view);
    if (commentsAttached) {
      attachComments(view, {
        projectId,
        path,
        transport: transport.commentsApi,
        identity: options.commentsIdentity!,
      });
    }
  });

  return {
    crepe,
    get provider() {
      return provider;
    },
    get ydoc() {
      return ydoc;
    },
    view: () => crepe.editor.action((ctx) => ctx.get(editorViewCtx)),
    getMarkdown: currentMarkdown,
    replaceContent(markdown: string): void {
      if (!destroyed) crepe.editor.action(replaceAll(markdown));
    },
    isDirty: () => engine.isDirty(currentMarkdown()),
    pendingSave: () => engine.pending(),
    noteSaved: (markdown: string) => engine.noteSaved(markdown),
    lastSaved: () => engine.lastSaved(),
    flushSave: flush,
    cancelPendingSave: () => engine.cancel(),
    setPath(p: string): void {
      path = p;
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      engine.cancel();
      // View-scoped: a superseded handle being cleaned up must not detach a
      // newer document's comments (the module is a singleton).
      if (commentsAttached) detachComments(attachedView ?? undefined);
      // Detach the collab plugins before any teardown: late provider/awareness
      // events otherwise dispatch into the view after editor.destroy() has
      // removed the editorState ctx slice (story 024).
      if (collabEnabled) crepe.editor.action((ctx) => ctx.get(collabServiceCtx).disconnect());
      provider?.destroy();
      provider = null;
      ydoc?.destroy();
      ydoc = null;
      await crepe.destroy();
    },
  };
}
