-- =============================================================
-- Create a students row automatically for every new auth user.
-- Profile fields come from the signup metadata (options.data).
-- student_id, is_approved and created_at use the table defaults.
-- =============================================================

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
  insert into public.students (id, email, full_name, phone, major)
  values (
    new.id,
    new.email,
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'phone'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'major'), '')
  );
  -- Missing fields become NULL and violate NOT NULL, which aborts the signup
  -- instead of leaving an auth user without a valid students row.
  return new;
end;
$$;

-- Only the trigger should run this function, never API callers.
revoke execute on function public.handle_new_student() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_student();
