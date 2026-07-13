// Project-type catalog (story 005-004): the single source for type values and
// display labels — previously duplicated in project-browser.ts and
// breadcrumb.ts. Must stay in sync with the backend CHECK constraint
// (agent-backend/src/db/schema.sql, projects.project_type).

export const PROJECT_TYPES: { value: string; label: string }[] = [
  { value: 'manuscript', label: 'Manuscript' },
  { value: 'rwe-protocol', label: 'RWE protocol' },
  { value: 'rct-protocol', label: 'RCT protocol' },
  { value: 'grant', label: 'Grant' },
  { value: 'sop', label: 'SOP' },
];

export const TYPE_LABEL: Record<string, string> =
  Object.fromEntries(PROJECT_TYPES.map((t) => [t.value, t.label]));
