from __future__ import annotations

import base64
import io
import json
import logging
import re
import uuid
from datetime import date, datetime, timedelta
from typing import Any
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import qrcode
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from googleapiclient.errors import HttpError
from sqlalchemy.engine import Engine

from streamlit_app.auth_service import AuthenticationError, _audit, effective_admin
from streamlit_app.database import row, rows
from streamlit_app.email_service import (
    EmailDeliveryError,
    send_attendance_notice,
)
from streamlit_app.google_sheets import GoogleSheets
from streamlit_app.security import (
    device_hash,
    sign_qr_session,
    student_key,
    valid_email,
    valid_student_name,
    verify_qr_session,
)
from streamlit_app.settings import BATCHES, Settings


DURATION_OPTIONS = (5, 10, 20, 30)
NAME_SPACES = re.compile(r"\s+")
PERCENTAGE_HEADERS = (
    "Student Name",
    "Batch",
    "Course",
    "Subject",
    "Attended Classes",
    "Total Classes",
    "Subject Percentage",
    "Full-Course / Overall Percentage",
)
logger = logging.getLogger(__name__)


class AttendanceError(ValueError):
    pass


def today_and_time(timezone_name: str) -> tuple[str, str]:
    now = datetime.now(ZoneInfo(timezone_name))
    return now.strftime("%Y-%m-%d"), now.strftime("%H:%M:%S")


def is_holiday(day: str, configured: frozenset[str]) -> bool:
    try:
        return date.fromisoformat(day).weekday() == 6 or day in configured
    except ValueError:
        return False


def course_for(batch: str) -> str:
    if batch.startswith("P"):
        return "Python Full Stack"
    if batch.startswith("J"):
        return "Java Full Stack"
    if batch.startswith("D"):
        return "Data Science"
    raise AttendanceError("Please select a valid batch.")


def matrix_student_row(
    matrix: list[list[Any]], student: dict[str, str]
) -> int | None:
    for index, values in enumerate(matrix[1:], start=1):
        candidate_id = str(values[0] if len(values) > 0 else "").strip()
        candidate_name = " ".join(str(values[1] if len(values) > 1 else "").split())
        candidate_batch = str(values[2] if len(values) > 2 else "").strip()
        if (
            student.get("id")
            and candidate_id == student["id"]
        ) or (
            candidate_name.casefold() == student["name"].casefold()
            and candidate_batch == student["batch"]
        ):
            return index
    return None


def attendance_cell(
    matrix: list[list[Any]], student: dict[str, str], day: str
) -> str:
    if not matrix:
        return ""
    column = next(
        (
            index
            for index, value in enumerate(matrix[0][3:], start=3)
            if str(value).strip() == day
        ),
        None,
    )
    row_index = matrix_student_row(matrix, student)
    if column is None or row_index is None or len(matrix[row_index]) <= column:
        return ""
    return str(matrix[row_index][column] or "").strip()


def session_student_key(name: str, batch: str) -> str:
    return f"{' '.join(name.split()).casefold()}|{batch.strip()}"


def create_session(
    engine: Engine,
    sheets: GoogleSheets,
    settings: Settings,
    admin: dict,
    subject: str,
    batch: str,
    duration_minutes: int,
) -> dict:
    if subject not in settings.subjects:
        raise AttendanceError("Invalid subject.")
    if admin["effective_role"] != "MAIN_ADMIN" and subject not in admin["subjects"]:
        raise AuthenticationError("You do not have access to this subject.")
    if batch and batch not in BATCHES:
        raise AttendanceError("Invalid batch.")
    if duration_minutes not in DURATION_OPTIONS:
        raise AttendanceError("Choose a QR duration of 5, 10, 20, or 30 minutes.")
    if len(settings.jwt_secret) < 32:
        raise AttendanceError("Set JWT_SECRET to a random value of at least 32 characters before creating QR sessions.")
    base_url = settings.app_url
    if not base_url.startswith(("https://", "http://")):
        raise AttendanceError("Set APP_URL to the public or local Streamlit URL before creating a QR session.")
    session_id = str(uuid.uuid4())
    now = datetime.now(ZoneInfo(settings.timezone))
    now_ms = int(now.timestamp() * 1000)
    expires_at = now_ms + duration_minutes * 60_000
    token = sign_qr_session(session_id, settings.jwt_secret)
    url = f"{base_url}/?{urlencode({'session': token})}"
    qr_image = qrcode.make(url)
    buffer = io.BytesIO()
    qr_image.save(buffer, format="PNG")
    qr_data = base64.b64encode(buffer.getvalue()).decode("ascii")
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                INSERT INTO qr_sessions
                  (id, subject, batch, faculty_name, created_by, created_at,
                   attendance_date, expires_at, duration_minutes, status, qr_url)
                VALUES (:id, :subject, :batch, :faculty, :admin_id, :created_at,
                   :day, :expires, :duration, 'active', :url)
                """
            ),
            {
                "id": session_id,
                "subject": subject,
                "batch": batch or None,
                "faculty": admin["name"],
                "admin_id": admin["id"],
                "created_at": now_ms,
                "day": now.strftime("%Y-%m-%d"),
                "expires": expires_at,
                "duration": duration_minutes,
                "url": url,
            },
        )
    return {
        "id": session_id,
        "subject": subject,
        "batch": batch or None,
        "faculty_name": admin["name"],
        "created_at": now_ms,
        "expires_at": expires_at,
        "duration_minutes": duration_minutes,
        "status": "active",
        "url": url,
        "qr_data": qr_data,
        "token": token,
    }


def session_for_token(
    engine: Engine, settings: Settings, token: str
) -> dict | None:
    session_id = verify_qr_session(token, settings.jwt_secret)
    if not session_id:
        return None
    session = row(engine, "SELECT * FROM qr_sessions WHERE id = :id", {"id": session_id})
    if not session:
        return None
    creator = effective_admin(engine, session["created_by"])
    if (
        not creator
        or (
            creator["effective_role"] != "MAIN_ADMIN"
            and session["subject"] not in creator["subjects"]
        )
    ):
        return None
    return session


def _device_binding(
    engine: Engine,
    student: dict[str, str],
    token_hash: str,
    attendance_date: str,
    session_id: str,
) -> tuple[dict, bool]:
    identity = student_key(student.get("id", ""), student["name"], student["batch"])
    old_identity = __import__("hashlib").sha256(
        f"{student['name'].strip().lower()}|{student['batch'].strip()}".encode("utf-8")
    ).hexdigest()
    now = datetime.now().astimezone().isoformat()
    with engine.begin() as connection:
        device = connection.execute(
            text(
                "SELECT * FROM device_registry WHERE device_hash = :hash "
                "AND status = 'active'"
            ),
            {"hash": token_hash},
        ).mappings().first()
        legacy_device = connection.execute(
            text(
                "SELECT * FROM legacy_student_device_locks WHERE device_hash = :hash"
            ),
            {"hash": token_hash},
        ).mappings().first()
        if device and device["student_key"] != identity:
            raise AttendanceError(
                "This device is registered to another student and cannot be used to mark attendance for this account. Please contact your instructor."
            )
        if legacy_device and legacy_device["student_key"] != old_identity:
            raise AttendanceError(
                "This device is registered to another student and cannot be used to mark attendance for this account. Please contact your instructor."
            )
        owned = connection.execute(
            text(
                "SELECT * FROM device_registry WHERE student_key = :key "
                "AND status = 'active'"
            ),
            {"key": identity},
        ).mappings().first()
        legacy_owned = connection.execute(
            text(
                "SELECT * FROM legacy_student_device_locks WHERE student_key = :key"
            ),
            {"key": old_identity},
        ).mappings().first()
        if (owned and owned["device_hash"] != token_hash) or (
            legacy_owned and legacy_owned["device_hash"] != token_hash
        ):
            raise AttendanceError(
                "This device needs verification before attendance can be marked. Please contact your instructor."
            )
        existing_lock = connection.execute(
            text(
                "SELECT student_key FROM device_attendance_locks "
                "WHERE attendance_date = :day AND session_id = :session "
                "AND device_hash = :hash"
            ),
            {"day": attendance_date, "session": session_id, "hash": token_hash},
        ).mappings().first()
        if existing_lock and existing_lock["student_key"] != identity:
            raise AttendanceError(
                "Attendance Limit Reached. This device has already marked attendance for this subject."
            )
        if existing_lock:
            raise AttendanceError(
                "Attendance Limit Reached. This device has already marked attendance for this subject."
            )
        try:
            connection.execute(
                text(
                    "INSERT INTO device_attendance_locks "
                    "(attendance_date, session_id, device_hash, student_key) "
                    "VALUES (:day, :session, :hash, :student_key)"
                ),
                {
                    "day": attendance_date,
                    "session": session_id,
                    "hash": token_hash,
                    "student_key": identity,
                },
            )
        except IntegrityError as error:
            raise AttendanceError(
                "Attendance Limit Reached. This device has already marked attendance for this subject."
            ) from error

        newly_bound = not device
        if not device:
            device_id = str(uuid.uuid4())
            connection.execute(
                text(
                    """
                    INSERT INTO device_registry
                      (id, device_hash, student_key, student_id, student_name,
                       batch, course, registered_ip, first_registered_at,
                       last_seen_at, status, last_attendance_subject,
                       last_attendance_date)
                    VALUES (:id, :hash, :key, :student_id, :name, :batch,
                       :course, '', :now, :now, 'active', '', '')
                    """
                ),
                {
                    "id": device_id,
                    "hash": token_hash,
                    "key": identity,
                    "student_id": student.get("id", ""),
                    "name": student["name"],
                    "batch": student["batch"],
                    "course": course_for(student["batch"]),
                    "now": now,
                },
            )
            if legacy_owned:
                connection.execute(
                    text("DELETE FROM legacy_student_device_locks WHERE student_key = :key"),
                    {"key": old_identity},
                )
        else:
            device_id = device["id"]
            connection.execute(
                text(
                    "UPDATE device_registry SET student_id = :student_id, "
                    "student_name = :name, batch = :batch, course = :course, "
                    "last_seen_at = :now WHERE id = :id AND status = 'active'"
                ),
                {
                    "student_id": student.get("id", ""),
                    "name": student["name"],
                    "batch": student["batch"],
                    "course": course_for(student["batch"]),
                    "now": now,
                    "id": device_id,
                },
            )
    return {"id": device_id, "student_key": identity}, newly_bound


def _release_uncommitted_binding(
    engine: Engine,
    device_id: str,
    new_binding: bool,
    session_id: str,
    day: str,
    token_hash: str,
) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                "DELETE FROM device_attendance_locks WHERE attendance_date = :day "
                "AND session_id = :session AND device_hash = :hash"
            ),
            {"day": day, "session": session_id, "hash": token_hash},
        )
        if new_binding:
            connection.execute(
                text(
                    "DELETE FROM device_registry WHERE id = :id AND status = 'active'"
                ),
                {"id": device_id},
            )


def _assert_device_not_owned_by_another(
    engine: Engine,
    device_token_hash: str,
    name: str,
    batch: str,
    student: dict[str, str] | None,
) -> None:
    old_identity = __import__("hashlib").sha256(
        f"{name.strip().lower()}|{batch.strip()}".encode("utf-8")
    ).hexdigest()
    device = row(
        engine,
        "SELECT student_name, batch FROM device_registry "
        "WHERE device_hash = :hash AND status = 'active'",
        {"hash": device_token_hash},
    )
    if device and (
        device["student_name"].casefold() != name.casefold()
        or device["batch"] != batch
    ):
        raise AttendanceError(
            "This device is registered to another student and cannot be used to mark attendance for this account. Please contact your instructor."
        )
    if student:
        identity = student_key(student.get("id", ""), name, batch)
        owned = row(
            engine,
            "SELECT device_hash FROM device_registry "
            "WHERE student_key = :key AND status = 'active'",
            {"key": identity},
        )
        if owned and owned["device_hash"] != device_token_hash:
            raise AttendanceError(
                "This device needs verification before attendance can be marked. Please contact your instructor."
            )
    legacy = row(
        engine,
        "SELECT student_key FROM legacy_student_device_locks WHERE device_hash = :hash",
        {"hash": device_token_hash},
    )
    if legacy and legacy["student_key"] != old_identity:
        raise AttendanceError(
            "This device is registered to another student and cannot be used to mark attendance for this account. Please contact your instructor."
        )
    if student:
        legacy_owned = row(
            engine,
            "SELECT device_hash FROM legacy_student_device_locks WHERE student_key = :key",
            {"key": old_identity},
        )
        if legacy_owned and legacy_owned["device_hash"] != device_token_hash:
            raise AttendanceError(
                "This device needs verification before attendance can be marked. Please contact your instructor."
            )


def _reserve_student_submission(
    engine: Engine,
    session_id: str,
    student_key: str,
    now_ms: int,
) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                "DELETE FROM attendance_student_locks "
                "WHERE session_id = :session AND student_key = :student "
                "AND created_at < :stale_before"
            ),
            {
                "session": session_id,
                "student": student_key,
                "stale_before": now_ms - 5 * 60_000,
            },
        )
        try:
            connection.execute(
                text(
                    "INSERT INTO attendance_student_locks "
                    "(session_id, student_key, created_at) "
                    "VALUES (:session, :student, :created)"
                ),
                {"session": session_id, "student": student_key, "created": now_ms},
            )
        except IntegrityError as error:
            raise AttendanceError(
                "Your attendance submission is already being processed. Please wait and try again."
            ) from error


def mark_attendance(
    engine: Engine,
    sheets: GoogleSheets,
    settings: Settings,
    token: str,
    name: str,
    batch: str,
    email: str,
    browser_device_token: str,
) -> dict:
    session = session_for_token(engine, settings, token)
    if not session:
        raise AttendanceError(
            "This QR code is invalid, expired, or no longer authorized. Please scan a valid QR code."
        )
    import time

    now_ms = int(time.time() * 1000)
    if session["status"] != "active" or int(session["expires_at"]) <= now_ms:
        raise AttendanceError("This QR code has expired. Please scan a valid QR code.")
    normalized_name = " ".join(str(name or "").split())
    batch = str(batch or "").strip()
    email = str(email or "").strip().lower()
    if not valid_student_name(normalized_name):
        raise AttendanceError(
            "Name must contain at least 3 alphabetic characters and spaces only."
        )
    if batch not in BATCHES or (session["batch"] and session["batch"] != batch):
        raise AttendanceError("Please select a valid batch.")
    if email and not valid_email(email):
        raise AttendanceError("Enter a valid email address or leave the email field blank.")
    if not re.fullmatch(r"[A-Za-z0-9._:-]{12,128}", browser_device_token or ""):
        raise AttendanceError("Unable to identify this device. Please refresh the page and try again.")
    day, clock = today_and_time(settings.timezone)
    if is_holiday(day, settings.holidays):
        raise AttendanceError("Attendance cannot be marked on Sundays or configured holidays.")
    session_identity = session_student_key(normalized_name, batch)
    matrix = sheets.subject_matrices((session["subject"],))[session["subject"]]
    existing_status = attendance_cell(
        matrix, {"id": "", "name": normalized_name, "batch": batch}, day
    )
    is_recovered_absence = False
    session_mark = row(
        engine,
        "SELECT status FROM qr_session_students "
        "WHERE session_id = :session AND student_key = :key",
        {"session": session["id"], "key": session_identity},
    )
    if session_mark and session_mark["status"] == "Present":
        raise AttendanceError("Your attendance for this subject has already been marked today.")
    if existing_status:
        if (
            existing_status == "Absent"
            and int(session["recovery_count"]) > 0
            and session_mark
            and session_mark["status"] == "Absent"
            and session["attendance_date"] == day
        ):
            is_recovered_absence = True
        else:
            raise AttendanceError("Your attendance for this subject has already been marked today.")

    hashed_device = device_hash(browser_device_token)
    roster = sheets.students()
    existing_student = next(
        (
            student
            for student in roster
            if student["name"].casefold() == normalized_name.casefold()
            and student["batch"] == batch
        ),
        None,
    )
    _assert_device_not_owned_by_another(
        engine, hashed_device, normalized_name, batch, existing_student
    )
    _reserve_student_submission(
        engine, session["id"], session_identity, now_ms
    )
    binding = None
    newly_bound = False
    saved = False
    try:
        student = sheets.ensure_student(
            normalized_name, batch, email, students=roster
        )
        binding, newly_bound = _device_binding(
            engine,
            student,
            hashed_device,
            day,
            session["id"],
        )
        if is_recovered_absence:
            updated = sheets.update_recovered_absence(
                session["subject"],
                session["attendance_date"],
                normalized_name,
                batch,
                student.get("id", ""),
            )
            if not updated:
                raise AttendanceError(
                    "This recovered session no longer has an absence record to replace. Contact your instructor."
                )
        else:
            sheets.write_attendance(
                session["subject"],
                day,
                normalized_name,
                batch,
                "Present",
                student.get("id", ""),
            )
        saved = True
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO qr_session_students
                      (session_id, student_key, student_name, batch, status)
                    VALUES (:session, :key, :name, :batch, 'Present')
                    ON CONFLICT (session_id, student_key) DO UPDATE SET
                      student_name = excluded.student_name,
                      batch = excluded.batch, status = 'Present'
                    """
                ),
                {
                    "session": session["id"],
                    "key": session_identity,
                    "name": normalized_name,
                    "batch": batch,
                },
            )
            connection.execute(
                text(
                    "UPDATE device_registry SET last_attendance_subject = :subject, "
                    "last_attendance_date = :day WHERE id = :id AND status = 'active'"
                ),
                {
                    "subject": session["subject"],
                    "day": day,
                    "id": binding["id"],
                },
            )
            connection.execute(
                text(
                    "DELETE FROM attendance_student_locks "
                    "WHERE session_id = :session AND student_key = :key"
                ),
                {"session": session["id"], "key": session_identity},
            )
        email_status = "not-requested"
        if email:
            try:
                send_attendance_notice(
                    settings,
                    email,
                    normalized_name,
                    session["subject"],
                    day,
                    "Present",
                    session["faculty_name"],
                )
                email_status = "sent"
            except EmailDeliveryError:
                email_status = "failed"
        percentage_sync_status = (
            "updated"
            if sync_percentage_sheet(sheets, settings.subjects)
            else "failed"
        )
        return {
            "name": normalized_name,
            "batch": batch,
            "course": course_for(batch),
            "subject": session["subject"],
            "date": day,
            "time": clock,
            "status": "Present",
            "email_status": email_status,
            "percentage_sync_status": percentage_sync_status,
        }
    except Exception:
        if not saved:
            if binding:
                _release_uncommitted_binding(
                    engine, binding["id"], newly_bound, session["id"], day, hashed_device
                )
            with engine.begin() as connection:
                connection.execute(
                    text(
                        "DELETE FROM attendance_student_locks "
                        "WHERE session_id = :session AND student_key = :key"
                    ),
                    {"session": session["id"], "key": session_identity},
                )
        raise


def close_session(
    engine: Engine, sheets: GoogleSheets, settings: Settings, session_id: str
) -> dict:
    session = row(
        engine, "SELECT * FROM qr_sessions WHERE id = :id", {"id": session_id}
    )
    if not session:
        raise AttendanceError("Attendance session not found.")
    if session["status"] == "closed":
        return json.loads(session["close_result"] or '{"ok":true,"added":0}')
    eligible = [
        student
        for student in sheets.students()
        if not session["batch"] or student["batch"] == session["batch"]
    ]
    matrices = sheets.subject_matrices((session["subject"],))
    matrix = matrices[session["subject"]]
    rows_by_id = {student["id"]: student for student in eligible if student["id"]}
    date_column = next(
        (
            index
            for index, value in enumerate(matrix[0][3:], start=3)
            if str(value).strip() == session["attendance_date"]
        ),
        None,
    ) if matrix else None
    existing_statuses = []
    if date_column is not None:
        existing_statuses = [
            str(values[date_column] or "").strip()
            for values in matrix[1:]
            if len(values) > date_column
        ]
    class_marked = any(status in {"Present", "Absent"} for status in existing_statuses)
    added = 0
    sent = 0
    failed = 0
    skipped = 0
    absent_keys: list[tuple[str, str, str]] = []
    for student in eligible:
        current = attendance_cell(matrix, student, session["attendance_date"])
        if is_holiday(session["attendance_date"], settings.holidays):
            if current:
                continue
            status = "Holiday"
        elif not class_marked or current:
            continue
        else:
            status = "Absent"
        sheets.write_attendance(
            session["subject"],
            session["attendance_date"],
            student["name"],
            student["batch"],
            status,
            student.get("id", ""),
        )
        added += 1
        if status == "Absent":
            key = session_student_key(student["name"], student["batch"])
            absent_keys.append((key, student["name"], student["batch"]))
            if student.get("email"):
                try:
                    send_attendance_notice(
                        settings,
                        student["email"],
                        student["name"],
                        session["subject"],
                        session["attendance_date"],
                        "Absent",
                        session["faculty_name"],
                    )
                    sent += 1
                except EmailDeliveryError:
                    failed += 1
            else:
                skipped += 1
    now_ms = int(datetime.now().timestamp() * 1000)
    close_result = {
        "ok": True,
        "added": added,
        "emailNotifications": {
            "sent": sent,
            "failed": failed,
            "skipped": skipped,
            "status": "failed" if failed else "not-configured" if skipped else "complete",
        },
    }
    close_result["percentageSyncStatus"] = (
        "updated" if sync_percentage_sheet(sheets, settings.subjects) else "failed"
    )
    with engine.begin() as connection:
        for key, student_name, student_batch in absent_keys:
            connection.execute(
                text(
                    """
                    INSERT INTO qr_session_students
                      (session_id, student_key, student_name, batch, status)
                    VALUES (:session, :key, :name, :batch, 'Absent')
                    ON CONFLICT (session_id, student_key) DO UPDATE SET
                      status = 'Absent'
                    """
                ),
                {
                    "session": session_id,
                    "key": key,
                    "name": student_name,
                    "batch": student_batch,
                },
            )
        connection.execute(
            text(
                "UPDATE qr_sessions SET status = 'closed', closed_at = :closed, "
                "close_result = :result WHERE id = :id AND status = 'active'"
            ),
            {
                "closed": now_ms,
                "result": json.dumps(close_result),
                "id": session_id,
            },
        )
    return close_result


def recover_session(
    engine: Engine, actor: dict, session_id: str
) -> dict:
    session = row(
        engine, "SELECT * FROM qr_sessions WHERE id = :id", {"id": session_id}
    )
    if not session:
        raise AttendanceError("Attendance session not found.")
    if actor["effective_role"] != "MAIN_ADMIN" and session["subject"] not in actor["subjects"]:
        raise AuthenticationError("You do not have access to this subject.")
    if session["status"] != "closed" or not session["closed_at"]:
        raise AttendanceError("Only a fully closed attendance session can be recovered.")
    now_ms = int(datetime.now().timestamp() * 1000)
    now_iso = datetime.now().astimezone().isoformat()
    with engine.begin() as connection:
        result = connection.execute(
            text(
                """
                UPDATE qr_sessions
                SET status = 'active', closed_at = NULL, close_result = NULL,
                    expires_at = :expires, recovery_count = recovery_count + 1,
                    last_recovered_at = :recovered
                WHERE id = :id AND status = 'closed' AND closed_at IS NOT NULL
                """
            ),
            {
                "expires": now_ms + int(session["duration_minutes"]) * 60_000,
                "recovered": now_iso,
                "id": session_id,
            },
        )
        if result.rowcount != 1:
            raise AttendanceError("This session is already being recovered or is not closed.")
        _audit(
            connection,
            actor["id"],
            actor["effective_role"],
            "admin_qr_session_recovered",
            session_id,
            f"QR session recovered; subject={session['subject']}; date={session['attendance_date']}.",
            session["created_by"],
        )
    return {
        **session,
        "status": "active",
        "closed_at": None,
        "expires_at": now_ms + int(session["duration_minutes"]) * 60_000,
        "recovery_count": int(session["recovery_count"]) + 1,
        "qr_url": session["qr_url"],
    }


def list_sessions(engine: Engine, admin: dict) -> list[dict]:
    available_subjects = (
        admin["subjects"]
        if admin["effective_role"] != "MAIN_ADMIN"
        else None
    )
    result = rows(
        engine,
        "SELECT * FROM qr_sessions ORDER BY created_at DESC",
    )
    if available_subjects is not None:
        result = [item for item in result if item["subject"] in available_subjects]
    for item in result:
        item["marked_students"] = len(
            rows(
                engine,
                "SELECT student_key FROM qr_session_students "
                "WHERE session_id = :id AND status = 'Present'",
                {"id": item["id"]},
            )
        )
    return result


def attendance_records(
    sheets: GoogleSheets, allowed_subjects: tuple[str, ...]
) -> list[dict]:
    matrices = sheets.subject_matrices(allowed_subjects)
    result = []
    for subject, matrix in matrices.items():
        if not matrix:
            continue
        headers = matrix[0]
        for student in matrix[1:]:
            name = str(student[1] if len(student) > 1 else "").strip()
            batch = str(student[2] if len(student) > 2 else "").strip()
            if not name or not batch:
                continue
            for column in range(3, len(headers)):
                status = str(student[column] if len(student) > column else "").strip()
                day = str(headers[column] or "").strip()
                if status in {"Present", "Absent", "Holiday"} and day:
                    result.append(
                        {
                            "date": day,
                            "name": name,
                            "batch": batch,
                            "course": course_for(batch),
                            "subject": subject,
                            "status": status,
                            "source": "Matrix",
                        }
                    )
    return sorted(result, key=lambda item: (item["date"], item["subject"], item["name"]), reverse=True)


def percentage_records(
    students: list[dict[str, str]],
    records: list[dict],
    subjects: tuple[str, ...],
) -> list[dict]:
    known_students = {
        (student["name"].casefold(), student["batch"]): student
        for student in students
    }
    for item in records:
        key = (item["name"].casefold(), item["batch"])
        known_students.setdefault(
            key,
            {
                "name": item["name"],
                "batch": item["batch"],
                "id": "",
                "email": "",
            },
        )
    counted = [
        item
        for item in records
        if item["status"] in {"Present", "Absent"}
    ]
    class_dates = {
        (item["batch"], item["subject"], item["date"])
        for item in counted
    }
    overall: dict[tuple[str, str], list[int]] = {}
    report = []
    for student in known_students.values():
        key = (student["name"].casefold(), student["batch"])
        overall[key] = [0, 0]
        for subject in subjects:
            scoped = [
                item
                for item in counted
                if item["name"].casefold() == key[0]
                and item["batch"] == key[1]
                and item["subject"] == subject
            ]
            attended = sum(item["status"] == "Present" for item in scoped)
            total = sum(
                (key[1], subject, day) in class_dates
                for day in {class_day[2] for class_day in class_dates if class_day[0] == key[1] and class_day[1] == subject}
            )
            overall[key][0] += attended
            overall[key][1] += total
            report.append(
                {
                    "name": student["name"],
                    "batch": student["batch"],
                    "course": course_for(student["batch"]),
                    "subject": subject,
                    "attended": attended,
                    "total": total,
                    "subject_percentage": attended / total * 100 if total else 0.0,
                    "overall_percentage": 0.0,
                }
            )
    for item in report:
        attended, total = overall[(item["name"].casefold(), item["batch"])]
        item["overall_percentage"] = attended / total * 100 if total else 0.0
    return report


def percentage_sheet_rows(records: list[dict]) -> list[list[str | int]]:
    identities: dict[tuple[str, str, str], dict] = {}
    class_dates: set[tuple[str, str, str]] = set()
    for record in records:
        if (
            not record["name"]
            or not record["batch"]
            or not record["date"]
            or record["status"] not in {"Present", "Absent"}
        ):
            continue
        key = (record["name"].casefold(), record["batch"], record["subject"])
        identity = identities.setdefault(
            key,
            {
                "name": record["name"],
                "batch": record["batch"],
                "course": record.get("course") or course_for(record["batch"]),
                "subject": record["subject"],
                "attended": 0,
            },
        )
        if record["status"] == "Present":
            identity["attended"] += 1
        class_dates.add((record["batch"], record["subject"], record["date"]))

    report = [list(PERCENTAGE_HEADERS)]
    overall: dict[tuple[str, str], list[int]] = {}
    for key, identity in identities.items():
        total = sum(
            batch == identity["batch"] and subject == identity["subject"]
            for batch, subject, _day in class_dates
        )
        student_key = (key[0], key[1])
        totals = overall.setdefault(student_key, [0, 0])
        totals[0] += identity["attended"]
        totals[1] += total
        identity["total"] = total
        report.append(
            [
                identity["name"],
                identity["batch"],
                identity["course"],
                identity["subject"],
                identity["attended"],
                total,
                f"{identity['attended'] / total * 100:.2f}%" if total else "0.00%",
                "",
            ]
        )
    for item in report[1:]:
        totals = overall[(item[0].casefold(), item[1])]
        item[7] = f"{totals[0] / totals[1] * 100:.2f}%" if totals[1] else "0.00%"
    return report


def sync_percentage_sheet(
    sheets: GoogleSheets,
    subjects: tuple[str, ...],
) -> bool:
    try:
        records = attendance_records(sheets, subjects)
        sheets.write_percentage(percentage_sheet_rows(records))
    except (HttpError, OSError, ValueError) as error:
        logger.error("Unable to synchronize the Percentage worksheet: %s", error)
        return False
    return True


def student_attendance_report(
    sheets: GoogleSheets,
    name: str,
    batch: str,
    subjects: tuple[str, ...],
    settings: Settings,
) -> dict:
    student = next(
        (
            item
            for item in sheets.students()
            if item["name"].casefold() == name.casefold()
            and item["batch"] == batch
        ),
        None,
    )
    if not student:
        raise AttendanceError("Student not found. Please check your name and batch.")
    records = [
        record
        for record in attendance_records(sheets, subjects)
        if record["name"].casefold() == student["name"].casefold()
        and record["batch"] == batch
        and record["date"] <= today_and_time(settings.timezone)[0]
        and record["status"] in {"Present", "Absent"}
    ]
    present_days = sum(record["status"] == "Present" for record in records)
    total_days = len(records)
    percentage = present_days / total_days * 100 if total_days else 0.0
    today = today_and_time(settings.timezone)[0]
    today_records = [record for record in records if record["date"] == today]
    today_status = (
        "Present"
        if any(record["status"] == "Present" for record in today_records)
        else "Absent"
        if any(record["status"] == "Absent" for record in today_records)
        else "Not Marked"
    )
    return {
        "student": student,
        "today": {"date": today, "status": today_status},
        "present_days": present_days,
        "total_days": total_days,
        "percentage": percentage,
        "low_attendance": percentage < settings.minimum_attendance_percentage,
    }
