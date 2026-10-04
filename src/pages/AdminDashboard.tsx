import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import EditStudentDialog, { type EditableStudent } from '../components/EditStudentDialog';
import DeleteStudentDialog, { type DeletableStudent } from '../components/DeleteStudentDialog';
import AddStudentDialog, { type CreatedStudent } from '../components/AddStudentDialog';
import SendEmailDialog, {
  type EmailRecipient,
  type EmailSendResult,
} from '../components/SendEmailDialog';
import './AdminDashboard.css';

type StudentRow = {
  id: string;
  student_id: string;
  username: string | null;
  full_name: string;
  email: string | null;
  phone: string;
  major: string;
  is_approved: boolean;
  created_at: string;
};

function AdminDashboard() {
  const navigate = useNavigate();
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [editingStudent, setEditingStudent] = useState<StudentRow | null>(null);
  const [deletingStudent, setDeletingStudent] = useState<StudentRow | null>(null);
  const [addingStudent, setAddingStudent] = useState(false);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [emailRecipients, setEmailRecipients] = useState<EmailRecipient[] | null>(null);

  // showLoading=false refreshes the list in place (e.g. after an edit) without hiding the table.
  async function loadStudents(showLoading = true) {
    if (showLoading) setLoading(true);
    setLoadError(null);
    // RLS returns every row only for the admin (policy "Admin can view all students").
    const { data, error } = await supabase
      .from('students')
      .select('id, student_id, username, full_name, email, phone, major, is_approved, created_at')
      .order('created_at', { ascending: true });

    if (error) {
      setLoadError('Could not load students. Please try again.');
    } else {
      setStudents(data ?? []);
    }
    setLoading(false);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch
    void loadStudents();
  }, []);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return students;
    return students.filter(
      (s) =>
        s.student_id.toLowerCase().includes(term) ||
        (s.username ?? '').toLowerCase().includes(term) ||
        s.full_name.toLowerCase().includes(term),
    );
  }, [students, search]);

  const closeEditor = useCallback(() => setEditingStudent(null), []);
  const closeDeleteDialog = useCallback(() => setDeletingStudent(null), []);
  const closeAddDialog = useCallback(() => setAddingStudent(false), []);
  const closeEmailDialog = useCallback(() => setEmailRecipients(null), []);

  // Selection only counts students that still exist in the list.
  const selectedStudents = useMemo(
    () => students.filter((s) => selectedIds.has(s.id)),
    [students, selectedIds],
  );
  const allVisibleSelected = filtered.length > 0 && filtered.every((s) => selectedIds.has(s.id));

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setSelectedIds((prev) => new Set([...prev, ...filtered.map((s) => s.id)]));
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function openEmail(recipients: StudentRow[]) {
    setActionSuccess(null);
    setActionError(null);
    setEmailRecipients(
      recipients.map((s) => ({
        id: s.id,
        full_name: s.full_name,
        student_id: s.student_id,
        email: s.email,
      })),
    );
  }

  function handleEmailSent(result: EmailSendResult) {
    const recipients = emailRecipients ?? [];
    const bulk = recipients.length > 1;
    setEmailRecipients(null);

    if (!bulk && result.sent === 1) {
      setActionSuccess(`Email sent to ${recipients[0]?.full_name ?? 'the student'}.`);
      setActionError(null);
      return;
    }

    const parts = [`Email sent to ${result.sent} student${result.sent === 1 ? '' : 's'}.`];
    if (result.skipped > 0) parts.push(`${result.skipped} skipped (no email).`);
    if (result.notFound > 0) parts.push(`${result.notFound} no longer exist.`);
    setActionSuccess(parts.join(' '));
    setActionError(
      result.failed > 0
        ? `${result.failed} email${result.failed === 1 ? '' : 's'} could not be sent. Please try again later.`
        : null,
    );
    if (bulk) clearSelection();
  }

  async function handleStudentCreated(created: CreatedStudent) {
    setAddingStudent(false);
    setActionError(null);
    setActionSuccess(
      `Created ${created.full_name} (${created.student_id}). The account is pending approval.`,
    );
    await loadStudents(false);
  }

  async function handleStudentDeleted(deleted: DeletableStudent) {
    setDeletingStudent(null);
    setActionError(null);
    setActionSuccess(`Deleted ${deleted.full_name} (${deleted.student_id}) permanently.`);
    setStudents((prev) => prev.filter((s) => s.id !== deleted.id));
    await loadStudents(false);
  }

  async function handleStudentSaved(updated: EditableStudent) {
    setEditingStudent(null);
    setActionError(null);
    setActionSuccess(`Saved changes to ${updated.full_name} (${updated.student_id}).`);
    // Show the saved values immediately, then reload from the database.
    setStudents((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)));
    await loadStudents(false);
  }

  async function setApproval(student: StudentRow, approved: boolean) {
    setActionError(null);
    setActionSuccess(null);
    setPendingId(student.id);
    try {
      // Admin-only database function; it re-checks the admin role server-side.
      const { error } = await supabase.rpc('set_student_approval', {
        p_student_id: student.id,
        p_approved: approved,
      });
      if (error) {
        setActionError(
          `Could not ${approved ? 'approve' : 'revoke'} ${student.full_name}: ${error.message}`,
        );
        return;
      }
      setStudents((prev) =>
        prev.map((s) => (s.id === student.id ? { ...s, is_approved: approved } : s)),
      );
    } catch {
      setActionError('Network error. Please check your connection and try again.');
    } finally {
      setPendingId(null);
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    navigate('/login', { replace: true });
  }

  const approvedCount = students.filter((s) => s.is_approved).length;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner admin-container">
          <div className="topbar-title">
            <span className="topbar-eyebrow">Admin</span>
            <h1>Students</h1>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </header>

      <main className="admin admin-container">
        <section className="admin-stats" aria-label="Student totals">
          <div className="card admin-stat">
            <span className="admin-stat-label">Total</span>
            <span className="admin-stat-value">{students.length}</span>
          </div>
          <div className="card admin-stat">
            <span className="admin-stat-label">Approved</span>
            <span className="admin-stat-value admin-stat-success">{approvedCount}</span>
          </div>
          <div className="card admin-stat">
            <span className="admin-stat-label">Pending</span>
            <span className="admin-stat-value admin-stat-warning">
              {students.length - approvedCount}
            </span>
          </div>
        </section>

        <div className="admin-search">
          <input
            className="input"
            type="search"
            placeholder="Search by username, student ID or name"
            aria-label="Search students"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setActionSuccess(null);
              setAddingStudent(true);
            }}
          >
            + Add Student
          </button>
        </div>

        {actionError && (
          <p className="alert alert-error" role="alert">
            {actionError}
          </p>
        )}
        {actionSuccess && (
          <p className="alert alert-success" role="status">
            {actionSuccess}
          </p>
        )}

        {students.length > 0 && (
          <div className="admin-selection" role="toolbar" aria-label="Selection">
            <span className="admin-selection-count">
              {selectedStudents.length} selected
            </span>
            <div className="admin-selection-actions">
              <button
                type="button"
                className="btn btn-plain btn-sm"
                onClick={selectAllVisible}
                disabled={filtered.length === 0 || allVisibleSelected}
              >
                Select all visible
              </button>
              <button
                type="button"
                className="btn btn-plain btn-sm"
                onClick={clearSelection}
                disabled={selectedStudents.length === 0}
              >
                Clear selection
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => openEmail(selectedStudents)}
                disabled={selectedStudents.length === 0}
              >
                Send Email
              </button>
            </div>
          </div>
        )}

        <section className="card admin-list" aria-label="Students">
          {loading ? (
            <div className="state" role="status">
              <span className="spinner" aria-hidden="true" />
              <p>Loading students…</p>
            </div>
          ) : loadError ? (
            <div className="state" role="alert">
              <span className="state-icon state-icon-error" aria-hidden="true">
                !
              </span>
              <h2>Couldn&apos;t load students</h2>
              <p>{loadError}</p>
              <button type="button" className="btn btn-primary" onClick={() => void loadStudents()}>
                Retry
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="state" role="status">
              <span className="state-icon" aria-hidden="true">
                {students.length === 0 ? '0' : '?'}
              </span>
              <h2>{students.length === 0 ? 'No students yet' : 'No matches'}</h2>
              <p>
                {students.length === 0
                  ? 'No students have registered yet.'
                  : 'No students match your search.'}
              </p>
            </div>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th className="admin-cell-select">
                    <input
                      type="checkbox"
                      className="admin-checkbox"
                      aria-label="Select all visible students"
                      checked={allVisibleSelected}
                      onChange={() => (allVisibleSelected ? clearSelection() : selectAllVisible())}
                    />
                  </th>
                  <th>Student ID</th>
                  <th>Student</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Major</th>
                  <th>Status</th>
                  <th>
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <tr key={s.id} className={selectedIds.has(s.id) ? 'is-selected' : undefined}>
                    <td className="admin-cell-select">
                      <input
                        type="checkbox"
                        className="admin-checkbox"
                        aria-label={`Select ${s.full_name}`}
                        checked={selectedIds.has(s.id)}
                        onChange={() => toggleSelected(s.id)}
                      />
                    </td>
                    <td className="admin-cell-id text-mono" data-label="Student ID">
                      {s.student_id}
                    </td>
                    <td className="admin-cell-student" data-label="Student">
                      <span className="admin-name">{s.full_name}</span>
                      <span className="admin-username">{s.username ? `@${s.username}` : '—'}</span>
                    </td>
                    <td className="admin-cell-email" data-label="Email">
                      {s.email ?? <span className="admin-muted">No email</span>}
                    </td>
                    <td data-label="Phone">{s.phone}</td>
                    <td data-label="Major">{s.major}</td>
                    <td className="admin-cell-status" data-label="Status">
                      <span className={`badge ${s.is_approved ? 'badge-success' : 'badge-warning'}`}>
                        {s.is_approved ? 'Approved' : 'Pending'}
                      </span>
                    </td>
                    <td className="admin-cell-actions">
                      <div className="admin-actions">
                        {s.is_approved ? (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={pendingId !== null}
                            aria-busy={pendingId === s.id}
                            onClick={() => void setApproval(s, false)}
                          >
                            {pendingId === s.id ? 'Revoking…' : 'Revoke'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-tinted btn-sm"
                            disabled={pendingId !== null}
                            aria-busy={pendingId === s.id}
                            onClick={() => void setApproval(s, true)}
                          >
                            {pendingId === s.id ? 'Approving…' : 'Approve'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={pendingId !== null}
                          onClick={() => {
                            setActionSuccess(null);
                            setEditingStudent(s);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={pendingId !== null || !s.email}
                          title={s.email ? undefined : 'No email'}
                          onClick={() => openEmail([s])}
                        >
                          {s.email ? 'Email' : 'No email'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger-tinted btn-sm"
                          disabled={pendingId !== null}
                          onClick={() => {
                            setActionSuccess(null);
                            setDeletingStudent(s);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>

      {editingStudent && (
        <EditStudentDialog
          key={editingStudent.id}
          student={editingStudent}
          onClose={closeEditor}
          onSaved={(updated) => void handleStudentSaved(updated)}
        />
      )}

      {deletingStudent && (
        <DeleteStudentDialog
          key={deletingStudent.id}
          student={deletingStudent}
          onClose={closeDeleteDialog}
          onDeleted={(deleted) => void handleStudentDeleted(deleted)}
        />
      )}

      {emailRecipients && (
        <SendEmailDialog
          recipients={emailRecipients}
          onClose={closeEmailDialog}
          onSent={handleEmailSent}
        />
      )}

      {addingStudent && (
        <AddStudentDialog
          onClose={closeAddDialog}
          onCreated={(created) => void handleStudentCreated(created)}
        />
      )}
    </>
  );
}

export default AdminDashboard;
