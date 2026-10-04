import { useState, type SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { AuthError } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import {
  isCurrentUserAdmin,
  isValidUsername,
  normalizeUsername,
  signInAdminWithUsername,
  signInWithUsername,
} from '../lib/auth';
import './Auth.css';

function describeAuthError(error: AuthError): string {
  switch (error.code) {
    case 'invalid_credentials':
      return 'Incorrect username or password.';
    case 'email_not_confirmed':
      // Only happens if "Confirm email" is turned on, which username login does not support.
      return 'This account is not activated yet. Please contact the administrator.';
    case 'user_banned':
      return 'This account has been disabled.';
    case 'over_request_rate_limit':
      return 'Too many login attempts. Please wait a few minutes and try again.';
    default:
      return error.message || 'Login failed. Please try again.';
  }
}

type LoginMode = 'student' | 'admin';

function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<LoginMode>('student');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername || !password) {
      setError('Please enter your username and password.');
      return;
    }
    if (!isValidUsername(normalizedUsername)) {
      setError('Incorrect username or password.');
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'admin') {
        const { error: adminSignInError } = await signInAdminWithUsername(normalizedUsername, password);
        if (adminSignInError) {
          setError(describeAuthError(adminSignInError));
          return;
        }

        // The role is decided by the database, not by which tab was used.
        if (!(await isCurrentUserAdmin())) {
          await supabase.auth.signOut();
          setError('This account does not have admin access.');
          return;
        }

        navigate('/admin');
        return;
      }

      const { data, error: signInError } = await signInWithUsername(normalizedUsername, password);

      if (signInError) {
        setError(describeAuthError(signInError));
        return;
      }

      // Approval status always comes from the database (RLS limits this to the user's own row).
      const { data: student, error: studentError } = await supabase
        .from('students')
        .select('is_approved')
        .eq('id', data.user.id)
        .maybeSingle();

      if (studentError) {
        await supabase.auth.signOut();
        setError('Could not load your student profile. Please try again later.');
        return;
      }

      if (!student) {
        await supabase.auth.signOut();
        setError('Your student profile could not be found. Please contact the administrator.');
        return;
      }

      if (student.is_approved !== true) {
        await supabase.auth.signOut();
        setNotice('Your account is waiting for admin approval.');
        return;
      }

      navigate('/student');
    } catch {
      if (mode === 'admin') {
        // A session may exist even if the role check failed; never keep it.
        await supabase.auth.signOut().catch(() => undefined);
      }
      setError('Network error. Please check your connection and try again.');
    } finally {
      setPassword('');
      setSubmitting(false);
    }
  }

  return (
    <main className="auth">
      <section className="card auth-card">
        <header className="auth-header">
          <span className="auth-mark" aria-hidden="true">
            S
          </span>
          <h1>{mode === 'admin' ? 'Admin Login' : 'Student Login'}</h1>
          <p className="auth-subtitle">
            {mode === 'admin'
              ? 'Sign in to manage students.'
              : 'Sign in with your username and password.'}
          </p>
        </header>

        <div className="segmented" role="group" aria-label="Login type">
          {(['student', 'admin'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              disabled={submitting}
              onClick={() => {
                setMode(value);
                setError(null);
                setNotice(null);
              }}
            >
              {value === 'admin' ? 'Admin' : 'Student'}
            </button>
          ))}
        </div>

        {notice && (
          <p className="alert alert-notice" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}

        <form className="form" onSubmit={handleSubmit} noValidate>
          <label className="field">
            Username
            <input
              className="input"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </label>

          <label className="field">
            Password
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>

          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={submitting}
            aria-busy={submitting}
          >
            {submitting ? 'Logging in…' : 'Login'}
          </button>
        </form>

        {mode === 'student' && (
          <p className="auth-footer">
            Don&apos;t have an account? <Link to="/register">Register</Link>
          </p>
        )}
      </section>
    </main>
  );
}

export default Login;
