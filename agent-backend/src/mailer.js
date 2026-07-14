// Story 007-002: magic-link delivery. Two transports, picked by config:
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
