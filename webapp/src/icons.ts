// Single inline-SVG line-icon set (story 025). 24×24 grid, round caps/joins,
// fill:none, currentColor — per the design handoff. One set, reused app-wide;
// no icon library, no emoji.

export type IconName =
  | 'check'
  | 'clock'
  | 'chevron-down'
  | 'arrow-right'
  | 'corner-up-right'
  | 'book'
  | 'file'
  | 'file-text'
  | 'folder'
  | 'folder-plus'
  | 'plus'
  | 'sparkle'
  | 'upload'
  | 'download'
  | 'lock'
  | 'pencil'
  | 'refresh'
  | 'trash'
  | 'send'
  | 'comment'
  | 'x';

// Inner path markup for each icon (viewBox 0 0 24 24).
const PATHS: Record<IconName, string> = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  'corner-up-right': '<path d="m15 14 5-5-5-5"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  file: '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M5 8V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-3"/>',
  'file-text':
    '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M5 8V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-3"/><path d="M9 13h6M9 17h4"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9' +
    'A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
  'folder-plus':
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9' +
    'A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/><path d="M12 10v6M9 13h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sparkle: '<path d="M5 3v4M3 5h4M6 17v4M4 19h4M13 3l2.5 6.5L22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5z"/>',
  upload: '<path d="M12 13V3M8 7l4-4 4 4"/><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  download: '<path d="M12 3v10M8 9l4 4 4-4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash:
    '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>' +
    '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  send: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
};

export interface IconOptions {
  size?: number;
  stroke?: number;
}

/** SVG markup string for `name`. Inherits color via `currentColor`. */
export function icon(name: IconName, { size = 16, stroke = 1.8 }: IconOptions = {}): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`
  );
}

/** Build an <svg> element (when a node, not a string, is needed). */
export function iconEl(name: IconName, opts?: IconOptions): SVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = icon(name, opts);
  return tpl.content.firstElementChild as SVGElement;
}
