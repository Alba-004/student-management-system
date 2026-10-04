import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import './AdminDashboard.css';

const FEATURES = [
  {
    title: 'Review registrations',
    text: 'New students start as Pending. Approve them to allow login, or revoke access at any time.',
  },
  {
    title: 'Manage students',
    text: 'Search by name, username or Student ID. Add, edit or permanently delete student accounts.',
  },
  {
    title: 'Email students',
    text: 'Send a message to one student, or select several and send the same message to all of them.',
  },
];

const STEPS = [
  'Open Students to see every registered student and their approval status.',
  'Approve pending students so they can log in to their dashboard.',
  'Use Edit to correct a profile, or Email to contact a student.',
  'Select students with the checkboxes to send one message to many.',
];

function AdminAbout() {
  const navigate = useNavigate();

  async function handleLogout() {
    await supabase.auth.signOut();
    navigate('/login', { replace: true });
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner admin-container">
          <div className="topbar-title">
            <span className="topbar-eyebrow">Admin</span>
            <h1>About</h1>
          </div>
          <div className="admin-topbar-actions">
            <Link to="/admin" className="btn btn-tinted btn-sm">
              Students
            </Link>
            <button type="button" className="btn btn-secondary btn-sm" onClick={handleLogout}>
              Log out
            </button>
          </div>
        </div>
      </header>

      <main className="admin admin-container">
        <section className="card admin-about-hero">
          <span className="admin-about-mark" aria-hidden="true">
            S
          </span>
          <h2>Student Management System</h2>
          <p className="card-subtitle">
            A simple place to review student registrations, keep student records up to date and
            stay in touch with students.
          </p>
        </section>

        <section className="admin-about-grid" aria-label="What you can do">
          {FEATURES.map((feature) => (
            <article key={feature.title} className="card admin-about-feature">
              <h3>{feature.title}</h3>
              <p>{feature.text}</p>
            </article>
          ))}
        </section>

        <section className="card" aria-labelledby="getting-started">
          <h2 id="getting-started">Getting started</h2>
          <ol className="admin-about-steps">
            {STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <Link to="/admin" className="btn btn-primary">
            Go to students
          </Link>
        </section>
      </main>
    </>
  );
}

export default AdminAbout;
