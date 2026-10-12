# Streamlit migration inventory and plan

The replacement is being built in this directory. The existing Node.js application, its SQLite database, Google spreadsheet, and secrets remain separate and are not modified by the Streamlit migration.

## Source-of-truth inventory

| Area | Existing implementation and authority | Migration target |
|---|---|---|
| Admin accounts, role assignment, OTP challenges, login lockout, audit history | SQLite schema v7 in `data/attendance.sqlite`; password hashes include `bcrypt-sha256:` and legacy `scrypt$` forms | Compatible Python hash verification and a one-way, read-only SQLite import into the configured target database |
| Main Admin | Singleton `main_admin_config.admin_id`; all other database roles remain `ADMIN` | Preserve singleton authority and repeat authorization checks against the database |
| Student roster and attendance history | Google Sheets `Students` plus one date-matrix worksheet per subject; `Percentage` is a derived report | Keep the same spreadsheet, titles, headers, row identity, and date/status semantics |
| QR sessions | In-memory Node.js map; signed `id.signature` payload; session close/recovery state is lost on process restart | Store session lifecycle state in the target database while retaining a signed QR payload and original URL when recovering |
| Device security | SQLite `device_registry` and `legacy_student_device_locks`, with a SHA-256 device-token hash and admin unlock audit | Keep the same ownership rules and tables; never store raw device tokens. Google security-sheet mirrors are not yet implemented and existing security tabs remain untouched. |
| Email | SMTP or Resend; OTP expiry, resend cooldown and attempt limits are enforced in the Node server | Python SMTP/Resend sender; hashed OTPs with the existing expiry and attempt policy |
| UI and reports | `public/index.html`, `app.js`, and CSS; instructor dashboard, student check-in, recovery, logs, percentages, device and account management | Streamlit UI using the same terminology, content, and color system |
| Deployment | Node/Express on Render; SQLite may be ephemeral on the free tier | Streamlit Community Cloud entry point; PostgreSQL is recommended for durable deployed state, with local SQLite for development |

## Feature inventory

- Student check-in: name and batch validation, optional email, course mapping, QR/session validation, duplicate protection, subject attendance, and personal attendance lookup.
- Instructor: create scoped QR sessions for 5/10/20/30 minutes, view/re-display QR, close sessions, recover eligible closed sessions, finalize absences, send summaries, make today's attendance corrections, and view attendance/percentage reports.
- Device security: one active device per student and one student per device, legacy lock compatibility, observed IP, release with a reason, and device audit history.
- Authentication: registration, approval, OTP verification/resend, password login, lockout, password reset, invitation with temporary password, forced first-login password change, logout, and Main Admin bootstrap/claim.
- Main Admin controls: approvals, invitations, subject assignment, status changes, account detail edits, recovery/removal, admin access audit and login history.
- Google Sheets: roster, subject matrices, holidays/calendar, and derived percentages. Google security-sheet mirrors for Device Registry, Admin Accounts, and Admin Audit Log are not implemented; the Streamlit app leaves those tabs untouched.
- Email: OTP, invitation, password reset, attendance confirmation/absence notifications, account status, and attendance summary.
- Deployment and operations: secrets, persistent database setup, spreadsheet service-account access, health/configuration checks, tests, and rollback/import guidance.

## Implementation order

1. Preserve the source project and map source schema, routes, worksheets, UI, and tests.
2. Build database/configuration/security/email/Sheets service modules in this separate directory.
3. Implement and test student check-in, signed QR lifecycle/recovery, device binding, session closure, and reports.
4. Implement admin registration, OTP, Main Admin setup/approval, permissions, account/device screens, and audit events.
5. Add an explicit one-way migration/import path and validate source-data compatibility on temporary copies.
6. Add Community Cloud configuration and deployment instructions. Do not cut over or deploy until every feature marked in the source inventory is implemented and its focused tests pass.

## Compatibility and rollout constraints

- The existing database importer reads the Node SQLite database in read-only mode. It must never run reset scripts or write to the source file.
- Existing attendance records stay in the original Google spreadsheet. The migration must not clear a worksheet or shift values under unrecognized headers.
- The target database defaults to a separate local SQLite file. A production Community Cloud deployment must configure a durable PostgreSQL `DATABASE_URL`; Streamlit Community Cloud's local filesystem is not durable storage.
- QR/session recovery must not weaken QR signatures, admin subject authorization, student duplicate checks, or device locks.
- A deployment cutover is not part of local implementation. The existing Node app remains available as the rollback path until a separately approved cutover is completed.

## Current status

The separate Streamlit app includes the core UI and services, but it is not yet a feature-complete or deploy-ready replacement. The focused Python tests pass (11 tests) after the latest settings, caching, and error-handling edits. The original Node test suite previously passed (57 tests); the Node application has not been changed in this work.

Still unvalidated or incomplete:

- Google Sheets security mirrors for `Device Registry`, `Admin Accounts`, and `Admin Audit Log`. In particular, the original live `Admin Accounts` tab has an unsupported header layout; the Streamlit app must not rewrite it.
- Real Google API writes/reads, SMTP or Resend delivery, cross-device/network QR check-in, PostgreSQL concurrency and persistence, and Community Cloud deployment.
- Full interactive UI workflows and verification against a disposable copy of the production spreadsheet/database.

Do not cut over from Node or use the migration with live attendance until these gaps are resolved and the complete validation checklist in the README passes. Keep the Node app and original data as the rollback path.
