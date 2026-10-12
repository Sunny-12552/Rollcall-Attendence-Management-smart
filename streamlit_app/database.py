from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable, Mapping

from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.engine import URL, make_url


SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'ADMIN' CHECK (role = 'ADMIN'),
      is_verified INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login TEXT,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      last_successful_login TEXT,
      last_password_change_at TEXT,
      account_lock_until BIGINT,
      last_status_change_at TEXT,
      removed_at TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      phone TEXT,
      approval_status TEXT NOT NULL DEFAULT 'approved',
      approval_reviewed_at TEXT,
      approval_reviewed_by TEXT REFERENCES admins(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS otp_verifications (
      id TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL UNIQUE REFERENCES admins(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'invite', 'reset')),
      otp_hash TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_sent_at BIGINT NOT NULL,
      created_at TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL,
      created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS main_admin_config (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      admin_id TEXT UNIQUE REFERENCES admins(id),
      created_at TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS admin_subject_assignments (
      admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      assigned_at TEXT NOT NULL,
      assigned_by TEXT REFERENCES admins(id),
      PRIMARY KEY (admin_id, subject)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS admin_access_requests (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewed_by TEXT REFERENCES admins(id),
      rejection_reason TEXT,
      invite_admin_id TEXT REFERENCES admins(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      admin_id TEXT NOT NULL REFERENCES admins(id),
      acting_admin_role TEXT NOT NULL DEFAULT 'ADMIN',
      target_admin_id TEXT,
      action TEXT NOT NULL,
      affected_record TEXT NOT NULL,
      reason TEXT NOT NULL,
      result TEXT NOT NULL DEFAULT 'success'
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS device_registry (
      id TEXT PRIMARY KEY,
      device_hash TEXT NOT NULL,
      student_key TEXT NOT NULL,
      student_id TEXT,
      student_name TEXT NOT NULL,
      batch TEXT NOT NULL,
      course TEXT NOT NULL,
      registered_ip TEXT NOT NULL DEFAULT '',
      first_registered_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      last_attendance_subject TEXT NOT NULL DEFAULT '',
      last_attendance_date TEXT NOT NULL DEFAULT '',
      admin_unlock_timestamp TEXT,
      unlock_reason TEXT NOT NULL DEFAULT ''
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS legacy_student_device_locks (
      student_key TEXT PRIMARY KEY,
      device_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS qr_sessions (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      batch TEXT,
      faculty_name TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES admins(id),
      created_at BIGINT NOT NULL,
      attendance_date TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
      closed_at BIGINT,
      close_result TEXT,
      recovery_count INTEGER NOT NULL DEFAULT 0,
      last_recovered_at TEXT,
      qr_url TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS qr_session_students (
      session_id TEXT NOT NULL REFERENCES qr_sessions(id) ON DELETE CASCADE,
      student_key TEXT NOT NULL,
      student_name TEXT NOT NULL,
      batch TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('Present', 'Absent')),
      PRIMARY KEY (session_id, student_key)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS device_attendance_locks (
      attendance_date TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES qr_sessions(id) ON DELETE CASCADE,
      device_hash TEXT NOT NULL,
      student_key TEXT NOT NULL,
      PRIMARY KEY (attendance_date, session_id, device_hash)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS attendance_student_locks (
      session_id TEXT NOT NULL REFERENCES qr_sessions(id) ON DELETE CASCADE,
      student_key TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (session_id, student_key)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS streamlit_migrations (
      source TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL,
      schema_version INTEGER NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS auth_sessions_admin_idx ON auth_sessions(admin_id)",
    "CREATE INDEX IF NOT EXISTS otp_verifications_expiry_idx ON otp_verifications(expires_at)",
    "CREATE INDEX IF NOT EXISTS admin_audit_timestamp_idx ON admin_audit_log(timestamp)",
    "CREATE INDEX IF NOT EXISTS admin_subject_assignments_subject_idx ON admin_subject_assignments(subject)",
    "CREATE INDEX IF NOT EXISTS qr_sessions_status_expiry_idx ON qr_sessions(status, expires_at)",
    "CREATE UNIQUE INDEX IF NOT EXISTS admins_email_lower_unique_idx ON admins(lower(email))",
    "CREATE UNIQUE INDEX IF NOT EXISTS admins_phone_unique_idx ON admins(phone) WHERE phone IS NOT NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS device_registry_active_device_idx ON device_registry(device_hash) WHERE status = 'active'",
    "CREATE UNIQUE INDEX IF NOT EXISTS device_registry_active_student_idx ON device_registry(student_key) WHERE status = 'active'",
)


def engine_for(database_url: str) -> Engine:
    if database_url.startswith("postgres://"):
        database_url = "postgresql+psycopg://" + database_url[len("postgres://") :]
    elif database_url.startswith("postgresql://"):
        database_url = "postgresql+psycopg://" + database_url[len("postgresql://") :]
    elif database_url.startswith("sqlite:///") and not database_url.startswith("sqlite:////"):
        relative_path = database_url[len("sqlite:///") :]
        if relative_path and relative_path != ":memory:":
            database_url = URL.create(
                "sqlite+pysqlite",
                database=str((Path.cwd() / relative_path).resolve()),
            ).render_as_string(hide_password=False)
    if database_url.startswith("sqlite"):
        database = make_url(database_url).database
        if database and database != ":memory:":
            Path(database).expanduser().resolve().parent.mkdir(
                parents=True,
                exist_ok=True,
            )
        engine = create_engine(
            database_url,
            connect_args={"check_same_thread": False, "timeout": 30},
            pool_pre_ping=True,
        )
        @event.listens_for(engine, "connect")
        def _enable_sqlite_constraints(connection, _record) -> None:
            cursor = connection.cursor()
            cursor.execute("PRAGMA foreign_keys = ON")
            cursor.execute("PRAGMA busy_timeout = 5000")
            cursor.close()

        return engine
    return create_engine(database_url, pool_pre_ping=True)


def ensure_target_database_is_separate(
    database_url: str,
    source_path: str,
) -> None:
    if not source_path:
        return
    database = make_url(database_url)
    if database.get_backend_name() != "sqlite" or database.database in (
        None,
        ":memory:",
    ):
        return
    source = Path(source_path).expanduser().resolve()
    target = Path(database.database).expanduser().resolve()
    if source == target:
        raise ValueError(
            "DATABASE_URL must point to a separate target database; the original SQLite source is read-only."
        )


@lru_cache(maxsize=8)
def cached_engine(database_url: str) -> Engine:
    return engine_for(database_url)


def initialize_database(engine: Engine) -> None:
    if engine.dialect.name == "sqlite":
        with engine.connect() as connection:
            connection.exec_driver_sql("PRAGMA foreign_keys = ON")
            connection.exec_driver_sql("PRAGMA journal_mode = WAL")
            connection.exec_driver_sql("PRAGMA busy_timeout = 5000")
            connection.commit()
    with engine.begin() as connection:
        for statement in SCHEMA:
            connection.execute(text(statement))
        connection.execute(
            text(
                "INSERT INTO main_admin_config (singleton, admin_id, created_at) "
                "VALUES (1, NULL, NULL) ON CONFLICT (singleton) DO NOTHING"
            )
        )


def rows(
    engine: Engine, statement: str, parameters: Mapping[str, Any] | None = None
) -> list[dict[str, Any]]:
    with engine.connect() as connection:
        return [
            dict(row)
            for row in connection.execute(text(statement), parameters or {}).mappings()
        ]


def row(
    engine: Engine, statement: str, parameters: Mapping[str, Any] | None = None
) -> dict[str, Any] | None:
    with engine.connect() as connection:
        result = connection.execute(
            text(statement), parameters or {}
        ).mappings().first()
        return dict(result) if result is not None else None


def execute(
    engine: Engine,
    statement: str,
    parameters: Mapping[str, Any] | None = None,
) -> int:
    with engine.begin() as connection:
        result = connection.execute(text(statement), parameters or {})
        return result.rowcount


def import_legacy_sqlite(engine: Engine, source_path: str) -> dict[str, int]:
    source = Path(source_path).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(f"Source attendance database does not exist: {source}")
    source_db = sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True)
    source_db.row_factory = sqlite3.Row
    try:
        schema_version = int(
            source_db.execute("PRAGMA user_version").fetchone()[0]
        )
        if schema_version > 7:
            raise ValueError(f"Unsupported source database schema version {schema_version}.")
        table_names = {
            record["name"]
            for record in source_db.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        tables = (
            "admins",
            "main_admin_config",
            "admin_subject_assignments",
            "device_registry",
            "legacy_student_device_locks",
            "otp_verifications",
            "auth_sessions",
            "admin_access_requests",
            "admin_audit_log",
        )
        counts: dict[str, int] = {}
        with engine.begin() as connection:
            if connection.execute(
                text("SELECT 1 FROM streamlit_migrations WHERE source = :source"),
                {"source": str(source)},
            ).first():
                return {"already_imported": 1}
            for table in tables:
                if table not in table_names:
                    continue
                records = source_db.execute(f'SELECT * FROM "{table}"').fetchall()
                if not records:
                    counts[table] = 0
                    continue
                columns = list(records[0].keys())
                column_list = ", ".join(f'"{column}"' for column in columns)
                bind_list = ", ".join(f":{column}" for column in columns)
                conflict = (
                    "ON CONFLICT (singleton) DO UPDATE SET "
                    "admin_id = excluded.admin_id, created_at = excluded.created_at "
                    "WHERE main_admin_config.admin_id IS NULL"
                    if table == "main_admin_config"
                    else "ON CONFLICT DO NOTHING"
                )
                insert = text(
                    f'INSERT INTO "{table}" ({column_list}) VALUES ({bind_list}) {conflict}'
                )
                count = 0
                for record in records:
                    result = connection.execute(insert, dict(record))
                    count += max(result.rowcount, 0)
                counts[table] = count
            connection.execute(
                text(
                    "INSERT INTO streamlit_migrations "
                    "(source, imported_at, schema_version) "
                    "VALUES (:source, :imported_at, :schema_version)"
                ),
                {
                    "source": str(source),
                    "imported_at": datetime.now(timezone.utc).isoformat(),
                    "schema_version": schema_version,
                },
            )
        return counts
    finally:
        source_db.close()
