// Org settings (story 011-003): a small validated JSON bag on
// organizations.settings, merged over defaults at read time. Display name is
// NOT a settings key — the routes update organizations.name directly; slug is
// immutable everywhere.

import { querySync, transaction } from '../db.js';

export const ORG_SETTINGS_SCHEMA = {
  default_member_role: { values: ['viewer', 'editor'], default: 'editor' },
  library_seeding:     { boolean: true,                default: true },
  promotion_policy:    { values: ['approval-required', 'direct'], default: 'approval-required' },
};

/** Field-level validation failure — routes map to 400 { error, field }. */
export class SettingsValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.field = field;
  }
}

function defaults() {
  const out = {};
  for (const [key, spec] of Object.entries(ORG_SETTINGS_SCHEMA)) out[key] = spec.default;
  return out;
}

function parseStored(text) {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Validate a settings patch against ORG_SETTINGS_SCHEMA.
 * @throws {SettingsValidationError} unknown key or wrong type/value
 */
export function validateSettingsPatch(patch) {
  for (const [key, value] of Object.entries(patch)) {
    const spec = ORG_SETTINGS_SCHEMA[key];
    if (!spec) throw new SettingsValidationError(`unknown setting: ${key}`, key);
    if (spec.boolean) {
      if (typeof value !== 'boolean') {
        throw new SettingsValidationError(`${key} must be a boolean`, key);
      }
    } else if (!spec.values.includes(value)) {
      throw new SettingsValidationError(
        `${key} must be one of: ${spec.values.join(', ')}`, key,
      );
    }
  }
}

/**
 * The org's settings, merged over defaults. Synchronous (querySync) — callers
 * include the promote-policy branch inside request handlers.
 * @returns {object|null} null if the org does not exist
 */
export function getOrgSettings(orgId) {
  const { rows } = querySync('SELECT settings FROM organizations WHERE id = $1', [orgId]);
  if (!rows[0]) return null;
  return { ...defaults(), ...parseStored(rows[0].settings) };
}

/**
 * Validate → merge → persist a settings patch.
 * @throws {SettingsValidationError} on an unknown key or bad value
 * @returns {object|null} the merged settings, or null if the org is missing
 */
export function updateOrgSettings(orgId, patch) {
  validateSettingsPatch(patch ?? {});
  return transaction(() => {
    const { rows } = querySync('SELECT settings FROM organizations WHERE id = $1', [orgId]);
    if (!rows[0]) return null;
    const merged = { ...parseStored(rows[0].settings), ...patch };
    querySync(
      `UPDATE organizations
       SET settings = $2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = $1`,
      [orgId, JSON.stringify(merged)],
    );
    return { ...defaults(), ...merged };
  });
}
