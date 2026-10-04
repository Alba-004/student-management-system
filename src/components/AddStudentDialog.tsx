import { useEffect, useRef, useState, type ChangeEvent, type SubmitEvent } from 'react';
import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { isValidUsername, normalizeUsername } from '../lib/auth';
import { normalizeEmail, validateEmail, validateProfile } from '../lib/profileValidation';

export type CreatedStudent = {
  studentId: string;
  student_id: string;
  username: string;
  full_name: string;
};

type Props = {
  onClose: () => void;
  onCreated: (student: CreatedStudent) => void;
};

type FormFields = {
  fullName: string;
  username: string;
  email: string;
  phone: string;
  major: string;
  password: string;
  confirmPassword: string;
};

type FieldErrors = Partial<Record<keyof FormFields, string>>;

const emptyForm: FormFields = {
  fullName: '',
  username: '',
  email: '',
  phone: '',
  major: '',
  password: '',
  confirmPassword: '',
};

const MIN_PASSWORD_LENGTH = 6;

const MESSAGES: Record<string, string> = {
  not_authenticated: 'Your session has expired. Please log in again as the admin.',
  forbidden: 'You do not have permission to add students.',
  auth_create_failed: 'The student could not be created. Nothing was saved.',
  database_error: 'The student could not be created. Nothing was saved.',
  invalid_request: 'The request was invalid. Please check the fields and try again.',
};

// Server-side field codes -> messages (the Edge Function's validation is authoritative).
const FIELD_MESSAGES: Record<string, Record<string, string>> = {
  username: {
    required: 'Username is required.',
    invalid: 'Use 3–30 characters: letters, numbers or underscores.',
  },
  fullName: { required: 'Full name is required.' },
  email: { required: 'Email is required.', invalid: 'Enter a valid email address.' },
  phone: { required: 'Phone is required.', invalid: 'Enter a valid phone number.' },
  major: { required: 'Major / department is required.' },
  password: {
    required: 'Password is required.',
    too_short: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
  },
};

function validate(form: FormFields): FieldErrors {
  const errors: FieldErrors = {};

  const profileErrors = validateProfile({
    full_name: form.fullName,
    phone: form.phone,
    major: form.major,
  });
  if (profileErrors.full_name) errors.fullName = profileErrors.full_name;
  if (profileErrors.phone) errors.phone = profileErrors.phone;
  if (profileErrors.major) errors.major = profileErrors.major;

  const emailError = validateEmail(form.email);
  if (emailError) errors.email = emailError;

  const username = normalizeUsername(form.username);
  if (!username) errors.username = 'Username is required.';
  else if (!isValidUsername(username))
    errors.username = 'Use 3–30 characters: letters, numbers or underscores.';

  if (!form.password) errors.password = 'Password is required.';
  else if (form.password.length < MIN_PASSWORD_LENGTH)
    errors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;

  if (!form.confirmPassword) errors.confirmPassword = 'Please confirm the password.';
  else if (form.confirmPassword !== form.password)
    errors.confirmPassword = 'Passwords do not match.';

  return errors;
}

type ErrorResult = { message: string | null; fields: FieldErrors };

async function describeCreateError(error: unknown): Promise<ErrorResult> {
  if (error instanceof FunctionsFetchError) {
    return { message: 'Network error. Please check your connection and try again.', fields: {} };
  }
  if (error instanceof FunctionsHttpError) {
    const response = error.context as Response;
    let body: { error?: unknown; fields?: unknown } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      body = {};
    }
    const code = typeof body.error === 'string' ? body.error : undefined;

    if (code === 'username_taken') {
      return { message: null, fields: { username: 'This username is already taken.' } };
    }
    if (code === 'email_taken') {
      return { message: null, fields: { email: 'This email is already used by another student.' } };
    }
    if (code === 'weak_password') {
      return { message: null, fields: { password: 'Password does not meet the requirements.' } };
    }
    if (code === 'validation_failed' && body.fields && typeof body.fields === 'object') {
      const fields: FieldErrors = {};
      for (const [field, fieldCode] of Object.entries(body.fields as Record<string, unknown>)) {
        const message = typeof fieldCode === 'string' ? FIELD_MESSAGES[field]?.[fieldCode] : undefined;
        if (field in emptyForm) fields[field as keyof FormFields] = message ?? 'Invalid value.';
      }
      return { message: 'Please correct the highlighted fields.', fields };
    }
    if (code && code in MESSAGES) return { message: MESSAGES[code], fields: {} };
    if (response.status === 404) {
      return {
        message: 'The add-student service is not available. Please contact the developer.',
        fields: {},
      };
    }
  }
  return { message: 'The student could not be created. Please try again.', fields: {} };
}

function AddStudentDialog({ onClose, onCreated }: Props) {
  const [form, setForm] = useState<FormFields>(emptyForm);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const firstInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstInput.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !inFlight.current) onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function updateField(field: keyof FormFields, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;

    setError(null);
    const errors = validate(form);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const fullName = form.fullName.trim();

    inFlight.current = true;
    setSaving(true);
    try {
      // Server-side Edge Function: verifies the admin, then creates the Auth user.
      // The password goes only to this HTTPS request; it is not stored by the app.
      const { data, error: invokeError } = await supabase.functions.invoke<{
        studentId: string;
        student_id: string;
        username: string;
      }>('admin-create-student', {
        body: {
          username: normalizeUsername(form.username),
          fullName,
          email: normalizeEmail(form.email),
          phone: form.phone.trim(),
          major: form.major.trim(),
          password: form.password,
        },
      });

      if (invokeError || !data) {
        const result = await describeCreateError(invokeError);
        setError(result.message);
        setFieldErrors(result.fields);
        return;
      }

      // Drop the password from memory before handing control back.
      setForm(emptyForm);
      onCreated({
        studentId: data.studentId,
        student_id: data.student_id,
        username: data.username,
        full_name: fullName,
      });
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  function fieldProps(field: keyof FormFields) {
    const message = fieldErrors[field];
    return {
      className: 'input',
      value: form[field],
      onChange: (e: ChangeEvent<HTMLInputElement>) => updateField(field, e.target.value),
      disabled: saving,
      'aria-invalid': message ? true : undefined,
      'aria-describedby': message ? `add-${field}-error` : undefined,
    };
  }

  function fieldError(field: keyof FormFields) {
    const message = fieldErrors[field];
    return message ? (
      <span id={`add-${field}-error`} className="field-error">
        {message}
      </span>
    ) : null;
  }

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !inFlight.current) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="add-student-title">
        <span className="sheet-grabber" aria-hidden="true" />
        <header className="sheet-header">
          <h2 id="add-student-title">Add student</h2>
          <p className="card-subtitle">
            The account starts as pending and needs approval before the student can log in.
          </p>
        </header>

        <div className="sheet-body">
          {error && (
            <p className="alert alert-error" role="alert">
              {error}
            </p>
          )}

          <form className="form" onSubmit={handleSubmit} noValidate aria-busy={saving}>
            <label className="field">
              Full Name
              <input type="text" ref={firstInput} required {...fieldProps('fullName')} />
              {fieldError('fullName')}
            </label>
            <label className="field">
              Username
              <input
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                required
                {...fieldProps('username')}
              />
              {fieldError('username')}
            </label>
            <label className="field">
              Email
              <input
                type="email"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                required
                {...fieldProps('email')}
              />
              {fieldError('email')}
            </label>
            <label className="field">
              Phone
              <input type="tel" required {...fieldProps('phone')} />
              {fieldError('phone')}
            </label>
            <label className="field">
              Major / Department
              <input type="text" required {...fieldProps('major')} />
              {fieldError('major')}
            </label>
            <label className="field">
              Initial Password
              <input
                type="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                required
                {...fieldProps('password')}
              />
              {fieldError('password')}
            </label>
            <label className="field">
              Confirm Password
              <input
                type="password"
                autoComplete="new-password"
                required
                {...fieldProps('confirmPassword')}
              />
              {fieldError('confirmPassword')}
            </label>

            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={saving}
                aria-busy={saving}
              >
                {saving ? 'Creating…' : 'Create student'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default AddStudentDialog;
