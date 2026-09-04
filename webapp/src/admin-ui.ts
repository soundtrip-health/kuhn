// Small DOM helpers shared by the org-admin tabs (org-admin.ts and the
// per-tab modules split out of it).

export function sectionTitle(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'admin-section-title';
  el.textContent = text;
  return el;
}

export function emptyRow(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'admin-empty';
  el.setAttribute('role', 'status');
  el.textContent = text;
  return el;
}

export function inlineError(message: string | null): HTMLElement {
  const el = document.createElement('div');
  el.className = 'admin-inline-error';
  el.setAttribute('role', 'alert');
  if (message) el.textContent = message;
  else el.hidden = true;
  return el;
}

export function hint(text: string): HTMLElement {
  const el = document.createElement('p');
  el.className = 'admin-setting-hint';
  el.textContent = text;
  return el;
}
