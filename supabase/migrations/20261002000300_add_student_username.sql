-- =============================================================
-- DEVELOPMENT-ONLY username authentication.
--
-- Supabase Auth has no username login, so the app maps each username to an
-- internal, non-deliverable auth email:  <username>@users.invalid
-- (.invalid is reserved by RFC 2606 and can never receive mail).
-- Supabase Auth still owns passwords, hashing and sessions.
--
-- Requires "Confirm email" to be OFF in Supabase Auth settings.
-- To be redesigned when real email authentication is introduced.
--
-- This migration:
--   1. adds students.username (unique, ^[a-z0-9_]{3,30}$)
--   2. updates handle_new_student() to derive username from the auth email
--      and reject any email outside users.invalid
--   3. makes username NOT NULL only if no existing row lacks one
--      (existing rows are NOT modified here)
--
-- Unchanged: student_id generation, is_approved default, RLS policies,
-- column grants (students still cannot update username).
-- =============================================================

begin;

-- 1. Column + constraints (nullable first so existing rows are untouched)
alter table public.students
  add column if not exists username text;

alter table public.students
  drop constraint if exists students_username_format;
alter table public.students
  add constraint students_username_format
  check (username ~ '^[a-z0-9_]{3,30}$');

alter table public.students
  drop constraint if exists students_username_key;
alter table public.students
  add constraint students_username_key unique (username);

-- 2. Trigger function: username comes from the auth email, never from metadata.
create or replace function public.handle_new_student()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_email text := lower(new.email);
begin
  -- Only internal username emails are accepted in this phase.
  if auth_email is null or auth_email !~ '^[a-z0-9_]{3,30}@users\.invalid$' then
    raise exception 'Invalid auth email for username registration'
      using errcode = 'check_violation';
  end if;

  -- student_id, is_approved and created_at come from the table defaults.
  -- Missing/blank profile fields become NULL and violate NOT NULL, which
  -- aborts the signup instead of leaving an auth user without a students row.
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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_student();

-- 3. NOT NULL only when every existing row already has a username.
do $$
declare
  missing integer;
begin
  select count(*) into missing from public.students where username is null;
  if missing = 0 then
    alter table public.students alter column username set not null;
  else
    raise notice '% existing students row(s) have no username; NOT NULL not applied yet', missing;
  end if;
end;
$$;

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
