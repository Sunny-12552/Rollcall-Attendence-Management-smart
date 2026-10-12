from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from dotenv import load_dotenv
from sqlalchemy.engine import URL


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SUBJECTS = (
    "AI-Native Full Stack",
    "GenAI & Agentic AI",
    "Python Full Stack",
    "Java Full Stack",
    "Data Science",
    "MERN Stack Development",
    "Frontend Development",
    "Backend Development",
    "DevOps & Cloud",
    "Data Analytics",
)
BATCHES = tuple(
    f"{prefix}{number}"
    for prefix in ("P", "J", "D")
    for number in range(1, 11)
)


def setting(name: str, default: str = "", secrets: Mapping | None = None) -> str:
    if secrets is not None and name in secrets:
        return str(secrets[name]).strip()
    return os.environ.get(name, default).strip()


def _sqlite_url(path: str) -> str:
    database_path = Path(path).expanduser()
    if not database_path.is_absolute():
        database_path = ROOT / database_path
    return URL.create(
        "sqlite+pysqlite",
        database=str(database_path.resolve()),
    ).render_as_string(hide_password=False)


@dataclass(frozen=True)
class Settings:
    database_url: str
    database_warning: str
    source_database_path: str
    spreadsheet_id: str
    service_account_json: str
    service_account_file: str
    app_url: str
    jwt_secret: str
    bootstrap_secret: str
    email_provider: str
    email_from: str
    resend_api_key: str
    smtp_host: str
    smtp_port: int
    smtp_secure: bool
    smtp_user: str
    smtp_password: str
    timezone: str
    holidays: frozenset[str]
    minimum_attendance_percentage: float
    subjects: tuple[str, ...]


def load_settings(secrets: Mapping | None = None) -> Settings:
    load_dotenv(ROOT / ".env", override=False)
    default_db = str(ROOT / "streamlit_app" / "data" / "rollcall.sqlite")
    database_url = setting("STREAMLIT_DATABASE_URL", "", secrets)
    database_warning = ""
    if database_url and not database_url.startswith(
        (
            "sqlite://",
            "sqlite+pysqlite://",
            "postgres://",
            "postgresql://",
            "postgresql+psycopg://",
        )
    ):
        if "://" not in database_url and (
            "/" in database_url
            or "\\" in database_url
            or database_url.lower().endswith((".db", ".sqlite", ".sqlite3"))
        ):
            database_url = _sqlite_url(database_url)
        else:
            database_url = ""
            database_warning = (
                "STREAMLIT_DATABASE_URL is not a supported SQLite or PostgreSQL "
                "URL/path. Streamlit is using its separate local database."
            )
    if not database_url:
        shared_database_url = setting("DATABASE_URL", "", secrets)
        if shared_database_url and not shared_database_url.startswith(
            (
                "sqlite://",
                "sqlite+pysqlite://",
                "postgres://",
                "postgresql://",
                "postgresql+psycopg://",
            )
        ):
            shared_database_url = ""
            database_warning = database_warning or (
                "DATABASE_URL is a plain file path for the Node app. Streamlit is "
                "using its separate local database; set STREAMLIT_DATABASE_URL to "
                "override it."
            )
        database_url = shared_database_url
    if not database_url:
        database_url = _sqlite_url(default_db)

    raw_subjects = setting("SUBJECTS", ",".join(DEFAULT_SUBJECTS), secrets)
    subjects = tuple(
        " ".join(subject.split())
        for subject in raw_subjects.split(",")
        if subject.strip()
    )[:10]

    try:
        smtp_port = int(setting("SMTP_PORT", "587", secrets))
        minimum_attendance = float(
            setting("MIN_ATTENDANCE_PERCENTAGE", "75", secrets)
        )
    except ValueError as error:
        raise ValueError("SMTP_PORT and MIN_ATTENDANCE_PERCENTAGE must be numeric.") from error

    raw_holidays = setting("HOLIDAYS", "", secrets)
    holidays = frozenset(
        date.strip()
        for date in raw_holidays.split(",")
        if len(date.strip()) == 10
    )
    return Settings(
        database_url=database_url,
        database_warning=database_warning,
        source_database_path=setting(
            "SOURCE_DATABASE_PATH",
            str(ROOT / "data" / "attendance.sqlite"),
            secrets,
        ),
        spreadsheet_id=setting("GOOGLE_SPREADSHEET_ID", "", secrets),
        service_account_json=setting("GOOGLE_SERVICE_ACCOUNT_JSON", "", secrets),
        service_account_file=setting("GOOGLE_SERVICE_ACCOUNT_FILE", "", secrets),
        app_url=setting("APP_URL", "", secrets).rstrip("/"),
        jwt_secret=setting("JWT_SECRET", "", secrets),
        bootstrap_secret=setting("MAIN_ADMIN_BOOTSTRAP_SECRET", "", secrets),
        email_provider=setting("EMAIL_PROVIDER", "smtp", secrets).lower(),
        email_from=setting("EMAIL_FROM", setting("SMTP_FROM", "", secrets), secrets),
        resend_api_key=setting("RESEND_API_KEY", "", secrets),
        smtp_host=setting("SMTP_HOST", "", secrets),
        smtp_port=smtp_port,
        smtp_secure=setting("SMTP_SECURE", "false", secrets).lower() == "true",
        smtp_user=setting("SMTP_USER", "", secrets),
        smtp_password=setting("SMTP_PASSWORD", "", secrets),
        timezone=setting("TIMEZONE", "Asia/Kolkata", secrets),
        holidays=holidays,
        minimum_attendance_percentage=minimum_attendance,
        subjects=subjects,
    )


def load_service_account(settings: Settings) -> dict:
    if settings.service_account_file:
        path = Path(settings.service_account_file).expanduser()
        if not path.is_file():
            raise FileNotFoundError("GOOGLE_SERVICE_ACCOUNT_FILE is not an accessible file.")
        raw = path.read_text(encoding="utf-8")
    else:
        raw = settings.service_account_json
        if raw and not raw.lstrip().startswith("{"):
            path = Path(raw).expanduser()
            if not path.is_file():
                raise FileNotFoundError("GOOGLE_SERVICE_ACCOUNT_JSON is neither JSON nor a file path.")
            raw = path.read_text(encoding="utf-8")
    if not raw:
        raise ValueError("Google service-account credentials are not configured.")
    try:
        credentials = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError("Google service-account credentials are invalid JSON.") from error
    if not credentials.get("client_email") or not credentials.get("private_key"):
        raise ValueError("Google service-account credentials are missing required fields.")
    return credentials
