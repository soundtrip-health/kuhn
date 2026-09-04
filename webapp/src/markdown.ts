// Issue #108: the single place user- or agent-authored Markdown becomes DOM.
//
// `marked` does not sanitize — raw HTML in the source passes straight through
// its output — so every `marked` → `innerHTML` sink in the webapp goes through
// this module, which runs the generated markup through DOMPurify with a
// restrictive allowlist before it is inserted. Nothing else in the webapp may
// call `marked` directly.
//
// Supported HTML subset (everything else is stripped, not escaped):
//   block   h1–h6 p br hr blockquote pre ul ol li table thead tbody tfoot tr th td
//   inline  a img code em strong b i del s sup sub span
//   forms   <input type="checkbox" disabled> only (GFM task lists); other
//           inputs are removed and checkboxes are always forced disabled
//   attrs   href src alt title align start class (code language) checked
//           disabled type; `id`, `name`, `style` and every on* handler are
//           dropped
//   URLs    http(s):, mailto: and relative/fragment URLs only; javascript:,
//           data:, vbscript: etc. are removed from href/src
//   links   every <a> is opened in a new tab with rel="noopener noreferrer"
//
// SVG, MathML, <iframe>/<object>/<embed>, <form>, <style>, <script>, <template>
// and custom elements never survive.

import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'blockquote', 'pre',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'a', 'img', 'code', 'em', 'strong', 'b', 'i', 'del', 's', 'sup', 'sub', 'span',
  'input',
];

const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'align', 'start', 'class', 'checked', 'disabled', 'type',
];

// Relative URLs, fragments, and the three schemes ordinary scientific prose
// uses. Anything with another scheme prefix is dropped by DOMPurify.
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i;

// DOMPurify is instantiated per window; in the browser `DOMPurify` is already
// bound to the global one. Hooks are registered once at module load.
const purifier = DOMPurify;

purifier.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName !== 'input') return;
  const el = node as Element;
  if (el.getAttribute('type') !== 'checkbox') {
    el.parentNode?.removeChild(el);
    return;
  }
  el.setAttribute('disabled', '');
});

purifier.addHook('afterSanitizeAttributes', (node) => {
  const el = node as Element;
  if (el.tagName === 'A' && el.hasAttribute('href')) {
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  }
});

function sanitize(html: string): string {
  return purifier.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    // Drop the contents of stripped script-capable elements too, not just the
    // tags (the default keeps e.g. <script>'s text as a text node).
    FORBID_CONTENTS: ['script', 'style', 'template', 'iframe', 'object', 'embed', 'noscript'],
  });
}

/** Render a Markdown document to sanitized HTML (block-level). */
export function renderMarkdown(markdown: string): string {
  return sanitize(marked.parse(markdown ?? '', { async: false }));
}

/** Render a single line of Markdown to sanitized inline HTML (no <p>). */
export function renderInlineMarkdown(markdown: string): string {
  return sanitize(marked.parseInline(markdown ?? '', { async: false }));
}

/**
 * Escape a plain string for interpolation into HTML text or a double-quoted
 * attribute. For the few template-literal `innerHTML` skeletons that splice in
 * a server-supplied string (e.g. an agent label derived from an API slug).
 */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
