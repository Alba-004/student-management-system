import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export type EmailRecipient = {
  id: string;
  full_name: string;
  student_id: string;
  email: string | null;
};

export type EmailSendResult = {
  sent: number;
  failed: number;
  skipped: number;
  notFound: number;
};

type Props = {
  recipients: EmailRecipient[];
  onClose: () => void;
  onSent: (result: EmailSendResult) => void;
};

// Keep in sync with supabase/functions/admin-send-email
const SUBJECT_MAX_LENGTH = 150;
const MESSAGE_MAX_LENGTH = 5000;

type FieldErrors = { subject?: string; message?: string };

const MESSAGES: Record<string, string> = {
  not_authenticated: 'Your session has expired. Please log in again as the admin.',
  forbidden: 'You do not have permission to send emails.',
  student_email_missing: 'None of the selected students has an email address.',
  send_failed: 'The email could not be sent. Please try again later.',
  provider_error: 'The email could not be sent. Please try again later.',
  email_not_configured: 'Email sending is not configured yet. Please contact the developer.',
  database_error: 'A database error occurred. Please try again.',
  invalid_request: 'The request was invalid. Please try again.',
};

function validate(subject: string, message: string): FieldErrors {
  const errors: FieldErrors = {};
  const s = subject.trim();
  const m = message.trim();
  if (!s) errors.subject = 'Subject is required.';
  else if (s.length > SUBJECT_MAX_LENGTH)
    errors.subject = `Subject must be ${SUBJECT_MAX_LENGTH} characters or fewer.`;
  if (!m) errors.message = 'Message is required.';
  else if (m.length > MESSAGE_MAX_LENGTH)
    errors.message = `Message must be ${MESSAGE_MAX_LENGTH} characters or fewer.`;
  return errors;
}

async function describeSendError(error: unknown): Promise<{ message: string; fields: FieldErrors }> {
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
    if (code === 'validation_failed') {
      const raw = (body.fields ?? {}) as Record<string, unknown>;
      const fields: FieldErrors = {};
      if (raw.subject) fields.subject = 'Please check the subject.';
      if (raw.message) fields.message = 'Please check the message.';
      return { message: 'Please correct the highlighted fields.', fields };
    }
    if (code && code in MESSAGES) return { message: MESSAGES[code], fields: {} };
    if (response.status === 404) {
      return {
        message: 'The email service is not available. Please contact the developer.',
        fields: {},
      };
    }
  }
  return { message: 'The email could not be sent. Please try again.', fields: {} };
}

function SendEmailDialog({ recipients, onClose, onSent }: Props) {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const firstInput = useRef<HTMLInputElement>(null);

  const single = recipients.length === 1 ? recipients[0] : null;
  const withEmail = recipients.filter((r) => r.email).length;
  const withoutEmail = recipients.length - withEmail;

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

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;

    setError(null);
    const errors = validate(subject, message);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    if (withEmail === 0) {
      setError(MESSAGES.student_email_missing);
      return;
    }

    inFlight.current = true;
    setSending(true);
    try {
      // Server-side Edge Function: verifies the admin, looks up the real emails and sends via Resend.
      const { data, error: invokeError } = await supabase.functions.invoke<
        EmailSendResult & { result: string }
      >('admin-send-email', {
        body: {
          studentIds: recipients.map((r) => r.id),
          subject: subject.trim(),
          message: message.trim(),
        },
      });

      if (invokeError || !data) {
        const result = await describeSendError(invokeError);
        setError(result.message);
        setFieldErrors(result.fields);
        return;
      }

      onSent({
        sent: data.sent,
        failed: data.failed,
        skipped: data.skipped,
        notFound: data.notFound,
      });
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !inFlight.current) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="send-email-title">
        <span className="sheet-grabber" aria-hidden="true" />
        <header className="sheet-header">
          <h2 id="send-email-title">{single ? 'Email student' : 'Email selected students'}</h2>
          <p className="card-subtitle">
            {single
              ? 'The message is sent to the student’s real email address.'
              : 'The same message is sent to every selected student with an email address.'}
          </p>
        </header>

        <div className="sheet-body">
          {single ? (
            <dl className="info-list">
              <div>
                <dt>Student</dt>
                <dd>{single.full_name}</dd>
              </div>
              <div>
                <dt>Student ID</dt>
                <dd className="text-mono">{single.student_id}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{single.email ?? 'No email'}</dd>
              </div>
            </dl>
          ) : (
            <dl className="info-list">
              <div>
                <dt>Selected</dt>
                <dd>{recipients.length}</dd>
              </div>
              <div>
                <dt>Will receive</dt>
                <dd>{withEmail}</dd>
              </div>
              {withoutEmail > 0 && (
                <div>
                  <dt>Skipped (no email)</dt>
                  <dd>{withoutEmail}</dd>
                </div>
              )}
            </dl>
          )}

          {error && (
            <p className="alert alert-error" role="alert">
              {error}
            </p>
          )}

          <form className="form" onSubmit={handleSubmit} noValidate aria-busy={sending}>
            <label className="field">
              Subject
              <input
                ref={firstInput}
                className="input"
                type="text"
                maxLength={SUBJECT_MAX_LENGTH}
                value={subject}
                disabled={sending}
                aria-invalid={fieldErrors.subject ? true : undefined}
                aria-describedby={fieldErrors.subject ? 'email-subject-error' : undefined}
                onChange={(e) => {
                  setSubject(e.target.value);
                  setFieldErrors((prev) => ({ ...prev, subject: undefined }));
                }}
                required
              />
              {fieldErrors.subject && (
                <span id="email-subject-error" className="field-error">
                  {fieldErrors.subject}
                </span>
              )}
            </label>
            <label className="field">
              Message
              <textarea
                className="input textarea"
                rows={7}
                maxLength={MESSAGE_MAX_LENGTH}
                value={message}
                disabled={sending}
                aria-invalid={fieldErrors.message ? true : undefined}
                aria-describedby={fieldErrors.message ? 'email-message-error' : 'email-message-hint'}
                onChange={(e) => {
                  setMessage(e.target.value);
                  setFieldErrors((prev) => ({ ...prev, message: undefined }));
                }}
                required
              />
              {fieldErrors.message ? (
                <span id="email-message-error" className="field-error">
                  {fieldErrors.message}
                </span>
              ) : (
                <span id="email-message-hint" className="field-hint">
                  Plain text. {message.length}/{MESSAGE_MAX_LENGTH}
                </span>
              )}
            </label>

            <div className="form-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={sending}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={sending || withEmail === 0}
                aria-busy={sending}
              >
                {sending ? 'Sending…' : 'Send Email'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default SendEmailDialog;
