-- =============================================================
-- (Re)create the students-row trigger on auth.users.
-- Safe to re-run: replaces the function and recreates the trigger.
-- Does not touch the students table schema, RLS policies, or existing users.
-- =============================================================

begin;

-- SECURITY DEFINER: runs as the function owner, so it can insert into
-- public.students even though students themselves have no INSERT grant/policy.
-- search_path = '' and fully qualified names prevent search_path hijacking.
create or replace function public.handle_new_student()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- student_id, is_approved and created_at come from the table defaults.
  -- Missing/blank profile fields become NULL and violate NOT NULL, which
  -- aborts the signup instead of leaving an auth user without a students row.
  insert into public.students (id, email, full_name, phone, major)
  values (
    new.id,
    new.email,
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'phone'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'major'), '')
  );
  return new;
end;
$$;

-- Only the trigger should run this function, never API callers.
revoke execute on function public.handle_new_student() from public, anon, authenticated;

-- Replaces any existing trigger of this name, whichever function it called.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_student();

-- Fail loudly (and roll back) if the result is not what we expect.
do $$
begin
  if not exists (
    select 1
    from pg_trigger t
    where t.tgrelid = 'auth.users'::regclass
      and t.tgname = 'on_auth_user_created'
      and t.tgfoid = 'public.handle_new_student()'::regprocedure
  ) then
    raise exception 'on_auth_user_created is not wired to public.handle_new_student()';
  end if;
end;
$$;

commit;
