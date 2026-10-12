from __future__ import annotations

import hashlib
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text

from streamlit_app import attendance_service
from streamlit_app.attendance_service import (
    AttendanceError,
    close_session,
    create_session,
    mark_attendance,
    percentage_records,
    recover_session,
)
from streamlit_app.auth_service import AuthenticationError, _verify_challenge
from streamlit_app.database import (
    engine_for,
    ensure_target_database_is_separate,
    import_legacy_sqlite,
    initialize_database,
    row,
)
from streamlit_app.google_sheets import GoogleSheets
from streamlit_app.security import (
    hash_otp,
    hash_password,
    sign_qr_session,
    verify_password,
    verify_qr_session,
)
from streamlit_app.settings import Settings, load_settings


class MemorySheets:
    def __init__(
        self,
        student: dict[str, str] | list[dict[str, str]],
        barrier: threading.Barrier | None = None,
    ):
        self.roster = [dict(item) for item in student] if isinstance(student, list) else [dict(student)]
        self.student = self.roster[0]
        self.matrix = [["Student ID", "Student Name", "Batch"]]
        self.matrix.extend(
            [item["id"], item["name"], item["batch"]] for item in self.roster
        )
        self.barrier = barrier
        self.write_count = 0
        self.write_lock = threading.Lock()
        self.barrier_threads: set[int] = set()
        self.percentage_rows = None

    def students(self) -> list[dict[str, str]]:
        return [dict(student) for student in self.roster]

    def subject_matrices(self, subjects: tuple[str, ...]) -> dict[str, list[list[str]]]:
        matrix = [list(row) for row in self.matrix]
        if self.barrier:
            thread_id = threading.get_ident()
            with self.write_lock:
                should_wait = thread_id not in self.barrier_threads
                self.barrier_threads.add(thread_id)
            if should_wait:
                self.barrier.wait(timeout=5)
        return {subject: matrix for subject in subjects}

    def ensure_student(self, name: str, batch: str, email: str, students=None):
        student = next(
            item
            for item in self.roster
            if item["name"] == name and item["batch"] == batch
        )
        return dict(student)

    def write_attendance(
        self,
        subject: str,
        day: str,
        name: str,
        batch: str,
        status: str,
        student_id: str,
    ) -> None:
        with self.write_lock:
            if day not in self.matrix[0]:
                self.matrix[0].append(day)
                for student in self.matrix[1:]:
                    student.append("")
            column = self.matrix[0].index(day)
            student_row = next(row for row in self.matrix[1:] if row[0] == student_id)
            student_row[column] = status
            self.write_count += 1

    def write_percentage(self, values):
        self.percentage_rows = values

    def update_recovered_absence(
        self,
        subject: str,
        day: str,
        name: str,
        batch: str,
        student_id: str = "",
    ) -> bool:
        if day not in self.matrix[0]:
            return False
        student_row = next(
            (
                row
                for row in self.matrix[1:]
                if row[0] == student_id
                and row[1].casefold() == name.casefold()
                and row[2] == batch
            ),
            None,
        )
        if not student_row or student_row[self.matrix[0].index(day)] != "Absent":
            return False
        student_row[self.matrix[0].index(day)] = "Present"
        self.write_count += 1
        return True


def _settings() -> Settings:
    return load_settings(
        {
            "DATABASE_URL": "sqlite:///:memory:",
            "APP_URL": "https://attendance.example.test",
            "JWT_SECRET": "unit-test-signing-secret-with-more-than-32-chars",
            "TIMEZONE": "Asia/Kolkata",
            "SUBJECTS": "Python,Java",
        }
    )


def _database(path: Path | None = None):
    engine = engine_for(
        f"sqlite:///{path.as_posix()}" if path else "sqlite:///:memory:"
    )
    initialize_database(engine)
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO admins "
                "(id, name, email, role, is_verified, is_active, approval_status, "
                "created_at, updated_at) "
                "VALUES ('admin-1', 'Main Admin', 'admin@example.test', 'ADMIN', "
                "1, 1, 'approved', '2026-01-01', '2026-01-01')"
            )
        )
        connection.execute(
            text(
                "UPDATE main_admin_config SET admin_id = 'admin-1', "
                "created_at = '2026-01-01' WHERE singleton = 1"
            )
        )
    return engine


def _admin() -> dict:
    return {
        "id": "admin-1",
        "name": "Main Admin",
        "email": "admin@example.test",
        "effective_role": "MAIN_ADMIN",
        "subjects": [],
    }


def _qr_session(engine, settings, sheets) -> dict:
    return create_session(
        engine,
        sheets,
        settings,
        _admin(),
        "Python",
        "P1",
        30,
    )


def test_password_hash_and_signed_qr_compatibility():
    encoded = hash_password("correct-horse-battery")
    assert encoded.startswith("bcrypt-sha256:")
    assert verify_password("correct-horse-battery", encoded)
    assert not verify_password("wrong-password", encoded)

    token = sign_qr_session("session-id", "a sufficiently long signing secret")
    assert verify_qr_session(token, "a sufficiently long signing secret") == "session-id"
    assert verify_qr_session(token, "a different signing secret") is None


def test_otp_is_consumed_and_cannot_be_reused():
    engine = _database()
    challenge_hash = hash_otp("123456")
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO otp_verifications "
                "(id, admin_id, purpose, otp_hash, expires_at, attempts, "
                "last_sent_at, created_at, verified) "
                "VALUES ('otp-1', 'admin-1', 'verify', :hash, :expiry, 0, "
                ":sent, '2026-01-01', 0)"
            ),
            {
                "hash": challenge_hash,
                "expiry": 4_000_000_000_000,
                "sent": 1,
            },
        )
    admin = {"id": "admin-1"}
    challenge = row(engine, "SELECT * FROM otp_verifications WHERE id = 'otp-1'")
    _verify_challenge(engine, admin, challenge, "verify", "123456")

    with pytest.raises(AuthenticationError):
        _verify_challenge(engine, admin, challenge, "verify", "123456")


def test_wrong_otp_attempt_is_counted():
    engine = _database()
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO otp_verifications "
                "(id, admin_id, purpose, otp_hash, expires_at, attempts, "
                "last_sent_at, created_at, verified) "
                "VALUES ('otp-2', 'admin-1', 'reset', :hash, :expiry, 0, "
                ":sent, '2026-01-01', 0)"
            ),
            {
                "hash": hash_otp("123456"),
                "expiry": 4_000_000_000_000,
                "sent": 1,
            },
        )
    challenge = row(engine, "SELECT * FROM otp_verifications WHERE id = 'otp-2'")
    with pytest.raises(AuthenticationError, match="incorrect"):
        _verify_challenge(engine, {"id": "admin-1"}, challenge, "reset", "654321")
    assert row(
        engine, "SELECT attempts FROM otp_verifications WHERE id = 'otp-2'"
    )["attempts"] == 1


def test_attendance_marks_once_and_updates_device_after_sheet_write(monkeypatch):
    engine = _database()
    settings = _settings()
    student = {
        "id": "student-1",
        "name": "Sam Yu",
        "batch": "P1",
        "email": "",
    }
    sheets = MemorySheets(student)
    qr = _qr_session(engine, settings, sheets)
    today = datetime.now(ZoneInfo(settings.timezone)).date()
    if today.weekday() == 6:
        today += timedelta(days=1)
    monkeypatch.setattr(
        attendance_service,
        "today_and_time",
        lambda _timezone: (today.isoformat(), "09:00:00"),
    )

    result = mark_attendance(
        engine, sheets, settings, qr["token"], "Sam Yu", "P1", "", "device-token-0001"
    )
    assert result["status"] == "Present"
    assert sheets.write_count == 1
    device = row(engine, "SELECT * FROM device_registry WHERE status = 'active'")
    assert device["last_attendance_subject"] == "Python"
    assert device["last_attendance_date"] == today.isoformat()

    with pytest.raises(AttendanceError, match="already been marked"):
        mark_attendance(
            engine,
            sheets,
            settings,
            qr["token"],
            "Sam Yu",
            "P1",
            "",
            "device-token-0002",
        )
    assert sheets.write_count == 1


def test_concurrent_same_student_submissions_are_serialized(monkeypatch, tmp_path):
    engine = _database(tmp_path / "attendance.sqlite")
    settings = _settings()
    student = {
        "id": "student-2",
        "name": "Casey Student",
        "batch": "P1",
        "email": "",
    }
    barrier = threading.Barrier(2)
    sheets = MemorySheets(student, barrier)
    qr = _qr_session(engine, settings, sheets)
    today = datetime.now(ZoneInfo(settings.timezone)).date()
    if today.weekday() == 6:
        today += timedelta(days=1)
    monkeypatch.setattr(
        attendance_service,
        "today_and_time",
        lambda _timezone: (today.isoformat(), "09:00:00"),
    )

    def submit(device_token: str):
        try:
            mark_attendance(
                engine,
                sheets,
                settings,
                qr["token"],
                student["name"],
                student["batch"],
                "",
                device_token,
            )
            return "saved"
        except AttendanceError:
            return "rejected"

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(
            executor.map(submit, ("device-token-0101", "device-token-0102"))
        )
    assert outcomes.count("saved") == 1
    assert sheets.write_count == 1
    assert row(
        engine,
        "SELECT COUNT(*) AS count FROM qr_session_students "
        "WHERE session_id = :session AND status = 'Present'",
        {"session": qr["id"]},
    )["count"] == 1


def test_close_and_recover_keeps_original_qr_and_replaces_only_absence(monkeypatch):
    engine = _database()
    settings = _settings()
    students = [
        {"id": "student-1", "name": "Sam Yu", "batch": "P1", "email": ""},
        {"id": "student-2", "name": "Casey Student", "batch": "P1", "email": ""},
    ]
    sheets = MemorySheets(students)
    qr = _qr_session(engine, settings, sheets)
    today = datetime.now(ZoneInfo(settings.timezone)).date()
    if today.weekday() == 6:
        today += timedelta(days=1)
    day = today.isoformat()
    with engine.begin() as connection:
        connection.execute(
            text("UPDATE qr_sessions SET attendance_date = :day WHERE id = :id"),
            {"day": day, "id": qr["id"]},
        )
    monkeypatch.setattr(
        attendance_service,
        "today_and_time",
        lambda _timezone: (day, "09:00:00"),
    )

    mark_attendance(
        engine, sheets, settings, qr["token"], "Sam Yu", "P1", "", "device-token-1001"
    )
    closed = close_session(engine, sheets, settings, qr["id"])
    assert closed["added"] == 1
    assert sheets.matrix[2][sheets.matrix[0].index(day)] == "Absent"

    recovered = recover_session(engine, _admin(), qr["id"])
    assert recovered["qr_url"] == qr["url"]
    assert recovered["recovery_count"] == 1
    assert recovered["status"] == "active"

    result = mark_attendance(
        engine,
        sheets,
        settings,
        qr["token"],
        "Casey Student",
        "P1",
        "",
        "device-token-1002",
    )
    assert result["status"] == "Present"
    assert sheets.matrix[2][sheets.matrix[0].index(day)] == "Present"


def test_recovery_rejects_admin_without_subject_access():
    engine = _database()
    settings = _settings()
    sheets = MemorySheets(
        {"id": "student-1", "name": "Sam Yu", "batch": "P1", "email": ""}
    )
    qr = _qr_session(engine, settings, sheets)
    with engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE qr_sessions SET status = 'closed', closed_at = 1 "
                "WHERE id = :id"
            ),
            {"id": qr["id"]},
        )
    restricted_admin = {
        **_admin(),
        "effective_role": "ADMIN",
        "subjects": ["Java"],
    }
    with pytest.raises(AuthenticationError, match="access to this subject"):
        recover_session(engine, restricted_admin, qr["id"])


def test_percentage_report_uses_class_meetings_and_present_marks():
    students = [
        {
            "id": "student-1",
            "name": "Sam Yu",
            "batch": "P1",
            "email": "",
        }
    ]
    records = [
        {
            "name": "Sam Yu",
            "batch": "P1",
            "subject": "Python",
            "date": "2026-10-01",
            "status": "Present",
        },
        {
            "name": "Sam Yu",
            "batch": "P1",
            "subject": "Python",
            "date": "2026-10-02",
            "status": "Absent",
        },
        {
            "name": "Sam Yu",
            "batch": "P1",
            "subject": "Java",
            "date": "2026-10-01",
            "status": "Present",
        },
    ]
    report = percentage_records(students, records, ("Python", "Java"))
    python = next(item for item in report if item["subject"] == "Python")
    java = next(item for item in report if item["subject"] == "Java")
    assert python["attended"] == 1
    assert python["total"] == 2
    assert python["subject_percentage"] == 50
    assert java["attended"] == 1
    assert java["total"] == 1
    assert java["overall_percentage"] == pytest.approx(2 / 3 * 100)


def test_new_attendance_date_is_appended_without_shifting_history():
    requests = []
    updates = []

    class Call:
        def __init__(self, result):
            self.result = result

        def execute(self):
            return self.result

    class Spreadsheets:
        def batchUpdate(self, **kwargs):
            requests.extend(kwargs["body"]["requests"])
            return Call({})

    class Service:
        def spreadsheets(self):
            return Spreadsheets()

    sheets = object.__new__(GoogleSheets)
    sheets.spreadsheet_id = "test-sheet"
    sheets.service = Service()
    sheets.subject_title = lambda _subject: "Python"
    sheets._sheet_id = lambda _title: 19
    sheets.values = lambda _range: [
        ["Student ID", "Student Name", "Batch", "2026-10-10"],
        ["student-1", "Sam Yu", "P1", "Present"],
    ]
    sheets.update_cell = lambda address, value: updates.append((address, value))

    sheets.write_attendance("Python", "2026-10-11", "Sam Yu", "P1", "Present", "student-1")

    inserted = next(request["insertDimension"] for request in requests if "insertDimension" in request)
    assert inserted["range"]["startIndex"] == 4
    copied = next(request["copyPaste"] for request in requests if "copyPaste" in request)
    assert copied["source"]["startColumnIndex"] == 3
    assert copied["destination"]["startColumnIndex"] == 4
    assert updates == [("'Python'!E1", "2026-10-11"), ("'Python'!E2", "Present")]


def test_legacy_import_is_one_way_and_preserves_main_admin(tmp_path):
    source = tmp_path / "legacy.sqlite"
    source_db = sqlite3.connect(source)
    source_db.executescript(
        """
        PRAGMA user_version = 7;
        CREATE TABLE admins (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
          password_hash TEXT, role TEXT NOT NULL DEFAULT 'ADMIN',
          is_verified INTEGER NOT NULL DEFAULT 1,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE main_admin_config (
          singleton INTEGER PRIMARY KEY, admin_id TEXT, created_at TEXT
        );
        INSERT INTO admins
          (id, name, email, password_hash, role, is_verified, is_active,
           created_at, updated_at)
        VALUES ('legacy-admin', 'Legacy Admin', 'legacy@example.test',
          'bcrypt-sha256:preserved', 'ADMIN', 1, 1, '2025-01-01', '2025-01-02');
        INSERT INTO main_admin_config VALUES (1, 'legacy-admin', '2025-01-01');
        """
    )
    source_db.commit()
    source_db.close()
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()

    target = engine_for("sqlite:///:memory:")
    initialize_database(target)
    result = import_legacy_sqlite(target, str(source))
    imported = row(target, "SELECT * FROM admins WHERE id = 'legacy-admin'")
    main = row(target, "SELECT admin_id FROM main_admin_config WHERE singleton = 1")

    assert result["admins"] == 1
    assert imported["password_hash"] == "bcrypt-sha256:preserved"
    assert main["admin_id"] == "legacy-admin"
    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
    assert import_legacy_sqlite(target, str(source)) == {"already_imported": 1}


def test_target_database_cannot_be_the_legacy_source(tmp_path):
    source = tmp_path / "legacy.sqlite"
    url = f"sqlite:///{source.as_posix()}"
    with pytest.raises(ValueError, match="separate target"):
        ensure_target_database_is_separate(url, str(source))
