// STH-58: HTTP surface of the slide-theme library. The Kuhn catalog
// (catalog_slide_themes, seeded from slide-themes/catalog.json) is readable
// by any authenticated user; org themes are uploaded CSS text in the DB.
// Same guard contract as the script library: org reads are member-level,
// writes are owner-only and audited.

import { Router } from 'express';

import { config } from '../config.js';
import { recordAuthEvent } from '../db/auth-events.js';
import {
  MARP_BUILTIN_THEMES,
  getOrgTheme,
  listCatalogThemes,
  listOrgThemes,
  setOrgThemeStatus,
  themeNameFromCss,
  upsertOrgTheme,
} from '../db/slide-themes.js';
import { requireOrgRole } from './guards.js';

const router = Router();

const publicCatalogTheme = (row) => ({
  name: row.name,
  title: row.title,
  description: row.description,
  available: !!row.available,
});

// Lists stay light: css comes back only from the single-theme GET.
const publicOrgTheme = (row) => ({
  id: row.id,
  name: row.name,
  title: row.title,
  status: row.status,
  css_bytes: Buffer.byteLength(row.css, 'utf-8'),
  created_at: row.created_at,
  updated_at: row.updated_at,
});

function themesPayload(orgId) {
  const themes = listOrgThemes(orgId);
  const shadowed = new Set(themes.filter((t) => t.status === 'active').map((t) => t.name));
  const catalog = listCatalogThemes().map((row) => ({
    ...publicCatalogTheme(row),
    shadowed: shadowed.has(row.name), // an active org theme of this name wins at render time
  }));
  return { catalog, themes: themes.map(publicOrgTheme) };
}

/** GET /api/slide-themes/catalog — the Kuhn theme catalog. Any authenticated user. */
router.get('/api/slide-themes/catalog', (req, res) => {
  res.json({ themes: listCatalogThemes().map(publicCatalogTheme) });
});

/** GET /api/orgs/:orgId/slide-themes — catalog + this org's themes. */
router.get('/api/orgs/:orgId/slide-themes', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'viewer');
  if (!ctx) return;
  res.json(themesPayload(ctx.orgId));
});

/** GET /api/orgs/:orgId/slide-themes/:name — one org theme with its CSS. */
router.get('/api/orgs/:orgId/slide-themes/:name', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'viewer');
  if (!ctx) return;
  const theme = getOrgTheme(ctx.orgId, req.params.name);
  if (!theme) {
    res.status(404).json({ error: 'theme not found' });
    return;
  }
  res.json({ theme: publicOrgTheme(theme), css: theme.css });
});

/**
 * POST /api/orgs/:orgId/slide-themes — owner, { css, title? }.
 * The theme's name comes from the CSS's required `/* @theme name *​/` header
 * (that is also how marp resolves the deck's `theme:` front matter), so a
 * theme can never render under a name other than the one it declares.
 * Re-uploading a name replaces its CSS and re-activates it.
 */
router.post('/api/orgs/:orgId/slide-themes', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const { css, title } = req.body ?? {};
  if (typeof css !== 'string' || css.trim().length === 0) {
    res.status(400).json({ error: 'css is required', field: 'css' });
    return;
  }
  if (Buffer.byteLength(css, 'utf-8') > config.slideThemes.maxThemeBytes) {
    res.status(413).json({ error: `theme CSS exceeds ${config.slideThemes.maxThemeBytes} bytes` });
    return;
  }
  const name = themeNameFromCss(css);
  if (!name) {
    res.status(400).json({
      error: 'the CSS must declare its marp theme name in a `/* @theme <name> */` comment',
      field: 'css',
    });
    return;
  }
  if (MARP_BUILTIN_THEMES.includes(name)) {
    res.status(400).json({ error: `"${name}" is a marp built-in theme name — pick another @theme name` });
    return;
  }
  const theme = upsertOrgTheme({
    orgId: ctx.orgId,
    name,
    title: typeof title === 'string' && title.trim() ? title.trim() : name,
    css,
    createdBy: req.user.id,
  });
  recordAuthEvent({
    type: 'slide_theme.upload', actorUserId: req.user.id, orgId: ctx.orgId,
    meta: { theme: name },
  });
  res.json({ theme: publicOrgTheme(theme), ...themesPayload(ctx.orgId) });
});

/** PATCH /api/orgs/:orgId/slide-themes/:name — owner, { status: 'active'|'disabled' }. */
router.patch('/api/orgs/:orgId/slide-themes/:name', async (req, res) => {
  const ctx = await requireOrgRole(req, res, req.params.orgId, 'owner');
  if (!ctx) return;
  const status = req.body?.status;
  if (status !== 'active' && status !== 'disabled') {
    res.status(400).json({ error: 'status must be active or disabled', field: 'status' });
    return;
  }
  const updated = setOrgThemeStatus(ctx.orgId, req.params.name, status);
  if (!updated) {
    res.status(404).json({ error: 'theme not found' });
    return;
  }
  recordAuthEvent({
    type: status === 'active' ? 'slide_theme.enable' : 'slide_theme.disable',
    actorUserId: req.user.id, orgId: ctx.orgId,
    meta: { theme: updated.name },
  });
  res.json({ theme: publicOrgTheme(updated) });
});

export default router;
