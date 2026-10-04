// Supabase Edge Function: send-welcome-email
//
// Called by the Register page right after a successful signup, using the new
// student's own session. Sends ONE welcome email (via Resend) to the caller's
// real email stored in public.students.email.
//
// Abuse protection: the caller can only trigger an email for THEIR OWN
// students row, and at most once (students.welcome_email_sent_at is claimed
// atomically before sending and released only if sending fails).
//
// Secrets (server-side only, never in the browser):
//   RESEND_API_KEY      Resend API key
//   RESEND_FROM_EMAIL   e.g. "Student Management <onboarding@resend.dev>"
//   SB_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY  (built in) for the students lookup
//
// Response: 200 { sent: true }
//           4xx/5xx { error: "<code>" } — short codes only.
// The password is never part of this flow.

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
// Same rule as src/lib/profileValidation.ts and the students_email_format constraint.
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EMAIL_MAX_LENGTH = 254;

// Shape of the students columns selected below.
type WelcomeRow = {
  full_name: string;
  username: string | null;
  student_id: string;
  email: string | null;
  is_approved: boolean;
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type WelcomeData = { fullName: string; username: string; studentId: string; approved: boolean };

function welcomeEmail({ fullName, username, studentId, approved }: WelcomeData) {
  const status = approved ? 'Approved' : 'Waiting for admin approval';
  const explanation = approved
    ? 'Your account is approved. You can log in with your username and password.'
    : 'An administrator will review your registration. You will be able to log in with your username and password once your account has been approved.';

  const row = (label: string, value: string) => `
    <tr>
      <td style="padding:10px 0;color:#6e6e73;font-size:15px;">${escapeHtml(label)}</td>
      <td style="padding:10px 0;color:#1d1d1f;font-size:15px;font-weight:600;text-align:right;">${escapeHtml(value)}</td>
    </tr>`;

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f2f2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:20px;padding:32px;">
          <tr><td>
            <h1 style="margin:0 0 8px;font-size:24px;color:#1d1d1f;">Welcome, ${escapeHtml(fullName)}!</h1>
            <p style="margin:0 0 24px;font-size:16px;line-height:1.5;color:#3c3c43;">Your student account has been created.</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e5ea;border-bottom:1px solid #e5e5ea;margin-bottom:24px;">
              ${row('Student ID', studentId)}
              ${row('Username', username)}
              ${row('Status', status)}
            </table>
            <p style="margin:0;font-size:15px;line-height:1.5;color:#3c3c43;">${escapeHtml(explanation)}</p>
          </td></tr>
        </table>
        <p style="margin:16px 0 0;font-size:12px;color:#8e8e93;">Student Management System</p>
      </td></tr>
    </table>
  </body>
</html>`;

  const text = [
    `Welcome, ${fullName}!`,
    '',
    'Your student account has been created.',
    '',
    `Student ID: ${studentId}`,
    `Username: ${username}`,
    `Status: ${status}`,
    '',
    explanation,
  ].join('\n');

  return { subject: 'Welcome to Student Management System', html, text };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const publicKey = req.headers.get('apikey') ?? Deno.env.get('SUPABASE_ANON_KEY');
  const secretKey = Deno.env.get('SB_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const resendKey = Deno.env.get('RESEND_API_KEY');
  const fromEmail = Deno.env.get('RESEND_FROM_EMAIL');
  if (!supabaseUrl || !publicKey || !secretKey) {
    console.error('send-welcome-email: missing Supabase configuration');
    return json(500, { error: 'server_misconfigured' });
  }
  if (!resendKey || !fromEmail) {
    console.error('send-welcome-email: missing Resend configuration');
    return json(500, { error: 'email_not_configured' });
  }

  // 1. Authenticate the caller (the newly registered student).
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return json(401, { error: 'not_authenticated' });

  const callerClient = createClient(supabaseUrl, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: callerData, error: callerError } = await callerClient.auth.getUser(token);
  if (callerError || !callerData.user) return json(401, { error: 'not_authenticated' });
  const callerId = callerData.user.id;

  const adminClient = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 2. Atomically claim the one-time welcome email for the caller's own row.
  const { data: claimedRow, error: claimError } = await adminClient
    .from('students')
    .update({ welcome_email_sent_at: new Date().toISOString() })
    .eq('id', callerId)
    .is('welcome_email_sent_at', null)
    .not('email', 'is', null)
    .select('full_name, username, student_id, email, is_approved')
    .maybeSingle();

  if (claimError) {
    console.error('send-welcome-email: claim failed', claimError.code);
    return json(500, { error: 'database_error' });
  }
  const claimed: WelcomeRow | null = claimedRow;

  if (!claimed) {
    const { data: existing, error: existingError } = await adminClient
      .from('students')
      .select('email, welcome_email_sent_at')
      .eq('id', callerId)
      .maybeSingle();
    if (existingError) return json(500, { error: 'database_error' });
    if (!existing) return json(404, { error: 'not_found' });
    if (!existing.email) return json(422, { error: 'student_email_missing' });
    return json(409, { error: 'already_sent' });
  }

  // Never send to a missing or malformed stored address; release the claim instead.
  const recipient = claimed.email ?? '';
  if (
    recipient.length > EMAIL_MAX_LENGTH ||
    !EMAIL_PATTERN.test(recipient) ||
    recipient.endsWith('.invalid')
  ) {
    await adminClient.from('students').update({ welcome_email_sent_at: null }).eq('id', callerId);
    return json(422, { error: 'student_email_invalid' });
  }

  // 3. Send through Resend.
  const content = welcomeEmail({
    fullName: claimed.full_name,
    username: claimed.username ?? '',
    studentId: claimed.student_id,
    approved: claimed.is_approved === true,
  });

  let sent = false;
  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [recipient],
        subject: content.subject,
        html: content.html,
        text: content.text,
      }),
    });
    sent = response.ok;
    if (!sent) console.error('send-welcome-email: provider status', response.status);
  } catch {
    console.error('send-welcome-email: provider request failed');
  }

  if (!sent) {
    // Release the claim so a later retry is possible.
    await adminClient.from('students').update({ welcome_email_sent_at: null }).eq('id', callerId);
    return json(502, { error: 'send_failed' });
  }

  return json(200, { sent: true });
});
