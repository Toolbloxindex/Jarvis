// Points Supabase Auth's emails (sign-in links, confirmations, password resets) at Resend.
// Supabase's built-in mailer only delivers to the project's team members (2 emails/hour).
//
//   SUPABASE_ACCESS_TOKEN=sbp_... RESEND_API_KEY=re_... RESEND_FROM="Housewatch <alerts@yourdomain.nl>" \
//     node scripts/configure-auth-email.mjs
//
// Changes only the SMTP keys, the sender name and the email rate limit; nothing else.
// RESEND_FROM must use a domain verified in Resend.

const ref = process.env.SUPABASE_PROJECT_REF || 'xwgtisswsuykvzrbblhw';
const token = process.env.SUPABASE_ACCESS_TOKEN;
const apiKey = process.env.RESEND_API_KEY;
const from = process.env.RESEND_FROM;
if (!token || !apiKey || !from) {
  console.error('Set SUPABASE_ACCESS_TOKEN, RESEND_API_KEY and RESEND_FROM.');
  process.exit(1);
}
const match = from.match(/^\s*(?:"?([^"<]*?)"?\s*)?<?([^<>\s]+@[^<>\s]+)>?\s*$/);
if (!match) {
  console.error('RESEND_FROM must look like "Housewatch <alerts@yourdomain.nl>".');
  process.exit(1);
}
const [, name, address] = match;
const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
  method: 'PATCH',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    smtp_host: 'smtp.resend.com',
    smtp_port: '465',
    smtp_user: 'resend',
    smtp_pass: apiKey,
    smtp_admin_email: address,
    smtp_sender_name: name?.trim() || 'Housewatch',
    rate_limit_email_sent: 30,
  }),
});
if (!res.ok) {
  console.error(`Supabase answered ${res.status}.`);
  process.exit(1);
}
const config = await res.json();
console.log(`Auth emails now go through ${config.smtp_host} from ${config.smtp_admin_email}.`);
