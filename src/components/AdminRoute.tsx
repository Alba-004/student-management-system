import { useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { isCurrentUserAdmin } from '../lib/auth';

type Access = 'checking' | 'admin' | 'not-admin' | 'signed-out';

/*
 * Only renders its children for the admin. The role is checked in the database
 * (public.is_admin) on every visit; RLS and the approval function enforce the
 * same rule server-side, so this guard is a UX layer, not the security boundary.
 */
function AdminRoute({ children }: { children: ReactNode }) {
  const [access, setAccess] = useState<Access>('checking');

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        if (!cancelled) setAccess('signed-out');
        return;
      }
      try {
        const admin = await isCurrentUserAdmin();
        if (!cancelled) setAccess(admin ? 'admin' : 'not-admin');
      } catch {
        if (!cancelled) setAccess('not-admin');
      }
    }

    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  if (access === 'checking') {
    return (
      <main className="page-state">
        <div className="state" role="status">
          <span className="spinner" aria-hidden="true" />
          <p>Checking access…</p>
        </div>
      </main>
    );
  }
  if (access === 'signed-out') return <Navigate to="/login" replace />;
  if (access === 'not-admin') return <Navigate to="/student" replace />;
  return <>{children}</>;
}

export default AdminRoute;
