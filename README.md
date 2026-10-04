# Student Management System

## Authentication (development-only setup)

> **Development only. Must be redesigned before production.**

Supabase Auth has no username login, so the app maps each username to an
internal, non-deliverable auth email: `<username>@users.invalid`
(see `src/lib/auth.ts`). Supabase Auth still manages passwords, hashing and
sessions; no password data is stored in `public.students`.

- **Required Supabase setting:** Authentication → Sign In / Providers → Email:
  *Enable Email provider* ON, *Confirm email* **OFF**.
- The `on_auth_user_created` trigger derives `students.username` from the auth
  email and rejects any domain other than `users.invalid`.
- Usernames: lowercase `a-z`, `0-9`, `_`, 3–30 characters, unique, not changeable.
- Not available in this phase: email verification and password reset (an
  admin resets passwords in the Supabase dashboard). Supabase Auth itself
  still sends no email.
- New accounts start with `is_approved = false`; login is refused until an
  admin approves the student.
- **Admin (single account):** logs in on the Login page's *Admin* tab; the
  username maps to `<username>@admin.invalid`. It is never created through
  registration. Setup: pre-register the email in `public.admins` from the SQL
  Editor, then create the user in Authentication → Users → Add user (see
  `supabase/migrations/20261002000400_admin_role.sql`). Admin status is checked
  in the database (`public.is_admin()`), and approval changes go through
  `public.set_student_approval()`.


## Email (Resend, server-side only)

- `students.email` is the student's **real** email (contact only). The internal
  login address lives in `students.auth_email` and is unchanged.
- Emails are sent only by Supabase Edge Functions:
  - `send-welcome-email`: one welcome email after registration (once per student).
  - `admin-send-email`: admin-only, single or bulk (Resend batch API).
- Server-side secrets (Supabase → Edge Functions → Secrets), **never** `VITE_*`
  or `.env.local`: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`.

---

# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```

You can also install [eslint-plugin-react-x](https://npmx.dev/package/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://npmx.dev/package/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```
