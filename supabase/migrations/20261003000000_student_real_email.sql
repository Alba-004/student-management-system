-- =============================================================
-- Real student email (separate from the internal Auth login email).
--
-- Until now public.students.email held the INTERNAL Auth address
-- <username>@users.invalid (copied by handle_new_student). That column is
-- renamed to auth_email (values, NOT NULL and UNIQUE kept), and a new
-- nullable students.email holds the student's REAL email address.
--
--   * Existing rows get email = NULL (no addresses are invented).
--   * New students must provide it: handle_new_student() requires
--     raw_user_meta_data->>'contact_email' (enforced in the trigger, not with
--     NOT NULL, so existing rows stay valid).
--   * Stored trimmed + lowercase, valid format, unique, never *.invalid.
--   * Once set, it cannot be cleared again.
--   * Students may update their own real email (column grant + existing
--     "Students can update own row" policy). Auth login is unchanged.
--
-- Also adds welcome_email_sent_at so the welcome email can be sent at most
-- once per student (written only server-side; not granted to students).
--
-- Unchanged: Auth login emails, username, student_id, is_approved,
-- RLS policies, admin functions.
-- =============================================================

begin;

-- Safe to re-run: every step inspects the CURRENT schema (columns, and which
-- column each constraint/index is actually on) instead of assuming the
-- original one. A database where this migration already ran is left as is.

-- 1. Keep the internal Auth email under an explicit name (auth_email).
do $$
declare
  has_email      boolean;
  has_auth_email boolean;
  auth_attnum    smallint;
begin
  select exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'students'
                   and column_name = 'email'),
         exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'students'
                   and column_name = 'auth_email')
    into has_email, has_auth_email;

  if not has_auth_email then
    if not has_email then
      raise exception 'public.students has neither email nor auth_email; unexpected schema';
    end if;
    -- Original schema: email holds <username>@users.invalid. Values,
    -- NOT NULL and the unique constraint move with the column.
    alter table public.students rename column email to auth_email;
  end if;

  select attnum into auth_attnum
  from pg_attribute
  where attrelid = 'public.students'::regclass and attname = 'auth_email' and not attisdropped;

  -- Rename the ORIGINAL constraints only while they still belong to auth_email.
  -- (After a previous run, students_email_key is the NEW real-email constraint
  -- and must not be touched.)
  if exists (select 1 from pg_constraint
             where conrelid = 'public.students'::regclass
               and conname = 'students_email_key'
               and contype = 'u'
               and conkey = array[auth_attnum]) then
    if exists (select 1 from pg_constraint
               where conrelid = 'public.students'::regclass
                 and conname = 'students_auth_email_key') then
      raise exception 'Both students_email_key and students_auth_email_key exist on auth_email; inspect manually';
    end if;
    alter table public.students rename constraint students_email_key to students_auth_email_key;
  end if;

  if exists (select 1 from pg_constraint
             where conrelid = 'public.students'::regclass
               and conname = 'students_email_check'
               and contype = 'c'
               and conkey = array[auth_attnum])
     and not exists (select 1 from pg_constraint
                     where conrelid = 'public.students'::regclass
                       and conname = 'students_auth_email_check') then
    alter table public.students rename constraint students_email_check to students_auth_email_check;
  end if;
end;
$$;

-- 2. Real email + welcome tracking.
alter table public.students add column if not exists email text;
alter table public.students add column if not exists welcome_email_sent_at timestamptz;

-- Format rule: replaced in place, so re-running never duplicates it.
alter table public.students drop constraint if exists students_email_format;
alter table public.students
  add constraint students_email_format
  check (
    email is null
    or (
      email = lower(email)
      and length(email) <= 254
      and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
      and email !~ '\.invalid$'
    )
  );

-- Uniqueness: add only if no unique constraint/index on (email) exists yet.
do $$
declare
  email_attnum smallint;
begin
  select attnum into email_attnum
  from pg_attribute
  where attrelid = 'public.students'::regclass and attname = 'email' and not attisdropped;

  if not exists (select 1 from pg_index
                 where indrelid = 'public.students'::regclass
                   and indisunique
                   and indnatts = 1 and indkey[0] = email_attnum) then
    if exists (select 1 from pg_constraint
               where conrelid = 'public.students'::regclass
                 and conname = 'students_email_key') then
      raise exception 'students_email_key exists but is not a unique constraint on email; inspect manually';
    end if;
    alter table public.students add constraint students_email_key unique (email);
  end if;
end;
$$;

-- 3. Normalize on write; never allow clearing a real email once set.
create or replace function public.normalize_student_email()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.email := nullif(lower(trim(new.email)), '');
  if tg_op = 'UPDATE' and old.email is not null and new.email is null then
    raise exception 'Email cannot be removed'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.normalize_student_email() from public, anon, authenticated;

drop trigger if exists normalize_student_email on public.students;
create trigger normalize_student_email
  before insert or update of email on public.students
  for each row
  execute function public.normalize_student_email();

-- 4. Students may edit their own real email (row limited by existing RLS policy).
grant update (email) on table public.students to authenticated;

-- 5. Signup trigger: admin path unchanged; students now also store the real email.
create or replace function public.handle_new_student()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_email text := lower(new.email);
  contact_email text := nullif(lower(trim(new.raw_user_meta_data ->> 'contact_email')), '');
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

  -- New students must provide a real email (format/uniqueness enforced by constraints).
  if contact_email is null then
    raise exception 'A real email address is required'
      using errcode = 'check_violation';
  end if;

  -- student_id, is_approved and created_at come from the table defaults.
  insert into public.students (id, auth_email, email, username, full_name, phone, major)
  values (
    new.id,
    auth_email,
    contact_email,
    split_part(auth_email, '@', 1),
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'phone'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'major'), '')
  );
  return new;
end;
$$;

revoke execute on function public.handle_new_student() from public, anon, authenticated;

-- Verify the final schema (rolls everything back if anything is off).
do $$
declare
  auth_attnum  smallint;
  email_attnum smallint;
begin
  select attnum into auth_attnum from pg_attribute
  where attrelid = 'public.students'::regclass and attname = 'auth_email' and not attisdropped;
  select attnum into email_attnum from pg_attribute
  where attrelid = 'public.students'::regclass and attname = 'email' and not attisdropped;

  if auth_attnum is null or email_attnum is null then
    raise exception 'students.auth_email or students.email is missing';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'students'
                   and column_name = 'welcome_email_sent_at') then
    raise exception 'students.welcome_email_sent_at is missing';
  end if;
  if (select count(*) from pg_index
      where indrelid = 'public.students'::regclass and indisunique
        and indnatts = 1 and indkey[0] = auth_attnum) <> 1 then
    raise exception 'expected exactly one unique index on students.auth_email';
  end if;
  if (select count(*) from pg_index
      where indrelid = 'public.students'::regclass and indisunique
        and indnatts = 1 and indkey[0] = email_attnum) <> 1 then
    raise exception 'expected exactly one unique index on students.email';
  end if;
  if (select count(*) from pg_constraint
      where conrelid = 'public.students'::regclass and conname = 'students_email_format') <> 1 then
    raise exception 'students_email_format is missing';
  end if;
end;
$$;

-- Fail loudly (and roll back) if the signup trigger is not wired correctly.
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
