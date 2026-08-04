// Reviewer REST client (epic 013 story 002): the ONLY network surface of the
// review bundle, all of it under /api/review/* (frozen shapes from
// agent-backend/src/routes/review.js). The session rides in the
// kuhn_review_session cookie (credentials: 'include' — the dev server is a
// different origin than the backend), and the session-bearing routes take no
// path/project parameters: the server pins both from the review link.
//
// A 401 anywhere raises `kuhn:review-unauthorized` so main.ts can resolve the
// right end-of-session screen no matter which call hit the wall (the review
// analogue of api.ts's `kuhn:unauthorized`).

import { BACKEND_URL, type Comment, type CommentThread } from '../api';
import type { CommentsTransport } from '../comments';

export type ReviewMode = 'view' | 'comment' | 'edit';

/** The guest equivalent of /api/auth/me (GET /api/review/context). projectId
 *  exists only so the client can build the Yjs room name. */
export interface ReviewContext {
  projectId: number;
  path: string;
  mode: ReviewMode;
  name: string;
  docTitle: string;
  expiresAt: string;
}

export type LookupState = 'unclaimed' | 'claimed' | 'expired' | 'revoked' | 'not_found';

export type LookupResult =
  | { state: 'yours'; context: ReviewContext }
  | {
      state: LookupState;
      mode?: ReviewMode;
      docTitle?: string;
      reviewerName?: string | null;
    };

export type ClaimResult =
  | { ok: true; context: ReviewContext }
  | { ok: false; code: string | null; error: string };

export class ReviewApiError extends Error {
  status: number;
  code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'ReviewApiError';
    this.status = status;
    this.code = code;
  }
}

async function reviewFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${BACKEND_URL}${path}`, { credentials: 'include', ...init });
  if (res.status === 401) window.dispatchEvent(new CustomEvent('kuhn:review-unauthorized'));
  return res;
}

async function toError(res: Response): Promise<ReviewApiError> {
  let message = `Request failed (${res.status})`;
  let code: string | null = null;
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    if (typeof body.error === 'string') message = body.error;
    if (typeof body.code === 'string') code = body.code;
  } catch {
    // non-JSON error body — keep the generic message
  }
  return new ReviewApiError(message, res.status, code);
}

async function expectOk(res: Response): Promise<Response> {
  if (!res.ok) throw await toError(res);
  return res;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---- Pre-session (token-bearing) --------------------------------------------

/** POST /api/review/lookup — drives the claim page: name prompt, one of the
 *  refusal screens, or (cookie already on this link) straight in. */
export async function lookupLink(token: string): Promise<LookupResult> {
  const res = await reviewFetch('/api/review/lookup', json({ token }));
  if (res.status === 404) return { state: 'not_found' };
  return (await expectOk(res)).json() as Promise<LookupResult>;
}

/** POST /api/review/claim — atomic single-claim; refusals come back as
 *  { ok: false, code } (link_claimed / link_expired / link_revoked / …). */
export async function claimLink(token: string, name: string): Promise<ClaimResult> {
  const res = await reviewFetch('/api/review/claim', json({ token, name }));
  if (res.ok) {
    const { context } = (await res.json()) as { context: ReviewContext };
    return { ok: true, context };
  }
  const err = await toError(res);
  return { ok: false, code: err.code, error: err.message };
}

// ---- Session-bearing --------------------------------------------------------

/** GET /api/review/context — re-fetched after a room move (4002) so the client
 *  learns the document's new path, and probed to classify dead sessions. */
export async function getContext(): Promise<ReviewContext> {
  const res = await expectOk(await reviewFetch('/api/review/context'));
  return res.json() as Promise<ReviewContext>;
}

/** GET /api/review/file — the linked document's bytes (null = file absent),
 *  matching the member readTextFile contract editor-core expects. */
export async function getFile(): Promise<string | null> {
  const res = await reviewFetch('/api/review/file');
  if (res.status === 404) return null;
  return (await expectOk(res)).text();
}

/** PUT /api/review/file[?checkpoint=1] — edit mode only (others 403). */
export async function putFile(content: string, opts: { checkpoint?: boolean } = {}): Promise<void> {
  await expectOk(
    await reviewFetch(`/api/review/file${opts.checkpoint ? '?checkpoint=1' : ''}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      body: content,
    }),
  );
}

// ---- Comments transport -----------------------------------------------------
// Same interface the member api.ts functions satisfy, so comments.ts is reused
// verbatim. The projectId/path arguments are ignored: the review session pins
// both server-side (no other document is reachable, whatever we send).

export const reviewCommentsApi: CommentsTransport = {
  async getComments(_projectId: number, _path?: string): Promise<CommentThread[]> {
    const res = await expectOk(await reviewFetch('/api/review/comments'));
    return ((await res.json()) as { threads: CommentThread[] }).threads;
  },

  async createComment(
    _projectId: number,
    params: { path: string; body: string; anchor?: { quote: string; start?: number; end?: number } },
  ): Promise<CommentThread> {
    const res = await expectOk(
      await reviewFetch('/api/review/comments', json({ body: params.body, anchor: params.anchor })),
    );
    return res.json() as Promise<CommentThread>;
  },

  async replyToComment(_projectId: number, rootId: number, body: string): Promise<Comment> {
    const res = await expectOk(
      await reviewFetch(`/api/review/comments/${rootId}/replies`, json({ body })),
    );
    return res.json() as Promise<Comment>;
  },

  async setCommentResolved(
    _projectId: number,
    rootId: number,
    resolved: boolean,
  ): Promise<CommentThread> {
    const res = await expectOk(
      await reviewFetch(`/api/review/comments/${rootId}/${resolved ? 'resolve' : 'reopen'}`, json({})),
    );
    return res.json() as Promise<CommentThread>;
  },

  async updateCommentAnchor(
    _projectId: number,
    rootId: number,
    anchor: { quote?: string; start?: number; end?: number; orphaned?: boolean },
  ): Promise<CommentThread> {
    const res = await expectOk(
      await reviewFetch(`/api/review/comments/${rootId}/anchor`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(anchor),
      }),
    );
    return res.json() as Promise<CommentThread>;
  },

  async deleteComment(_projectId: number, id: number): Promise<void> {
    await expectOk(await reviewFetch(`/api/review/comments/${id}`, { method: 'DELETE' }));
  },
};
