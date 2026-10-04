import { useEffect, useRef, useState, type ChangeEvent, type SubmitEvent } from 'react';
import type { PostgrestError } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import {
  validateProfile,
  type ProfileFieldErrors,
  type ProfileFields,
} from '../lib/profileValidation';

export type EditableStudent = ProfileFields & {
  id: string;
  student_id: string;
  username: string | null;
};

type Props = {
  student: EditableStudent;
  onClose: () => void;
  onSaved: (student: EditableStudent) => void;
};

function describeSaveError(error: PostgrestError): string {
  switch (error.code) {
    case '42501': // insufficient_privilege, raised when the caller is not the admin
      return 'You do not have permission to edit students. Please log in again as the admin.';
    case 'P0002': // no_data_found
      return 'This student no longer exists. Refresh the list and try again.';
    case '23502': // not_null_violation
    case '23514': // check_violation
      return 'Some values are invalid. Please check the fields and try again.';
    default:
      return 'The changes could not be saved. Please try again.';
  }
}

function EditStudentDialog({ student, onClose, onSaved }: Props) {
  const [form, setForm] = useState<ProfileFields>({
    full_name: student.full_name,
    phone: student.phone,
    major: student.major,
  });
  const [fieldErrors, setFieldErrors] = useState<ProfileFieldErrors>({});
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

  function updateField(field: keyof ProfileFields, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;

    setError(null);
    const errors = validateProfile(form);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const values: ProfileFields = {
      full_name: form.full_name.trim(),
      phone: form.phone.trim(),
      major: form.major.trim(),
    };

    inFlight.current = true;
    setSaving(true);
    try {
      // Admin-only database function: re-checks is_admin() and updates only these three columns.
      const { error: rpcError } = await supabase.rpc('admin_update_student_profile', {
        p_student_id: student.id,
        p_full_name: values.full_name,
        p_phone: values.phone,
        p_major: values.major,
      });
      if (rpcError) {
        setError(describeSaveError(rpcError));
        return;
      }
      onSaved({ ...student, ...values });
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  function fieldProps(field: keyof ProfileFields) {
    const message = fieldErrors[field];
    return {
      className: 'input',
      value: form[field],
      onChange: (e: ChangeEvent<HTMLInputElement>) => updateField(field, e.target.value),
      disabled: saving,
      'aria-invalid': message ? true : undefined,
      'aria-describedby': message ? `edit-${field}-error` : undefined,
    };
  }

  function fieldError(field: keyof ProfileFields) {
    const message = fieldErrors[field];
    return message ? (
      <span id={`edit-${field}-error`} className="field-error">
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
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="edit-student-title">
        <span className="sheet-grabber" aria-hidden="true" />
        <header className="sheet-header">
          <h2 id="edit-student-title">Edit student</h2>
          <p className="card-subtitle">Update the student&apos;s profile details.</p>
        </header>

        <div className="sheet-body">
          <dl className="info-list">
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
              {error}
            </p>
          )}

          <form className="form" onSubmit={handleSubmit} noValidate aria-busy={saving}>
            <label className="field">
              Full Name
              <input type="text" ref={firstInput} required {...fieldProps('full_name')} />
              {fieldError('full_name')}
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
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default EditStudentDialog;
