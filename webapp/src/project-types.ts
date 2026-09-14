// Document-type store (issue #106): the types a project in the active
// organization can be — Kuhn catalog types plus the org's own, with an active
// org type shadowing a catalog one of the same slug. Previously a hard-coded
// list here that had to match the backend CHECK; now the backend's effective
// list for the org (GET /api/orgs/:id/doc-types), loaded by workspace.ts
// whenever the active org is (re)loaded and refreshed after admin edits.
// Consumers read synchronously; labels fall back to the slug so a project
// whose type no longer resolves still renders.

import { getOrgDocTypes, type EffectiveDocType } from './api';

let loadedOrgId: number | null = null;
let types: EffectiveDocType[] = [];

/** Fetch the org's effective document types into the store. Never throws —
 *  a failed load keeps the last list (empty on first failure). */
export async function loadDocTypes(orgId: number): Promise<void> {
  try {
    const payload = await getOrgDocTypes(orgId);
    types = payload.effective;
    loadedOrgId = orgId;
  } catch {
    if (loadedOrgId !== orgId) types = [];
    loadedOrgId = orgId;
  }
}

/** The effective document types, in catalog order then org types by title. */
export const docTypes = (): EffectiveDocType[] => types;

/** One type by slug, or undefined when it is not in the effective list. */
export const docType = (slug: string): EffectiveDocType | undefined => types.find((t) => t.slug === slug);

/** Display label for a slug — the type's title, or the slug itself when unknown. */
export const typeLabel = (slug: string): string => docType(slug)?.title ?? slug;

/** Options for a type `<select>`; keeps an unknown current slug selectable. */
export function typeOptions(current?: string): { value: string; label: string }[] {
  const opts = types.map((t) => ({ value: t.slug, label: t.title }));
  if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: current });
  return opts;
}
