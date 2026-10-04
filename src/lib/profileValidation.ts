// Shared validation for the editable student profile fields
// (used by the Student Dashboard and the Admin "Edit student" form).

export type ProfileFields = {
  full_name: string;
  phone: string;
  major: string;
};

export type ProfileFieldErrors = Partial<Record<keyof ProfileFields, string>>;

// Digits with optional +, spaces, dashes and parentheses; 6–20 characters.
const PHONE_PATTERN = /^\+?[0-9\s()-]{6,20}$/;

export function validateProfile(fields: ProfileFields): ProfileFieldErrors {
  const errors: ProfileFieldErrors = {};
  if (!fields.full_name.trim()) errors.full_name = 'Full name is required.';
  const phone = fields.phone.trim();
  if (!phone) errors.phone = 'Phone is required.';
  else if (!PHONE_PATTERN.test(phone)) errors.phone = 'Enter a valid phone number.';
  if (!fields.major.trim()) errors.major = 'Major / department is required.';
  return errors;
}

// Real (contact) email — separate from the internal <username>@users.invalid login.
// Same rule as the students_email_format constraint and the Edge Functions.
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EMAIL_MAX_LENGTH = 254;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Returns an error message, or undefined when the email is valid. */
export function validateEmail(raw: string): string | undefined {
  const email = normalizeEmail(raw);
  if (!email) return 'Email is required.';
  if (
    email.length > EMAIL_MAX_LENGTH ||
    !EMAIL_PATTERN.test(email) ||
    email.endsWith('.invalid')
  ) {
    return 'Enter a valid email address.';
  }
  return undefined;
}
