// Supabase Edge Function: admin-create-student
//
// Lets the admin create ONE student account. The Auth user is created with the
// Auth Admin API; the existing on_auth_user_created trigger
// (public.handle_new_student) then creates the students row, with the
// database-generated student_id and is_approved = false.
//
// Why an Edge Function: auth.admin.createUser requires the service-role/secret
// key, which exists only in this server-side environment and never reaches the
// browser.
//
// DEVELOPMENT-ONLY username mapping (same as registration):
//   username -> <username>@users.invalid
//
// Request:  POST { username, fullName, email, phone, major, password }
//           email = the student's REAL email (stored in students.email; not used for login)
//           Authorization: Bearer <caller's access token>   (set by supabase-js)
// Response: 200 { studentId, student_id, username }
//           4xx/5xx { error: "<code>", fields?: { <field>: "<code>" } }
// The request body contains a password: it is never logged, stored or returned.

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const AUTH_EMAIL_DOMAIN = 'users.invalid';
const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;
// Same rule as src/lib/profileValidation.ts
const PHONE_PATTERN = /^\+?[0-9\s()-]{6,20}$/;
const MIN_PASSWORD_LENGTH = 6;
// Same rule as src/lib/profileValidation.ts and the students_email_format constraint
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EMAIL_MAX_LENGTH = 254;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  // Public key: the caller's own apikey header, falling back to the project's anon key.
  const publicKey = req.headers.get('apikey') ?? Deno.env.get('SUPABASE_ANON_KEY');
  // Secret key: a custom SB_SECRET_KEY secret if set, else the built-in service-role key.
  const secretKey = Deno.env.get('SB_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !publicKey || !secretKey) {
    console.error('admin-create-student: missing environment configuration');
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

  // 2. Authorize: the database decides who the admin is (same is_admin() as the app).
  const { data: isAdmin, error: isAdminError } = await callerClient.rpc('is_admin');
  if (isAdminError) {
    console.error('admin-create-student: is_admin failed', isAdminError.code);
    return json(500, { error: 'database_error' });
  }
  if (isAdmin !== true) return json(403, { error: 'forbidden' });

  // 3. Validate input on the server (authoritative).
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== 'object') return json(400, { error: 'invalid_request' });
    body = parsed as Record<string, unknown>;
  } catch {
    return json(400, { error: 'invalid_request' });
  }

  const username = asTrimmedString(body.username).toLowerCase();
  const fullName = asTrimmedString(body.fullName);
  const phone = asTrimmedString(body.phone);
  const major = asTrimmedString(body.major);
  const email = asTrimmedString(body.email).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';

  const fields: Record<string, string> = {};
  if (!username) fields.username = 'required';
  else if (!USERNAME_PATTERN.test(username)) fields.username = 'invalid';
  if (!fullName) fields.fullName = 'required';
  if (!email) fields.email = 'required';
  else if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email) || email.endsWith('.invalid')) {
    fields.email = 'invalid';
  }
  if (!phone) fields.phone = 'required';
  else if (!PHONE_PATTERN.test(phone)) fields.phone = 'invalid';
  if (!major) fields.major = 'required';
  if (!password) fields.password = 'required';
  else if (password.length < MIN_PASSWORD_LENGTH) fields.password = 'too_short';
  if (Object.keys(fields).length > 0) {
    return json(400, { error: 'validation_failed', fields });
  }

  const adminClient = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Real email must be unique (also enforced by students_email_key).
  const { data: emailOwner, error: emailOwnerError } = await adminClient
    .from('students')
    .select('id')
    .eq('email', email)
    .maybeSingle();
  if (emailOwnerError) {
    console.error('admin-create-student: email lookup failed', emailOwnerError.code);
    return json(500, { error: 'database_error' });
  }
  if (emailOwner) return json(409, { error: 'email_taken' });

  // 4. Create the Auth user; the trigger creates the students row in the same transaction.
  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email: `${username}@${AUTH_EMAIL_DOMAIN}`,
    password,
    email_confirm: true, // internal address can never receive mail; no confirmation step
    // contact_email is the REAL email; the trigger stores it in students.email.
    user_metadata: { full_name: fullName, contact_email: email, phone, major },
  });

  if (createError || !created.user) {
    // Log only the code/status — never the request body (contains the password).
    console.error('admin-create-student: createUser failed', createError?.code, createError?.status);
    if (createError?.code === 'email_exists' || createError?.code === 'user_already_exists') {
      return json(409, { error: 'username_taken' });
    }
    if (createError?.code === 'weak_password') return json(422, { error: 'weak_password' });
    return json(502, { error: 'auth_create_failed' });
  }

  const newUserId = created.user.id;

  // 5. Read back the generated student_id.
  const { data: student, error: studentError } = await adminClient
    .from('students')
    .select('student_id, username')
    .eq('id', newUserId)
    .maybeSingle();

  if (studentError || !student) {
    // Should not happen (trigger runs in the same transaction); compensate anyway.
    console.error('admin-create-student: students row missing after create', studentError?.code);
    const { error: cleanupError } = await adminClient.auth.admin.deleteUser(newUserId);
    if (cleanupError) {
      console.error('admin-create-student: cleanup delete failed', cleanupError.code);
    }
    return json(500, { error: 'database_error' });
  }

  return json(200, {
    studentId: newUserId,
    student_id: student.student_id,
    username: student.username,
  });
});
