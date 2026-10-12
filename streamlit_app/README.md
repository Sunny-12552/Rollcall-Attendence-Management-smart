# Rollcall Streamlit migration

This is a separate Python/Streamlit implementation. The original Node.js app and its Google spreadsheet remain the rollback path and are not modified by this app. Do not point both applications at the same database.

## Current migration status

The Streamlit entry point and service modules cover admin authentication/approval, QR check-in and recovery, device ownership, Google Sheets attendance, reporting, email, and account/device controls. The app is still in migration validation; see [MIGRATION.md](./MIGRATION.md) for coverage and remaining gaps. Do not use it as the production attendance system or cut over until the focused tests pass and the spreadsheet has been validated against a copy.

## Run locally

From the project root:

```powershell
py -m venv streamlit_app\.venv
streamlit_app\.venv\Scripts\Activate.ps1
python -m pip install -r streamlit_app\requirements.txt
python -m streamlit run streamlit_app\app.py
```

The default database is the separate local file `streamlit_app/data/rollcall.sqlite`. SQLite is suitable for local development only. A deployed Community Cloud app must use PostgreSQL or another durable SQLAlchemy-compatible database.

## Configure secrets

For local use, the app loads variables from the project-root `.env` file, or you can create `.streamlit\secrets.toml` (it is ignored by Git). Streamlit secrets take precedence over environment variables. `STREAMLIT_DATABASE_URL` can select a separate Streamlit database; if the shared `DATABASE_URL` is a plain file path for the Node app, Streamlit uses its separate local SQLite database instead. In Community Cloud, add the TOML values in **App settings → Secrets**. Never commit the secrets file or service-account key.

```toml
DATABASE_URL = "postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require"
APP_URL = "https://YOUR-APP-NAME.streamlit.app"
JWT_SECRET = "generate-a-random-value-of-at-least-32-characters"
MAIN_ADMIN_BOOTSTRAP_SECRET = "a-separate-one-time-setup-secret"
TIMEZONE = "Asia/Kolkata"
MIN_ATTENDANCE_PERCENTAGE = "75"
SUBJECTS = "AI-Native Full Stack,GenAI & Agentic AI,Python Full Stack,Java Full Stack,Data Science,MERN Stack Development,Frontend Development,Backend Development,DevOps & Cloud,Data Analytics"
GOOGLE_SPREADSHEET_ID = "your-spreadsheet-id"
GOOGLE_SERVICE_ACCOUNT_JSON = '''{"type":"service_account","client_email":"...","private_key":"..."}'''

EMAIL_PROVIDER = "smtp"
EMAIL_FROM = "attendance@example.com"
SMTP_HOST = "smtp.example.com"
SMTP_PORT = "587"
SMTP_SECURE = "false"
SMTP_USER = "attendance@example.com"
SMTP_PASSWORD = "..."
```

For Resend instead of SMTP:

```toml
EMAIL_PROVIDER = "resend"
EMAIL_FROM = "verified-sender@example.com"
RESEND_API_KEY = "..."
```

Share the existing spreadsheet with the service account email as an editor. Keep worksheet titles and the existing `Students`/subject matrix layout unchanged. Set `APP_URL` to the final public HTTPS URL; otherwise generated QR codes will point to the wrong place. Set `JWT_SECRET` to a long, random, private value and keep the bootstrap secret separate. Configure the email provider before testing registration, OTP, password reset, or admin notifications.

If no Main Admin is present, use the one-time bootstrap form. It can create a new Main Admin or claim an existing verified active admin using that admin's current credentials. An imported Main Admin singleton is retained and will not be replaced by bootstrap.

## Import existing admin and device records

The importer reads the Node SQLite database in SQLite read-only mode. It copies admin credentials/hashes, Main Admin configuration, OTP/session data, subject assignments, audit history, and device locks into the configured target database. Student roster and attendance remain in Google Sheets. In-memory Node QR sessions cannot be migrated.

For local migration, set `SOURCE_DATABASE_PATH` to the original database path if it is not at the default `data\attendance.sqlite`, then start the Streamlit app. Import runs once per source path and records that source in `streamlit_migrations`. It does not write to the source database. Back up both source data systems first; point the migration at a disposable copy of the target database when validating.

## Deploy to Streamlit Community Cloud

1. Push this project to a private GitHub repository without `.env`, `.streamlit/secrets.toml`, database files, or service-account JSON.
2. Create a managed PostgreSQL database with TLS and backups. Configure its SQLAlchemy URL as `DATABASE_URL` in Community Cloud secrets.
3. Grant the service account access to the existing spreadsheet and configure Google and email secrets.
4. Create a Streamlit Community Cloud app whose entry point is `streamlit_app/app.py`.
5. Add the secrets above, set `APP_URL` to the deployed app URL, and deploy.
6. Verify startup, Main Admin access, QR creation from a second device/network, attendance marking, duplicate rejection, session close/recovery, reports, email delivery, and device release using a test spreadsheet/database copy.
7. Keep the existing Node app running until records, user workflows, and concurrent submissions have been compared successfully. Cutover is a separate, explicit operation.

Community Cloud's local filesystem is ephemeral; never use the default SQLite URL for production. If the app is unavailable, preserve the original Node app and data, restore its service URL, and investigate against database/spreadsheet backups. Do not restore a backup over live data without first taking a new backup.
