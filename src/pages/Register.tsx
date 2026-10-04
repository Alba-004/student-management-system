import { useRef, useState, type ChangeEvent, type SubmitEvent } from 'react';
import { Link } from 'react-router-dom';
import type { AuthError } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { isValidUsername, normalizeUsername, signUpWithUsername } from '../lib/auth';
import { validateEmail } from '../lib/profileValidation';
import './Auth.css';

type FormFields = {
  username: string;
  fullName: string;
  email: string;
  phone: string;
  major: string;
  password: string;
  confirmPassword: string;
};

type FieldErrors = Partial<Record<keyof FormFields, string>>;

const emptyForm: FormFields = {
  username: '',
  fullName: '',
  email: '',
  phone: '',
  major: '',
  password: '',
  confirmPassword: '',
};

const MIN_PASSWORD_LENGTH = 6;

function validate(form: FormFields): FieldErrors {
  const errors: FieldErrors = {};

  const username = normalizeUsername(form.username);
  if (!username) errors.username = 'Username is required.';
  else if (!isValidUsername(username))
    errors.username = 'Use 3–30 characters: letters, numbers or underscores.';

  if (!form.fullName.trim()) errors.fullName = 'Full name is required.';

  const emailError = validateEmail(form.email);
  if (emailError) errors.email = emailError;

  if (!form.phone.trim()) errors.phone = 'Phone is required.';
  if (!form.major.trim()) errors.major = 'Major / department is required.';

  if (!form.password) errors.password = 'Password is required.';
  else if (form.password.length < MIN_PASSWORD_LENGTH)
    errors.password = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;

  if (!form.confirmPassword) errors.confirmPassword = 'Please confirm your password.';
  else if (form.confirmPassword !== form.password)
    errors.confirmPassword = 'Passwords do not match.';

  return errors;
}

function describeAuthError(error: AuthError): string {
  switch (error.code) {
    case 'email_provider_disabled':
    case 'signup_disabled':
      // Supabase project setting, not something the user can fix.
      return 'Registration is currently unavailable. Please try again later or contact the administrator.';
    case 'user_already_exists':
    case 'email_exists':
      return 'This username is already taken. Please choose another one.';
    case 'weak_password':
      return `Password is too weak. ${error.message}`;
    case 'email_address_invalid':
      return 'This username cannot be used. Please choose another one.';
    case 'over_email_send_rate_limit':
      return 'Email sending limit reached. Please try again later.';
    case 'over_request_rate_limit':
      return 'Too many requests. Please wait a moment and try again.';
    case 'unexpected_failure':
      // Raised when the students-row trigger fails (e.g. missing profile data,
      // or a username or real email already present in students).
      return 'Could not create your student record. This email may already be registered, or a detail is invalid.';
    default:
      return error.message || 'Registration failed. Please try again.';
  }
}

type WelcomeEmailStatus = 'sent' | 'failed' | 'not_sent';

// Sends the welcome email server-side for the just-registered (signed-in) student.
// A failure never undoes the registration.
async function sendWelcomeEmail(): Promise<WelcomeEmailStatus> {
  try {
    const { error } = await supabase.functions.invoke('send-welcome-email', { body: {} });
    return error ? 'failed' : 'sent';
  } catch {
    return 'failed';
  }
}

function Register() {
  const [form, setForm] = useState<FormFields>(emptyForm);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [welcomeEmail, setWelcomeEmail] = useState<WelcomeEmailStatus>('not_sent');
  // Blocks a second submit before the disabled button has re-rendered.
  const inFlight = useRef(false);

  function updateField(field: keyof FormFields, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;

    setError(null);
    setSuccess(null);

    const errors = validate(form);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setError('Please correct the highlighted fields.');
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    try {
      const { data, error: signUpError } = await signUpWithUsername({
        username: form.username,
        password: form.password,
        fullName: form.fullName,
        email: form.email,
        phone: form.phone,
        major: form.major,
      });

      if (signUpError) {
        setError(describeAuthError(signUpError));
        return;
      }

      if (!data.user) {
        setError('Registration failed. Please try again.');
        return;
      }

      // If "Confirm email" is ever turned on, Supabase returns a user with no
      // identities (and no error) when the username is already registered.
      if (data.user.identities?.length === 0) {
        setError('This username is already taken. Please choose another one.');
        return;
      }

      // The welcome email needs the new session; unapproved students are then signed out.
      let emailStatus: WelcomeEmailStatus = 'not_sent';
      if (data.session) {
        emailStatus = await sendWelcomeEmail();
        await supabase.auth.signOut();
      }
      setWelcomeEmail(emailStatus);

      setForm(emptyForm);
      setFieldErrors({});
      setSuccess(
        data.session
          ? 'Your account has been created and is awaiting admin approval.'
          : 'Your account has been created but is not active yet. Please contact the administrator.',
      );
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  function fieldProps(field: keyof FormFields) {
    const message = fieldErrors[field];
    return {
      className: 'input',
      value: form[field],
      onChange: (e: ChangeEvent<HTMLInputElement>) => updateField(field, e.target.value),
      disabled: submitting,
      'aria-invalid': message ? true : undefined,
      'aria-describedby': message ? `${field}-error` : undefined,
    };
  }

  function fieldError(field: keyof FormFields) {
    const message = fieldErrors[field];
    return message ? (
      <span id={`${field}-error`} className="field-error">
        {message}
      </span>
    ) : null;
  }

  if (success) {
    return (
      <main className="auth">
        <section className="card auth-card">
          <div className="auth-success" role="status">
            <span className="auth-success-icon" aria-hidden="true">
              ✓
            </span>
            <h1>Registration successful</h1>
            <p>{success}</p>
            {welcomeEmail === 'sent' && (
              <p className="alert alert-success">
                A welcome email with your username and Student ID was sent to your email address.
              </p>
            )}
            {welcomeEmail === 'failed' && (
              <p className="alert alert-notice">
                Your account was created, but the welcome email could not be sent. You can still
                log in after an admin approves your account.
              </p>
            )}
            <Link to="/login" className="btn btn-primary btn-block">
              Go to login
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="auth">
      <section className="card auth-card">
        <header className="auth-header">
          <span className="auth-mark" aria-hidden="true">
            S
          </span>
          <h1>Student Registration</h1>
          <p className="auth-subtitle">Create your account. An admin will review it.</p>
        </header>

        {error && (
          <div className="alert alert-error" role="alert">
            <strong>Registration failed</strong>
            <p>{error}</p>
          </div>
        )}

        <form className="form" onSubmit={handleSubmit} noValidate aria-busy={submitting}>
          <label className="field">
            Full Name
            <input type="text" autoComplete="name" required {...fieldProps('fullName')} />
            {fieldError('fullName')}
          </label>

          <label className="field">
            Username
            <input
              type="text"
              autoComplete="username"
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
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              required
              {...fieldProps('email')}
            />
            {fieldError('email')}
          </label>

          <label className="field">
            Phone
            <input type="tel" autoComplete="tel" required {...fieldProps('phone')} />
            {fieldError('phone')}
          </label>

          <label className="field">
            Major / Department
            <input type="text" required {...fieldProps('major')} />
            {fieldError('major')}
          </label>

          <label className="field">
            Password
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

          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={submitting}
            aria-busy={submitting}
          >
            {submitting ? 'Creating account…' : 'Register'}
          </button>
        </form>

        <p className="auth-footer">
          Already have an account? <Link to="/login">Log in</Link>
        </p>
      </section>
    </main>
  );
}

export default Register;
