// Organization queries (story 005). Orgs are the tenant scope: a user reaches
// projects through org memberships. All listing here is membership-filtered so
// a user only ever sees orgs they belong to.

import { query, querySync, transaction } from '../db.js';

/** Orgs the user is a member of, oldest first. Includes their role. */
export async function listUserOrgs(userId) {
  const { rows } = await query(
    `SELECT o.id, o.name, o.slug, m.role, o.created_at
     FROM organizations o
     JOIN memberships m ON m.org_id = o.id
     WHERE m.user_id = $1
     ORDER BY o.id`,
    [userId],
  );
  return rows;
}

/** True if the user is a member of the org — the scoping guard for writes. */
export async function isMember(userId, orgId) {
  const { rows } = await query(
    'SELECT 1 FROM memberships WHERE user_id = $1 AND org_id = $2 LIMIT 1',
    [userId, orgId],
  );
  return rows.length > 0;
}

/**
 * The user's primary org — the one new projects default into. The oldest org
 * they belong to (their default org, or the first they created).
 */
export async function primaryOrgId(userId) {
  const { rows } = await query(
    `SELECT o.id
     FROM organizations o
     JOIN memberships m ON m.org_id = o.id
     WHERE m.user_id = $1
     ORDER BY o.id
     LIMIT 1`,
    [userId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Create an org and make the user its owner, in one transaction so a failed
 * membership insert can't leave an ownerless org. Returns the new org row.
 */
export async function createOrg({ name, slug, userId }) {
  return transaction(() => {
    const { rows } = querySync(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2)
       RETURNING id, name, slug, created_at`,
      [name, slug],
    );
    const org = rows[0];
    querySync(
      `INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, 'owner')`,
      [userId, org.id],
    );
    return { ...org, role: 'owner' };
  });
}
