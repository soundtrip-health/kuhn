// Mail delivery. Two transports, picked by config:
// KUHN_SMTP_URL set → SMTP via nodemailer (lazy-imported so dev and tests
// never load it); unset → the link is printed to the server console, which is
// the whole dev login flow. No mail-provider SDKs.

import { config } from './config.js';

let transportPromise = null;

async function smtpTransport() {
  transportPromise ??= import('nodemailer').then((m) =>
    m.default.createTransport(config.auth.smtpUrl),
  );
  return transportPromise;
}

/** Deliver a login link, by mail or (dev) by server log. */
export async function sendLoginLink(email, url) {
  if (!config.auth.smtpUrl) {
    console.log(`[auth] Magic link for ${email}: ${url}`);
    return;
  }
  const transport = await smtpTransport();
  await transport.sendMail({
    from: config.auth.mailFrom,
    to: email,
    subject: 'Sign in to Kuhn',
    text: [
      'Follow this link to sign in to Kuhn:',
      '',
      url,
      '',
      `The link is valid for ${Math.round(config.auth.tokenTtlMs / 60000)} minutes and can be used once.`,
      'If you did not request it, ignore this message.',
    ].join('\n'),
  });
}

/** Deliver an org invitation link (story 011-002), by mail or (dev) by server log. */
export async function sendInviteLink(email, url, { orgName }) {
  if (!config.auth.smtpUrl) {
    console.log(`[auth] Invitation to ${orgName} for ${email}: ${url}`);
    return;
  }
  const transport = await smtpTransport();
  await transport.sendMail({
    from: config.auth.mailFrom,
    to: email,
    subject: `You're invited to ${orgName} on Kuhn`,
    text: [
      `You've been invited to join ${orgName} on Kuhn.`,
      '',
      'Follow this link to accept the invitation and sign in:',
      '',
      url,
      '',
      `The link is valid for ${Math.round(config.auth.inviteTtlMs / 86400000)} day(s) and can be used once.`,
      'If you were not expecting this invitation, ignore this message.',
    ].join('\n'),
  });
}

/**
 * Tell a stranger their access request is queued (STH-35). This is what an
 * uninvited address gets INSTEAD of a magic link — the install is invite-only,
 * and the copy has to say so rather than leaving someone waiting for a link
 * that is never coming.
 */
export async function sendAccessRequestReceived(email) {
  if (!config.auth.smtpUrl) {
    console.log(`[auth] Access request queued for ${email} (no link sent — invite-only)`);
    return;
  }
  const transport = await smtpTransport();
  await transport.sendMail({
    from: config.auth.mailFrom,
    to: email,
    subject: 'Your Kuhn access request',
    text: [
      'Thanks for your interest in Kuhn.',
      '',
      'Kuhn is invite-only, so we have not sent a sign-in link. Your request',
      'has been added to the queue for an administrator to review. If it is',
      'approved you will receive a separate invitation email with a link to',
      'join an organization.',
      '',
      'If you already belong to an organization here, sign in with the address',
      'your administrator used to invite you.',
      '',
      'If you did not request this, no account was created and you can ignore',
      'this message.',
    ].join('\n'),
  });
}
