// Supabase Edge Function: admin-delete-student
//
// Permanently deletes ONE student: their Supabase Auth user, and through
// public.students.id -> auth.users.id ON DELETE CASCADE, their students row.
//
// Why an Edge Function: deleting an Auth user needs the Auth Admin API
// (auth.admin.deleteUser), which requires the service-role/secret key.
// That key exists only in this server-side function's environment and is
// never sent to or used by the browser.
//
// Request:  POST { "studentId": "<auth user id / students.id>" }
//           Authorization: Bearer <caller's access token>   (set by supabase-js)
// Response: 200 { "deleted": true, "studentId": "..." }
//           4xx/5xx { "error": "<code>" }  — codes only, never raw error text.

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
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
    console.error('admin-delete-student: missing environment configuration');
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
  const callerId = callerData.user.id;

  // 2. Authorize: the database decides who the admin is (same is_admin() as the app).
  const { data: isAdmin, error: isAdminError } = await callerClient.rpc('is_admin');
  if (isAdminError) {
    console.error('admin-delete-student: is_admin failed', isAdminError);
    return json(500, { error: 'database_error' });
  }
  if (isAdmin !== true) return json(403, { error: 'forbidden' });

  // 3. Validate the target.
  let studentId: unknown;
  try {
    ({ studentId } = await req.json());
  } catch {
    return json(400, { error: 'invalid_request' });
  }
  if (typeof studentId !== 'string' || !UUID_PATTERN.test(studentId)) {
    return json(400, { error: 'invalid_request' });
  }
  if (studentId === callerId) return json(403, { error: 'cannot_delete_admin' });

  const adminClient = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: targetAdmin, error: targetAdminError } = await adminClient
    .from('admins')
    .select('user_id')
    .eq('user_id', studentId)
    .maybeSingle();
  if (targetAdminError) {
    console.error('admin-delete-student: admins lookup failed', targetAdminError);
    return json(500, { error: 'database_error' });
  }
  if (targetAdmin) return json(403, { error: 'cannot_delete_admin' });

  // Only accounts that have a students row can be deleted here.
  const { data: student, error: studentError } = await adminClient
    .from('students')
    .select('id')
    .eq('id', studentId)
    .maybeSingle();
  if (studentError) {
    console.error('admin-delete-student: students lookup failed', studentError);
    return json(500, { error: 'database_error' });
  }
  if (!student) return json(404, { error: 'not_found' });

  // 4. Delete the Auth user; ON DELETE CASCADE removes the students row.
  const { error: deleteError } = await adminClient.auth.admin.deleteUser(studentId);
  if (deleteError) {
    console.error('admin-delete-student: auth delete failed', deleteError);
    if (deleteError.status === 404) return json(404, { error: 'not_found' });
    return json(502, { error: 'auth_delete_failed' });
  }

  // 5. Confirm the cascade removed the profile.
  const { data: remaining, error: remainingError } = await adminClient
    .from('students')
    .select('id')
    .eq('id', studentId)
    .maybeSingle();
  if (remainingError || remaining) {
    console.error('admin-delete-student: students row still present', remainingError);
    return json(500, { error: 'database_error' });
  }

  return json(200, { deleted: true, studentId });
});
