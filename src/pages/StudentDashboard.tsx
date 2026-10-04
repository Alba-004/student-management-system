import { useEffect, useRef, useState, type ChangeEvent, type SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import {
  normalizeEmail,
  validateEmail,
  validateProfile,
  type ProfileFields,
} from '../lib/profileValidation';
import './StudentDashboard.css';

type StudentProfile = {
  id: string;
  student_id: string;
  username: string | null;
  full_name: string;
  email: string | null;
  phone: string;
  major: string;
  is_approved: boolean;
};

// Real email is edited alongside the profile; it is NOT the login email.
type EditableFields = ProfileFields & { email: string };
type FieldErrors = Partial<Record<keyof EditableFields, string>>;

type LoadState = 'loading' | 'ready' | 'signed-out' | 'not-found' | 'error';

const PROFILE_COLUMNS = 'id, student_id, username, full_name, email, phone, major, is_approved';

function StudentDashboard() {
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>('loading');
  const [student, setStudent] = useState<StudentProfile | null>(null);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditableFields>({
    full_name: '',
    email: '',
    phone: '',
    major: '',
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function loadProfile() {
    setState('loading');
    try {
      // getUser() validates the session with Supabase instead of trusting local storage.
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) {
        setState('signed-out');
        return;
      }

      // RLS limits a student to their own row.
      const { data, error } = await supabase
        .from('students')
        .select(PROFILE_COLUMNS)
        .eq('id', userData.user.id)
        .maybeSingle<StudentProfile>();

      if (error) {
        setState('error');
        return;
      }
      if (!data) {
        setState('not-found');
        return;
      }
      setStudent(data);
      setState('ready');
    } catch {
      setState('error');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch
    void loadProfile();
  }, []);

  function startEditing() {
    if (!student) return;
    setForm({
      full_name: student.full_name,
      email: student.email ?? '',
      phone: student.phone,
      major: student.major,
    });
    setFieldErrors({});
    setSaveError(null);
    setSaveSuccess(null);
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
    setFieldErrors({});
    setSaveError(null);
  }

  function updateField(field: keyof EditableFields, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  async function handleSave(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!student || inFlight.current) return;

    setSaveError(null);
    setSaveSuccess(null);

    const errors: FieldErrors = { ...validateProfile(form) };
    const emailError = validateEmail(form.email);
    if (emailError) errors.email = emailError;
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    inFlight.current = true;
    setSaving(true);
    try {
      // Only these columns are granted to students; RLS limits it to their own row.
      const { data, error } = await supabase
        .from('students')
        .update({
          full_name: form.full_name.trim(),
          email: normalizeEmail(form.email),
          phone: form.phone.trim(),
          major: form.major.trim(),
        })
        .eq('id', student.id)
        .select(PROFILE_COLUMNS)
        .maybeSingle<StudentProfile>();

      if (error?.code === '23505') {
        // unique_violation on students_email_key
        setFieldErrors({ email: 'This email is already used by another account.' });
        return;
      }
      if (error?.code === '23514') {
        // check_violation (e.g. email format)
        setSaveError('Some values are invalid. Please check the fields and try again.');
        return;
      }
      if (error || !data) {
        setSaveError('Your profile could not be saved. Please try again.');
        return;
      }

      setStudent(data);
      setEditing(false);
      setSaveSuccess('Your profile has been updated.');
    } catch {
      setSaveError('Network error. Please check your connection and try again.');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    navigate('/login', { replace: true });
  }

  function fieldProps(field: keyof EditableFields) {
    const message = fieldErrors[field];
    return {
      className: 'input',
      value: form[field],
      onChange: (e: ChangeEvent<HTMLInputElement>) => updateField(field, e.target.value),
      disabled: saving,
      'aria-invalid': message ? true : undefined,
      'aria-describedby': message ? `${field}-error` : undefined,
    };
  }

  function fieldError(field: keyof EditableFields) {
    const message = fieldErrors[field];
    return message ? (
      <span id={`${field}-error`} className="field-error">
        {message}
      </span>
    ) : null;
  }

  if (state === 'loading') {
    return (
      <main className="page-state">
        <div className="state" role="status">
          <span className="spinner" aria-hidden="true" />
          <p>Loading your profile…</p>
        </div>
      </main>
    );
  }

  if (state === 'signed-out') {
    return (
      <main className="page-state">
        <section className="card student-state-card">
          <div className="state" role="status">
            <span className="state-icon" aria-hidden="true">
              ?
            </span>
            <h2>You are not logged in</h2>
            <p>
              Please <Link to="/login">log in</Link> to view your dashboard.
            </p>
          </div>
        </section>
      </main>
    );
  }

  if (state === 'not-found' || state === 'error' || !student) {
    return (
      <main className="page-state">
        <section className="card student-state-card">
          <div className="state" role="alert">
            <span className="state-icon state-icon-error" aria-hidden="true">
              !
            </span>
            <h2>{state === 'not-found' ? 'Profile not found' : 'Something went wrong'}</h2>
            <p>
              {state === 'not-found'
                ? 'No student profile is linked to this account. Please contact the administrator.'
                : 'Your profile could not be loaded. Please try again.'}
            </p>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={handleLogout}>
              Log out
            </button>
            {state === 'error' && (
              <button type="button" className="btn btn-primary" onClick={() => void loadProfile()}>
                Retry
              </button>
            )}
          </div>
        </section>
      </main>
    );
  }

  const initials = student.full_name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner student-container">
          <div className="topbar-title">
            <span className="topbar-eyebrow">Student</span>
            <h1>Dashboard</h1>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </header>

      <main className="student student-container">
        {saveSuccess && (
          <p className="alert alert-success" role="status">
            {saveSuccess}
          </p>
        )}

        {!student.is_approved && (
          <p className="alert alert-notice" role="status">
            Your account is waiting for admin approval.
          </p>
        )}

        {student.is_approved && !student.email && !editing && (
          <p className="alert alert-info" role="status">
            Add your email address so you can receive messages from the administrator.
          </p>
        )}

        <section className="card student-hero" aria-label="Student summary">
          <span className="student-avatar" aria-hidden="true">
            {initials || '?'}
          </span>
          <div className="student-hero-text">
            <h2>{student.full_name}</h2>
            <p className="text-mono">{student.student_id}</p>
          </div>
          <span className={`badge ${student.is_approved ? 'badge-success' : 'badge-warning'}`}>
            {student.is_approved ? 'Approved' : 'Pending approval'}
          </span>
        </section>

        <section className="card" aria-labelledby="account-heading">
          <div className="card-header">
            <div>
              <h2 id="account-heading">Account</h2>
              <p className="card-subtitle">Student ID and username cannot be changed.</p>
            </div>
          </div>
          <dl className="info-list">
            <div>
              <dt>Student ID</dt>
              <dd className="text-mono">{student.student_id}</dd>
            </div>
            <div>
              <dt>Username</dt>
              <dd>{student.username ?? '—'}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <span className={`badge ${student.is_approved ? 'badge-success' : 'badge-warning'}`}>
                  {student.is_approved ? 'Approved' : 'Pending approval'}
                </span>
              </dd>
            </div>
          </dl>
        </section>

        <section className="card" aria-labelledby="profile-heading">
          <div className="card-header">
            <h2 id="profile-heading">Profile</h2>
            {!editing && student.is_approved && (
              <button type="button" className="btn btn-tinted btn-sm" onClick={startEditing}>
                Edit profile
              </button>
            )}
          </div>

          {editing ? (
            <div className="student-edit">
              {saveError && (
                <p className="alert alert-error" role="alert">
                  {saveError}
                </p>
              )}
              <form className="form" onSubmit={handleSave} noValidate aria-busy={saving}>
                <label className="field">
                  Full Name
                  <input type="text" autoComplete="name" required {...fieldProps('full_name')} />
                  {fieldError('full_name')}
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
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={cancelEditing}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={saving}
                    aria-busy={saving}
                  >
                    {saving ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              </form>
            </div>
          ) : (
            <dl className="info-list">
              <div>
                <dt>Full Name</dt>
                <dd>{student.full_name}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{student.email ?? <span className="student-missing">Not set</span>}</dd>
              </div>
              <div>
                <dt>Phone</dt>
                <dd>{student.phone}</dd>
              </div>
              <div>
                <dt>Major / Department</dt>
                <dd>{student.major}</dd>
              </div>
            </dl>
          )}
        </section>
      </main>
    </>
  );
}

export default StudentDashboard;
