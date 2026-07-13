// Small accessibility helpers (story 005-004): focus trapping for overlays.

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((el) => el.offsetParent !== null);
}

/**
 * Trap Tab focus inside a container and move focus into it. Returns a release
 * function that removes the trap and restores focus to the element that was
 * focused when the trap was engaged. Contents may re-render while trapped —
 * the focusable list is computed per keystroke.
 */
export function trapFocus(container: HTMLElement): () => void {
  const previous = document.activeElement as HTMLElement | null;

  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const items = focusables(container);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    if (e.shiftKey && (current === first || !container.contains(current))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (current === last || !container.contains(current))) {
      e.preventDefault();
      first.focus();
    }
  };

  container.addEventListener('keydown', onKeydown);
  focusables(container)[0]?.focus();

  return () => {
    container.removeEventListener('keydown', onKeydown);
    previous?.focus?.();
  };
}
