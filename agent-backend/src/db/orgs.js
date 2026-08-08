// Organization queries (story 005; roles + suspension in story 010-003 /
// epic 011). Orgs are the tenant scope: a user reaches projects through org
// memberships. All listing here is membership-filtered so a user only ever
// sees orgs they belong to. checkOrgAccess is THE tenancy chokepoint — every
// role/suspension decision funnels through it, and it never consults
// users.is_superadmin (a super-admin without a membership is a stranger to
// every org's content).

import { query, querySync, transaction } from '../db.js';

/** Role enum, low → high. The single shared constant — never re-declare. */
export const ROLES = ['viewer', 'editor', 'owner'];
export const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };

/** Thrown when a role change/removal would leave an org with zero owners. */
export class LastOwnerError extends Error {
  constructor(message = 'organization must keep at least one owner') {
    super(message);
    this.code = 'last_owner';
  }
}

/**
 * The tenancy chokepoint. Membership + role threshold + org status in one
 * query. NEVER consults is_superadmin. Decision order: no membership →
 * not-member (404 non-leaking upstream); suspended → suspended (membership
 * confirmed first so routes 403, not 404); rank too low → role.
 * @returns {Promise<
 *   { ok: true, role: 'owner'|'editor'|'viewer',
 *     org: { id, name, slug, status, settings } }
 *   | { ok: false, reason: 'not-member' | 'role' | 'suspended', role?: string }>}
 */
export async function checkOrgAccess(userId, orgId, minRole = 'viewer') {
  if (!ROLE_RANK[minRole]) throw new Error(`unknown role threshold: ${minRole}`);
  const { rows } = await query(
    `SELECT m.role, o.id, o.name, o.slug, o.status, o.settings
     FROM memberships m
     JOIN organizations o ON o.id = m.org_id
     WHERE m.user_id = $1 AND m.org_id = $2`,
    [userId, orgId],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not-member' };
  if (row.status === 'suspended') return { ok: false, reason: 'suspended', role: row.role };
  if (ROLE_RANK[row.role] < ROLE_RANK[minRole]) {
    return { ok: false, reason: 'role', role: row.role };
  }
  return {
    ok: true,
    role: row.role,
    org: {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      settings: JSON.parse(row.settings || '{}'),
    },
  };
}

/** Orgs the user is a member of, oldest first. Includes role and status. */
export async function listUserOrgs(userId) {
  const { rows } = await query(
    `SELECT o.id, o.name, o.slug, m.role, o.status, o.created_at
     FROM organizations o
     JOIN memberships m ON m.org_id = o.id
     WHERE m.user_id = $1
     ORDER BY o.id`,
    [userId],
  );
  return rows;
}

/**
 * True if the user is a member of the org — the scoping guard for writes.
 * Routed through the chokepoint, so a suspended org also refuses here.
 */
export async function isMember(userId, orgId) {
  return (await checkOrgAccess(userId, orgId)).ok;
}

/** Members of an org, owners first then by email. */
export async function listOrgMembers(orgId) {
  const { rows } = await query(
    `SELECT m.user_id, u.email, u.display_name, m.role, m.created_at
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.org_id = $1
     ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, u.email`,
    [orgId],
  );
  return rows;
}

/** The org's owner count — the last-owner invariant, read inside a transaction. */
function ownerCount(orgId) {
  const { rows } = querySync(
    "SELECT COUNT(*) AS n FROM memberships WHERE org_id = $1 AND role = 'owner'",
    [orgId],
  );
  return rows[0].n;
}

/**
 * Change a member's role. Refuses to demote the org's last owner.
 * @throws {LastOwnerError} when the change would leave zero owners
 * @returns {Promise<object|null>} the updated membership row, or null if the
 *   user is not a member
 */
export async function setMemberRole(orgId, userId, role) {
  if (!ROLES.includes(role)) throw new Error(`unknown role: ${role}`);
  return transaction(() => {
    const { rows } = querySync(
      'SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2',
      [orgId, userId],
    );
    const current = rows[0];
    if (!current) return null;
    if (current.role === 'owner' && role !== 'owner' && ownerCount(orgId) <= 1) {
      throw new LastOwnerError();
    }
    const { rows: updated } = querySync(
      `UPDATE memberships SET role = $3 WHERE org_id = $1 AND user_id = $2
       RETURNING user_id, org_id, role, created_at`,
      [orgId, userId, role],
    );
    return updated[0];
  });
}

/**
 * Remove a member. Refuses to remove the org's last owner.
 * @throws {LastOwnerError} when the removal would leave zero owners
 * @returns {Promise<boolean>} false if the user was not a member
 */
export async function removeMember(orgId, userId) {
  return transaction(() => {
    const { rows } = querySync(
      'SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2',
      [orgId, userId],
    );
    const current = rows[0];
    if (!current) return false;
    if (current.role === 'owner' && ownerCount(orgId) <= 1) {
      throw new LastOwnerError();
    }
    const { rowCount } = querySync(
      'DELETE FROM memberships WHERE org_id = $1 AND user_id = $2',
      [orgId, userId],
    );
    return rowCount > 0;
  });
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
 * Create an org, in one transaction with its first membership. With a userId
 * the user becomes owner (the classic flow); userId null creates an org with
 * NO membership — super-admin creation (story 011-001), where the creator
 * deliberately gets no access.
 */
export async function createOrg({ name, slug, userId = null }) {
  return transaction(() => {
    const { rows } = querySync(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2)
       RETURNING id, name, slug, status, created_at`,
      [name, slug],
    );
    const org = rows[0];
    if (userId == null) return org;
    querySync(
      `INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, 'owner')`,
      [userId, org.id],
    );
    return { ...org, role: 'owner' };
  });
}
