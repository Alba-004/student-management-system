import { useEffect, useRef, useState } from 'react';
import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export type DeletableStudent = {
  id: string;
  student_id: string;
  username: string | null;
  full_name: string;
};

type Props = {
  student: DeletableStudent;
  onClose: () => void;
  onDeleted: (student: DeletableStudent) => void;
};

const MESSAGES: Record<string, string> = {
  not_authenticated: 'Your session has expired. Please log in again as the admin.',
  forbidden: 'You do not have permission to delete students.',
  cannot_delete_admin: 'The admin account cannot be deleted.',
  not_found: 'This student no longer exists. Refresh the list.',
  auth_delete_failed: "The student's login account could not be deleted. Nothing was removed.",
  database_error: 'A database error occurred. Please refresh the list and try again.',
};

async function describeDeleteError(error: unknown): Promise<string> {
  if (error instanceof FunctionsFetchError) {
    return 'Network error. Please check your connection and try again.';
  }
  if (error instanceof FunctionsHttpError) {
    const response = error.context as Response;
    let code: unknown;
    try {
      ({ error: code } = (await response.json()) as { error?: unknown });
    } catch {
      code = undefined;
    }
    if (typeof code === 'string' && code in MESSAGES) return MESSAGES[code];
    if (response.status === 404) return 'The delete service is not available. Please contact the developer.';
  }
  return 'The student could not be deleted. Please try again.';
}

function DeleteStudentDialog({ student, onClose, onDeleted }: Props) {
  const [confirmed, setConfirmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus the safe action first.
    cancelButton.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !inFlight.current) onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function handleDelete() {
    if (!confirmed || inFlight.current) return;
    inFlight.current = true;
    setDeleting(true);
    setError(null);
    try {
      // Server-side Edge Function: verifies the admin and deletes the Auth user by id.
      const { error: invokeError } = await supabase.functions.invoke('admin-delete-student', {
        body: { studentId: student.id },
      });
      if (invokeError) {
        setError(await describeDeleteError(invokeError));
        return;
      }
      onDeleted(student);
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      inFlight.current = false;
      setDeleting(false);
    }
  }

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !inFlight.current) onClose();
      }}
    >
      <div
        className="sheet"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-student-title"
        aria-describedby="delete-student-warning"
      >
        <span className="sheet-grabber" aria-hidden="true" />
        <header className="sheet-header sheet-header-centered">
          <span className="sheet-icon sheet-icon-danger" aria-hidden="true">
            !
          </span>
          <h2 id="delete-student-title">Delete this student permanently?</h2>
          <p id="delete-student-warning" className="card-subtitle">
            This permanently deletes the student&apos;s login account and profile. It cannot be
            undone.
          </p>
        </header>

        <div className="sheet-body">
          <dl className="info-list">
            <div>
              <dt>Student</dt>
              <dd>{student.full_name}</dd>
            </div>
            <div>
              <dt>Student ID</dt>
              <dd className="text-mono">{student.student_id}</dd>
            </div>
            <div>
              <dt>Username</dt>
              <dd>{student.username ?? '—'}</dd>
            </div>
          </dl>

          {error && (
            <p className="alert alert-error" role="alert">
              <strong>Delete failed.</strong> {error}
            </p>
          )}

          <label className="checkbox confirm-box">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={deleting}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I understand this student will be permanently deleted.
          </label>

          <div className="form-actions">
            <button
              type="button"
              ref={cancelButton}
              className="btn btn-secondary"
              onClick={onClose}
              disabled={deleting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void handleDelete()}
              disabled={!confirmed || deleting}
              aria-busy={deleting}
            >
              {deleting ? 'Deleting…' : 'Delete permanently'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DeleteStudentDialog;
