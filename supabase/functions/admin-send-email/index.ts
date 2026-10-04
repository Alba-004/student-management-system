// Supabase Edge Function: admin-send-email
//
// Admin-only. Sends the same subject/message to one or more students, looked
// up by id. Recipient addresses come from public.students.email on the
// server; the browser only sends student ids, subject and message.
//
// Uses Resend's batch API (up to 100 emails per request) server-side, so the
// browser never fires one request per student.
//
// Secrets (server-side only, never in the browser):
//   RESEND_API_KEY      Resend API key
//   RESEND_FROM_EMAIL   e.g. "Student Management <onboarding@resend.dev>"
//   SB_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY  (built in)
//
// Request:  POST { studentIds: string[], subject: string, message: string }
// Response: 200 { result: "sent" | "partial_failure", sent, failed, skipped, notFound }
//           4xx/5xx { error: "<code>", ...counts? } — short codes only.
// The message is plain text; it is HTML-escaped before being placed in the email.

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const RESEND_BATCH_ENDPOINT = 'https://api.resend.com/emails/batch';
const RESEND_BATCH_SIZE = 100;
// Resend's default rate limit is 2 requests/second; space out batch calls.
const BATCH_DELAY_MS = 600;
const MAX_RECIPIENTS = 500;
// Keep in sync with src/components/SendEmailDialog.tsx
const SUBJECT_MAX_LENGTH = 150;
const MESSAGE_MAX_LENGTH = 5000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Ids per students lookup; keeps the PostgREST `in (...)` URL short.
const LOOKUP_CHUNK_SIZE = 100;
// Same rule as src/lib/profileValidation.ts and the students_email_format constraint.
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EMAIL_MAX_LENGTH = 254;

function isDeliverableEmail(email: string): boolean {
  return email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email) && !email.endsWith('.invalid');
}

// Shape of the students columns selected below (email is nullable for older rows).
type StudentEmailRow = { id: string; full_name: string; email: string | null };
// A student that can actually receive email.
type EmailRecipient = StudentEmailRow & { email: string };

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

// Plain text -> safe HTML: escape everything, blank lines become paragraphs,
// single newlines become <br>.
function plainTextToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:#3c3c43;">${escapeHtml(
          paragraph,
        ).replace(/\n/g, '<br>')}</p>`,
    )
    .join('');
}

function manualEmail(fullName: string, subject: string, message: string) {
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f2f2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:20px;padding:32px;">
          <tr><td>
            <h1 style="margin:0 0 20px;font-size:22px;color:#1d1d1f;">${escapeHtml(subject)}</h1>
            <p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:#3c3c43;">Hello ${escapeHtml(fullName)},</p>
            ${plainTextToHtml(message)}
          </td></tr>
        </table>
        <p style="margin:16px 0 0;font-size:12px;color:#8e8e93;">Sent by the administrator of Student Management System</p>
      </td></tr>
    </table>
  </body>
</html>`;
  const text = `Hello ${fullName},\n\n${message}\n\n— Student Management System`;
  return { html, text };
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
    console.error('admin-send-email: missing Supabase configuration');
    return json(500, { error: 'server_misconfigured' });
  }

  // 1. Authenticate the caller.
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return json(401, { error: 'not_authenticated' });

  const callerClient = createClient(supabaseUrl, publicKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: callerData, error: callerError } = await callerClient.auth.getUser(token);
  if (callerError || !callerData.user) return json(401, { error: 'not_authenticated' });

  // 2. Authorize: only the admin (decided by the database).
  const { data: isAdmin, error: isAdminError } = await callerClient.rpc('is_admin');
  if (isAdminError) {
    console.error('admin-send-email: is_admin failed', isAdminError.code);
    return json(500, { error: 'database_error' });
  }
  if (isAdmin !== true) return json(403, { error: 'forbidden' });

  if (!resendKey || !fromEmail) {
    console.error('admin-send-email: missing Resend configuration');
    return json(500, { error: 'email_not_configured' });
  }

  // 3. Validate input.
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== 'object') return json(400, { error: 'invalid_request' });
    body = parsed as Record<string, unknown>;
  } catch {
    return json(400, { error: 'invalid_request' });
  }

  const rawIds: unknown[] = Array.isArray(body.studentIds) ? body.studentIds : [];
  // Every id must be a UUID; duplicates are allowed and removed.
  const allIdsValid = rawIds.every((id) => typeof id === 'string' && UUID_PATTERN.test(id));
  const studentIds = allIdsValid ? [...new Set(rawIds as string[])] : [];
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const message =
    typeof body.message === 'string' ? body.message.replace(/\r\n?/g, '\n').trim() : '';

  const fields: Record<string, string> = {};
  if (!allIdsValid || studentIds.length === 0) fields.studentIds = 'invalid';
  else if (studentIds.length > MAX_RECIPIENTS) fields.studentIds = 'too_many';
  if (!subject) fields.subject = 'required';
  else if (subject.length > SUBJECT_MAX_LENGTH) fields.subject = 'too_long';
  else if (/[\r\n]/.test(subject)) fields.subject = 'invalid';
  if (!message) fields.message = 'required';
  else if (message.length > MESSAGE_MAX_LENGTH) fields.message = 'too_long';
  if (Object.keys(fields).length > 0) return json(400, { error: 'validation_failed', fields });

  // 4. Resolve recipients on the server.
  const adminClient = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // The client has no generated schema types, so state the selected row shape here.
  const found: StudentEmailRow[] = [];
  for (let i = 0; i < studentIds.length; i += LOOKUP_CHUNK_SIZE) {
    const { data: rows, error: rowsError } = await adminClient
      .from('students')
      .select('id, full_name, email')
      .in('id', studentIds.slice(i, i + LOOKUP_CHUNK_SIZE));
    if (rowsError) {
      console.error('admin-send-email: students lookup failed', rowsError.code);
      return json(500, { error: 'database_error' });
    }
    const batch: StudentEmailRow[] = rows ?? [];
    found.push(...batch);
  }

  const notFound = studentIds.length - found.length;
  // Missing or invalid stored addresses are skipped, never sent to.
  const recipients = found.filter(
    (r): r is EmailRecipient => typeof r.email === 'string' && isDeliverableEmail(r.email),
  );
  const skipped = found.length - recipients.length;

  if (recipients.length === 0) {
    return json(422, { error: 'student_email_missing', sent: 0, failed: 0, skipped, notFound });
  }

  // 5. Send with Resend's batch API, in chunks of 100.
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < recipients.length; i += RESEND_BATCH_SIZE) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    const chunk = recipients.slice(i, i + RESEND_BATCH_SIZE);
    const payload = chunk.map((r) => {
      const content = manualEmail(r.full_name, subject, message);
      return { from: fromEmail, to: [r.email], subject, html: content.html, text: content.text };
    });
    try {
      const response = await fetch(RESEND_BATCH_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        sent += chunk.length;
      } else {
        failed += chunk.length;
        console.error('admin-send-email: provider status', response.status);
      }
    } catch {
      failed += chunk.length;
      console.error('admin-send-email: provider request failed');
    }
  }

  if (sent === 0) {
    return json(502, { error: 'send_failed', sent, failed, skipped, notFound });
  }
  return json(200, {
    result: failed > 0 ? 'partial_failure' : 'sent',
    sent,
    failed,
    skipped,
    notFound,
  });
});
