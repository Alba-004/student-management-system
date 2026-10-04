import { supabase } from './supabase';

/*
 * DEVELOPMENT-ONLY username authentication.
 *
 * Supabase Auth has no username login, so each username is mapped to an
 * internal, non-deliverable auth email: <username>@users.invalid.
 * Supabase Auth still manages passwords, hashing and sessions.
 *
 * Requires "Confirm email" to be OFF in Supabase. No email is ever sent.
 * The database trigger re-derives the username from this email and rejects
 * any other domain, so the mapping cannot be bypassed by calling signUp directly.
 *
 * When real email authentication is added, only this file should need to change.
 */

export const AUTH_EMAIL_DOMAIN = 'users.invalid';
export const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

export function usernameToAuthEmail(rawUsername: string): string {
  const username = normalizeUsername(rawUsername);
  if (!isValidUsername(username)) {
    throw new Error('Invalid username');
  }
  return `${username}@${AUTH_EMAIL_DOMAIN}`;
}

export type StudentSignUp = {
  username: string;
  password: string;
  fullName: string;
  /** The student's real email; stored in students.email, NOT used for login. */
  email: string;
  phone: string;
  major: string;
};

export function signUpWithUsername({
  username,
  password,
  fullName,
  email,
  phone,
  major,
}: StudentSignUp) {
  return supabase.auth.signUp({
    email: usernameToAuthEmail(username),
    password,
    options: {
      // Profile fields read by the on_auth_user_created trigger.
      // The username itself is taken from the auth email, not from here.
      data: {
        full_name: fullName.trim(),
        contact_email: email.trim().toLowerCase(),
        phone: phone.trim(),
        major: major.trim(),
      },
    },
  });
}

export function signInWithUsername(username: string, password: string) {
  return supabase.auth.signInWithPassword({
    email: usernameToAuthEmail(username),
    password,
  });
}

/*
 * DEVELOPMENT-ONLY admin login: admin username -> <username>@admin.invalid.
 * The admin account is created manually in Supabase (see the admin migration);
 * whether the session is really the admin is always decided by the database.
 */
export const ADMIN_AUTH_EMAIL_DOMAIN = 'admin.invalid';

export function signInAdminWithUsername(rawUsername: string, password: string) {
  const username = normalizeUsername(rawUsername);
  if (!isValidUsername(username)) {
    throw new Error('Invalid username');
  }
  return supabase.auth.signInWithPassword({
    email: `${username}@${ADMIN_AUTH_EMAIL_DOMAIN}`,
    password,
  });
}

export async function isCurrentUserAdmin(): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_admin');
  if (error) throw error;
  return data === true;
}
