// Platform-level user flags (story 011-001). is_superadmin is synced from
// KUHN_SUPERADMIN_EMAILS at every boot and NEVER consulted by tenancy guards
// — it only gates the /api/admin surface.

import { querySync, transaction } from '../db.js';

/**
 * Make users.is_superadmin mirror the configured email list, both ways:
 * listed emails gain the flag (a users row is upserted so a super-admin
 * exists before first login), unlisted emails lose it. Called from initDb()
 * after seed.
 * @param {string[]} emails - already trimmed + lower-cased (config.js)
 */
export function syncSuperadmins(emails) {
  const normalized = [...new Set((emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  transaction(() => {
    for (const email of normalized) {
      querySync(
        `INSERT INTO users (email, display_name) VALUES ($1, $2)
         ON CONFLICT (email) DO NOTHING`,
        [email, email.split('@')[0]],
      );
    }
    if (normalized.length === 0) {
      querySync('UPDATE users SET is_superadmin = 0 WHERE is_superadmin != 0');
      return;
    }
    const placeholders = normalized.map((_, i) => `$${i + 1}`).join(', ');
    querySync(
      `UPDATE users SET is_superadmin =
         CASE WHEN lower(email) IN (${placeholders}) THEN 1 ELSE 0 END`,
      normalized,
    );
  });
}
