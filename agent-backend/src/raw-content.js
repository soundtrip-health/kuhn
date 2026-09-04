// STH-16: the raw-file serving policy.
//
// Uploaded project files and org-library documents are untrusted, and every
// raw-bytes route (routes/files.js, routes/org-library.js, routes/history.js,
// routes/review.js) serves them from the credentialed app origin. An HTML or
// SVG served inline there becomes an ACTIVE same-origin document: its scripts
// run as the victim's identity against the authenticated API. The policy is
// an explicit safe-inline allowlist — no content sniffing, no "sanitizing"
// arbitrary HTML, and never a trust in stored or client-supplied MIME:
//
//   * extension on the allowlist → served inline with its (safe) declared type;
//   * everything else (HTML/SVG, unknown types, binary) → download:
//     application/octet-stream + Content-Disposition: attachment;
//   * X-Content-Type-Options: nosniff always — the declared MIME, not the
//     bytes, decides how the browser treats the response.
//
// The decision is the file's lowercased extension. Org-library documents'
// stored `mime` (multer's client-supplied mimetype) is deliberately NOT
// consulted here: it is attacker-controlled at upload time, which is exactly
// the misleading MIME this policy must not trust (threat model T-13).
//
// SVG is the canonical trap: image-looking but active content. It is not on
// the allowlist and the webapp never renders user SVG inline either — the
// preview pane offers a download link for it (webapp/src/preview.ts).

import { basename, extname } from 'node:path';

const OCTET_STREAM = 'application/octet-stream';

/**
 * Safe-inline allowlist. Only these extensions may be served as inline
 * same-origin documents, and only with these declared types. Text/* and
 * application/json documents are never executed by browsers; raster images
 * render in a scriptless image context; PDF previews are a deliberate,
 * allowlisted exception (the webapp previews them in an iframe, stories
 * 014/019 — modern PDF viewers run no document JavaScript).
 */
const SAFE_INLINE = new Map([
  // plain text — browsers never execute text/* documents
  ['.md', 'text/markdown; charset=utf-8'],
  ['.markdown', 'text/markdown; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.log', 'text/plain; charset=utf-8'],
  ['.bib', 'text/plain; charset=utf-8'],
  ['.typ', 'text/plain; charset=utf-8'],
  ['.tex', 'text/plain; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.json', 'application/json'],
  ['.yaml', 'text/plain; charset=utf-8'],
  ['.yml', 'text/plain; charset=utf-8'],
  // raster images only — SVG is active content and is deliberately absent
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  // PDF — see note above
  ['.pdf', 'application/pdf'],
]);

/**
 * Build the Content-Disposition header for a download. The base name is
 * user-controlled (upload path / org-library filename), so:
 *   - header-illegal characters (C0 controls, DEL, quotes, backslash) are
 *     stripped from the plain `filename` parameter;
 *   - non-ASCII names get an RFC 5987 `filename*=UTF-8''…` parameter (with an
 *     ASCII fallback) instead of a header Node cannot encode.
 */
function attachmentDisposition(name) {
  // eslint-disable-next-line no-control-regex
  const clean = String(name).replace(/[\u0000-\u001f\u007f"\\]/g, '');
  if (/^[\x20-\x7e]*$/.test(clean)) {
    return `attachment; filename="${clean.length > 0 ? clean : 'file'}"`;
  }
  const fallback = clean.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${fallback.length > 0 ? fallback : 'file'}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

/**
 * Classify one user file for raw HTTP serving on the credentialed app origin.
 *
 * @param {string} filename file path or base name; only the lowercased
 *   extension decides inline-vs-download, and the base name drives the
 *   sanitized download name.
 * @returns {{contentType: string, disposition: string|null}} the Content-Type
 *   to declare and the Content-Disposition for non-allowlisted types (null
 *   for allowlisted inline types, where the browser default applies).
 *   `X-Content-Type-Options: nosniff` belongs on every raw response;
 *   sendRawFile sets it.
 */
export function rawContentPolicy(filename) {
  const base = basename(String(filename));
  const ext = extname(base).toLowerCase();
  const inline = SAFE_INLINE.has(ext);
  return {
    contentType: SAFE_INLINE.get(ext) ?? OCTET_STREAM,
    disposition: inline ? null : attachmentDisposition(base),
  };
}

/**
 * Send raw user bytes with the STH-16 policy applied: allowlisted MIME or
 * octet stream, nosniff always, attachment for everything the allowlist does
 * not cover. Every raw-bytes route goes through here.
 */
export function sendRawFile(res, filename, buf) {
  const { contentType, disposition } = rawContentPolicy(filename);
  res.set('Content-Type', contentType);
  res.set('X-Content-Type-Options', 'nosniff');
  if (disposition) res.set('Content-Disposition', disposition);
  res.send(buf);
}
