-- =============================================================
-- Admin-only profile editing for any student.
--
-- Students keep editing their own row through the existing
-- "Students can update own row" policy + column grants. The admin gets
-- no UPDATE policy or extra grants; instead this function is the only
-- path for the admin to change another student's profile, and it can
-- only touch full_name, phone and major.
--
-- Unchanged: RLS policies, column grants, approval (set_student_approval),
-- username, student_id, email, is_approved.
-- =============================================================

begin;

create or replace function public.admin_update_student_profile(
  p_student_id uuid,
  p_full_name  text,
  p_phone      text,
  p_major      text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Only the admin can edit student profiles'
      using errcode = 'insufficient_privilege';
  end if;

  -- NULL/blank values are rejected by the table's NOT NULL and
  -- length(trim(...)) > 0 check constraints.
  update public.students
     set full_name = trim(p_full_name),
         phone     = trim(p_phone),
         major     = trim(p_major)
   where id = p_student_id;

  if not found then
    raise exception 'Student not found'
      using errcode = 'no_data_found';
  end if;
end;
$$;

revoke execute on function public.admin_update_student_profile(uuid, text, text, text) from public, anon;
grant execute on function public.admin_update_student_profile(uuid, text, text, text) to authenticated;

commit;
