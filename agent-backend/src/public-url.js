import { config } from './config.js';

/**
 * Absolute URL on the public origin (KUHN_APP_URL) for links that leave the
 * request — magic links, invitations, review links. Never built from the
 * request's Host / X-Forwarded-Host: anyone who can reach the port directly
 * could set those and have a victim's login token mailed to their own domain.
 */
export function publicUrl(path) {
  return `${config.auth.appUrl.replace(/\/+$/, '')}${path}`;
}
