// Single inline-SVG line-icon set (story 025). 24×24 grid, round caps/joins,
// fill:none, currentColor — per the design handoff. One set, reused app-wide;
// no icon library, no emoji.

export type IconName =
  | 'check'
  | 'clock'
  | 'chevron-down'
  | 'arrow-right'
  | 'file'
  | 'file-text'
  | 'plus'
  | 'sparkle'
  | 'upload'
  | 'lock'
  | 'send';

// Inner path markup for each icon (viewBox 0 0 24 24).
const PATHS: Record<IconName, string> = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  file: '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M5 8V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-3"/>',
  'file-text':
    '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M5 8V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-3"/><path d="M9 13h6M9 17h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sparkle: '<path d="M5 3v4M3 5h4M6 17v4M4 19h4M13 3l2.5 6.5L22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5z"/>',
  upload: '<path d="M12 13V3M8 7l4-4 4 4"/><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  send: '<path d="M5 12h14M13 6l6 6-6 6"/>',
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
