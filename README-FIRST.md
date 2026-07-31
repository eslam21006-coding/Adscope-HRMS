> Updated interface: human-readable English messages; no raw JSON in operational screens.

# Adscope HRMS Cloud v1

This is the Supabase-connected frontend for the existing Adscope HRMS database.

## What works
- Supabase email/password login
- Owner and HR Admin role-aware navigation
- Dashboard
- Employees and compensation updates
- Attendance month generation and review
- Leave decisions
- Violations and final policy action
- Payroll preflight, generation and lifecycle
- Policy handbook and violation matrix
- Audit log
- Employee attendance portal using the deployed JWT-protected Edge Function

## Deploy
1. Extract the ZIP completely.
2. Double-click `DEPLOY-TO-VERCEL.bat` on Windows.
3. Sign in to Vercel in the browser.
4. When prompted, create a new project and use the current folder.
5. Copy the final `vercel.app` URL.

## Test accounts
- Owner: `eslam@adscope.net`
- HR Admin: `nrewan331@gmail.com`

Passwords remain private and are never included in this package.

## After the first deployment
Open the Vercel URL and sign in through `/admin/`.

Then add custom domains in Vercel:
- `hrms.adscope.net`
- `attendance.adscope.net`

Both domains may point to the same project. The root page routes `hrms.*` to `/admin/` and `attendance.*` to `/attendance/`.

## Supabase Auth URL settings
After the custom domains resolve, add these in Supabase Authentication > URL Configuration:
- Site URL: `https://hrms.adscope.net`
- Redirect URL: `https://hrms.adscope.net/**`
- Redirect URL: `https://attendance.adscope.net/**`

## Security
The package contains only the Supabase publishable key, which is intended for browser use with RLS. It does not contain a service-role key, secret key, database password, or user password.
