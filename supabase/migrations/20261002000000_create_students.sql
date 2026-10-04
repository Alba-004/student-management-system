-- =============================================================
-- students table, student_id generation, and student RLS policies
-- =============================================================

-- 1. Sequence for the numeric part of student_id.
--    Gives 1..99999, which becomes 26000001..26099999.
--    NO CYCLE: once exhausted it raises an error instead of reusing numbers.
create sequence if not exists public.student_id_seq
  as integer
  start with 1
  increment by 1
  minvalue 1
  maxvalue 99999
  no cycle;

-- 2. Table
create table if not exists public.students (
  id          uuid primary key default auth.uid()
              references auth.users (id) on delete cascade,
  student_id  text not null unique
              default ('260' || lpad(nextval('public.student_id_seq')::text, 5, '0'))
              check (student_id ~ '^260[0-9]{5}$'),
  full_name   text not null check (length(trim(full_name)) > 0),
  email       text not null unique check (length(trim(email)) > 0),
  phone       text not null check (length(trim(phone)) > 0),
  major       text not null check (length(trim(major)) > 0),
  is_approved boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Tie the sequence to the column (dropped together, and pg_dump keeps them in step).
alter sequence public.student_id_seq owned by public.students.student_id;

-- 3. Row Level Security
alter table public.students enable row level security;

-- 4. Table privileges (the outer gate; RLS then filters rows)
--    anon: nothing.
--    authenticated: SELECT the row, UPDATE only profile fields.
--      They cannot change id, student_id, email, is_approved or created_at,
--      and they get no INSERT or DELETE.
revoke all on table public.students from anon, authenticated;
grant select on table public.students to authenticated;
grant update (full_name, phone, major) on table public.students to authenticated;

revoke all on sequence public.student_id_seq from anon, authenticated;
grant usage on sequence public.student_id_seq to service_role;

-- 5. Policies: a student sees and updates only their own row.
--    No INSERT or DELETE policies exist, so RLS denies both to students.
drop policy if exists "Students can view own row" on public.students;
create policy "Students can view own row"
  on public.students
  for select
  to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "Students can update own row" on public.students;
create policy "Students can update own row"
  on public.students
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
