-- =============================================================
-- Admin role (single admin), admin read access to students,
-- and an admin-only approval function.
--
-- Admin account (DEVELOPMENT-ONLY mapping, like students):
--   login username <name>  ->  auth email <name>@admin.invalid
-- The admin is never created through student registration. Setup:
--   1. SQL Editor:  insert into public.admins (email) values ('<name>@admin.invalid');
--   2. Dashboard:   Authentication -> Users -> Add user -> same email + password
--      (auto confirm). The trigger links the new auth user to the admins row.
--
-- Unchanged: student registration (users.invalid), student_id generation,
-- is_approved default, existing student RLS policies and column grants.
-- =============================================================

begin;

-- 1. admins: at most one row (singleton), never exposed directly to clients.
create table if not exists public.admins (
  singleton  boolean primary key default true check (singleton),
  email      text not null unique
             check (email ~ '^[a-z0-9_]{3,30}@admin\.invalid$'),
  user_id    uuid unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;
-- No policies and no grants: only SECURITY DEFINER functions and the
-- postgres role (SQL Editor) can read or write this table.
revoke all on table public.admins from anon, authenticated;

-- 2. is_admin(): true only for the linked admin's session.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admins a
    where a.user_id is not null
      and a.user_id = (select auth.uid())
  );
$$;

revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- 3. Trigger: students path unchanged; admin.invalid only for the
--    pre-registered, not-yet-linked admin email. Everything else rejected.
create or replace function public.handle_new_student()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_email text := lower(new.email);
begin
  if auth_email ~ '^[a-z0-9_]{3,30}@admin\.invalid$' then
    update public.admins
       set user_id = new.id
     where email = auth_email
       and user_id is null;
    if not found then
      raise exception 'Admin account is not pre-registered'
        using errcode = 'check_violation';
    end if;
    return new;  -- admins get no students row
  end if;

  -- Only internal username emails are accepted for students.
  if auth_email is null or auth_email !~ '^[a-z0-9_]{3,30}@users\.invalid$' then
    raise exception 'Invalid auth email for username registration'
      using errcode = 'check_violation';
  end if;

  -- student_id, is_approved and created_at come from the table defaults.
  insert into public.students (id, email, username, full_name, phone, major)
  values (
    new.id,
    auth_email,
    split_part(auth_email, '@', 1),
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'phone'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'major'), '')
  );
  return new;
end;
$$;

revoke execute on function public.handle_new_student() from public, anon, authenticated;
-- The existing on_auth_user_created trigger already calls this function by name.

-- 4. Admin can read every students row (in addition to "view own row").
drop policy if exists "Admin can view all students" on public.students;
create policy "Admin can view all students"
  on public.students
  for select
  to authenticated
  using ((select public.is_admin()));

-- 5. Approval goes through this function only. is_approved is NOT granted to
--    the authenticated role, so students still cannot change it themselves.
create or replace function public.set_student_approval(p_student_id uuid, p_approved boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only the admin can change approval status'
      using errcode = 'insufficient_privilege';
  end if;

  if p_approved is null then
    raise exception 'Approval value is required'
      using errcode = 'null_value_not_allowed';
  end if;

  update public.students
     set is_approved = p_approved
   where id = p_student_id;

  if not found then
    raise exception 'Student not found'
      using errcode = 'no_data_found';
  end if;

  return p_approved;
end;
$$;

revoke execute on function public.set_student_approval(uuid, boolean) from public, anon;
grant execute on function public.set_student_approval(uuid, boolean) to authenticated;

-- Fail loudly (and roll back) if the trigger is not wired correctly.
do $$
begin
  if not exists (
    select 1
    from pg_trigger t
    where t.tgrelid = 'auth.users'::regclass
      and t.tgname = 'on_auth_user_created'
      and t.tgfoid = 'public.handle_new_student()'::regprocedure
      and t.tgenabled <> 'D'
  ) then
    raise exception 'on_auth_user_created is not wired to public.handle_new_student()';
  end if;
end;
$$;

commit;
