from __future__ import annotations

import secrets
import uuid

from sqlalchemy import text
from sqlalchemy.engine import Engine

from streamlit_app.auth_service import AuthenticationError, _audit, _new_challenge
from streamlit_app.database import row, rows
from streamlit_app.email_service import EmailDeliveryError, send_email
from streamlit_app.security import hash_password, normalize_email, utc_iso, valid_email
from streamlit_app.settings import Settings


def _require_main_admin(admin: dict) -> None:
    if admin["effective_role"] != "MAIN_ADMIN":
        raise AuthenticationError("Main Admin access required.")


def invite_admin(
    engine: Engine,
    settings: Settings,
    actor: dict,
    name: str,
    email: str,
    subjects: list[str],
) -> None:
    _require_main_admin(actor)
    name = " ".join(str(name or "").split())
    email = normalize_email(email)
    selected = list(dict.fromkeys(subjects))
    if len(name) < 2 or not valid_email(email):
        raise AuthenticationError("Enter a valid admin name and email address.")
    if not selected or any(subject not in settings.subjects for subject in selected):
        raise AuthenticationError("Choose at least one valid subject.")
    given_name = "".join(character for character in name.split()[0] if character.isalnum())
    temporary_password = (
        given_name[:8] + f"{secrets.randbelow(1000):03d}"
        if len(given_name) >= 5
        else (given_name + secrets.token_urlsafe(4))[:8] + f"{secrets.randbelow(1000):03d}"
    )
    admin_id = str(uuid.uuid4())
    now = utc_iso()
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                INSERT INTO admins
                  (id, name, email, password_hash, role, is_verified, is_active,
                   approval_status, must_change_password, created_at, updated_at)
                VALUES (:id, :name, :email, :hash, 'ADMIN', 0, 1,
                   'approved', 1, :now, :now)
                """
            ),
            {
                "id": admin_id,
                "name": name,
                "email": email,
                "hash": hash_password(temporary_password),
                "now": now,
            },
        )
        for subject in selected:
            connection.execute(
                text(
                    "INSERT INTO admin_subject_assignments "
                    "(admin_id, subject, assigned_at, assigned_by) "
                    "VALUES (:id, :subject, :now, :actor)"
                ),
                {
                    "id": admin_id,
                    "subject": subject,
                    "now": now,
                    "actor": actor["id"],
                },
            )
        _audit(
            connection,
            actor["id"],
            "MAIN_ADMIN",
            "admin_invite",
            email,
            "Main Admin invited a regular admin.",
            admin_id,
        )
    try:
        admin = {"id": admin_id, "name": name, "email": email}
        _new_challenge(
            engine,
            settings,
            admin,
            "invite",
            temporary_password=temporary_password,
            force=True,
        )
    except Exception:
        with engine.begin() as connection:
            connection.execute(
                text("DELETE FROM admins WHERE id = :id AND is_verified = 0"),
                {"id": admin_id},
            )
        raise


def change_admin_status(
    engine: Engine,
    settings: Settings,
    actor: dict,
    target_id: str,
    active: bool,
    reason: str,
) -> bool:
    _require_main_admin(actor)
    if not 5 <= len(reason.strip()) <= 500:
        raise AuthenticationError("Enter a reason between 5 and 500 characters.")
    target = row(
        engine,
        "SELECT * FROM admins WHERE id = :id AND removed_at IS NULL",
        {"id": target_id},
    )
    main = row(engine, "SELECT admin_id FROM main_admin_config WHERE singleton = 1")
    if not target or target_id == actor["id"] or (
        main and target_id == main["admin_id"]
    ):
        raise AuthenticationError("The Main Admin cannot be deactivated or removed here.")
    if active and (
        not target["is_verified"] or target["approval_status"] != "approved"
    ):
        raise AuthenticationError("Only verified, approved admin accounts can be activated.")
    now = utc_iso()
    with engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE admins SET is_active = :active, last_status_change_at = :now, "
                "updated_at = :now WHERE id = :id"
            ),
            {"active": int(active), "now": now, "id": target_id},
        )
        if not active:
            connection.execute(
                text("DELETE FROM auth_sessions WHERE admin_id = :id"),
                {"id": target_id},
            )
        _audit(
            connection,
            actor["id"],
            "MAIN_ADMIN",
            "admin_activated" if active else "admin_deactivated",
            target["email"],
            reason.strip(),
            target_id,
        )
    try:
        send_email(
            settings,
            target["email"],
            f"Attendance Management System - Account {'Activated' if active else 'Deactivated'}",
            f"Hello {target['name']},\n\nYour administrator account has been "
            f"{'activated' if active else 'deactivated'} by the Main Admin.",
        )
    except EmailDeliveryError:
        return False
    return True


def update_admin_details(
    engine: Engine,
    actor: dict,
    target_id: str,
    name: str,
    email: str,
    phone: str,
    reason: str,
) -> None:
    _require_main_admin(actor)
    name = " ".join(str(name or "").split())
    email = normalize_email(email)
    phone_digits = "".join(character for character in str(phone or "") if character.isdigit())
    if len(name) < 2 or not valid_email(email) or (
        phone_digits and not 7 <= len(phone_digits) <= 15
    ):
        raise AuthenticationError("Enter valid admin name, email and phone details.")
    if not 5 <= len(reason.strip()) <= 500:
        raise AuthenticationError("Enter a reason between 5 and 500 characters.")
    target = row(
        engine,
        "SELECT * FROM admins WHERE id = :id AND removed_at IS NULL",
        {"id": target_id},
    )
    main = row(engine, "SELECT admin_id FROM main_admin_config WHERE singleton = 1")
    if not target or target_id == actor["id"] or (
        main and target_id == main["admin_id"]
    ):
        raise AuthenticationError("The Main Admin cannot be edited here.")
    now = utc_iso()
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE admins SET name = :name, email = :email, phone = :phone, "
                    "updated_at = :now WHERE id = :id"
                ),
                {
                    "name": name,
                    "email": email,
                    "phone": phone_digits or None,
                    "now": now,
                    "id": target_id,
                },
            )
            _audit(
                connection,
                actor["id"],
                "MAIN_ADMIN",
                "admin_details_updated",
                email,
                reason.strip(),
                target_id,
            )
    except Exception as error:
        if "unique" in str(error).lower() or "duplicate" in str(error).lower():
            raise AuthenticationError("Another admin already uses this email or phone.") from error
        raise


def recover_admin(
    engine: Engine, actor: dict, target_id: str, reason: str
) -> None:
    _require_main_admin(actor)
    if not 5 <= len(reason.strip()) <= 500:
        raise AuthenticationError("Enter a reason between 5 and 500 characters.")
    target = row(
        engine,
        "SELECT * FROM admins WHERE id = :id AND removed_at IS NULL",
        {"id": target_id},
    )
    main = row(engine, "SELECT admin_id FROM main_admin_config WHERE singleton = 1")
    if (
        not target
        or target_id == actor["id"]
        or (main and target_id == main["admin_id"])
        or not target["is_verified"]
        or target["approval_status"] != "approved"
    ):
        raise AuthenticationError("This administrator account cannot be recovered.")
    now = utc_iso()
    with engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE admins SET is_active = 1, failed_login_attempts = 0, "
                "account_lock_until = NULL, last_status_change_at = :now, "
                "updated_at = :now WHERE id = :id"
            ),
            {"now": now, "id": target_id},
        )
        _audit(
            connection,
            actor["id"],
            "MAIN_ADMIN",
            "admin_recovered",
            target["email"],
            reason.strip(),
            target_id,
        )


def remove_admin(
    engine: Engine, actor: dict, target_id: str, reason: str
) -> None:
    _require_main_admin(actor)
    if not 5 <= len(reason.strip()) <= 500:
        raise AuthenticationError("Enter a reason between 5 and 500 characters.")
    target = row(
        engine,
        "SELECT * FROM admins WHERE id = :id AND removed_at IS NULL",
        {"id": target_id},
    )
    main = row(engine, "SELECT admin_id FROM main_admin_config WHERE singleton = 1")
    if not target or target_id == actor["id"] or (
        main and target_id == main["admin_id"]
    ):
        raise AuthenticationError("The Main Admin cannot be removed.")
    now = utc_iso()
    anonymized_email = f"removed+{target_id}@removed.invalid"
    with engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE admins SET name = 'Removed admin', email = :email, "
                "phone = NULL, password_hash = NULL, is_verified = 0, "
                "is_active = 0, approval_status = 'rejected', "
                "must_change_password = 0, last_login = NULL, "
                "last_successful_login = NULL, last_password_change_at = NULL, "
                "failed_login_attempts = 0, account_lock_until = NULL, "
                "removed_at = :now, updated_at = :now WHERE id = :id"
            ),
            {"email": anonymized_email, "now": now, "id": target_id},
        )
        connection.execute(
            text("DELETE FROM auth_sessions WHERE admin_id = :id"),
            {"id": target_id},
        )
        connection.execute(
            text("DELETE FROM otp_verifications WHERE admin_id = :id"),
            {"id": target_id},
        )
        connection.execute(
            text("DELETE FROM admin_subject_assignments WHERE admin_id = :id"),
            {"id": target_id},
        )
        connection.execute(
            text(
                "UPDATE admin_access_requests SET name = 'Removed admin', "
                "email = :email, rejection_reason = NULL WHERE invite_admin_id = :id"
            ),
            {"email": anonymized_email, "id": target_id},
        )
        _audit(
            connection,
            actor["id"],
            "MAIN_ADMIN",
            "admin_removed",
            target_id,
            reason.strip(),
            target_id,
        )


def list_devices(engine: Engine) -> list[dict]:
    return rows(
        engine,
        """
        SELECT id, student_name, batch, course, registered_ip, first_registered_at,
          last_seen_at, status, last_attendance_subject, last_attendance_date,
          admin_unlock_timestamp, unlock_reason
        FROM device_registry
        UNION ALL
        SELECT 'legacy-' || device_hash AS id,
          'Legacy device lock (student must check in to migrate)' AS student_name,
          '' AS batch, '' AS course, '' AS registered_ip, created_at AS first_registered_at,
          created_at AS last_seen_at, 'active' AS status, '' AS last_attendance_subject,
          '' AS last_attendance_date, NULL AS admin_unlock_timestamp, '' AS unlock_reason
        FROM legacy_student_device_locks
        ORDER BY status, last_seen_at DESC
        """,
    )


def unlock_device(
    engine: Engine, actor: dict, device_id: str, reason: str
) -> None:
    if not 5 <= len(reason.strip()) <= 500:
        raise AuthenticationError("Enter a reason between 5 and 500 characters.")
    now = utc_iso()
    with engine.begin() as connection:
        if device_id.startswith("legacy-"):
            device_hash_value = device_id[len("legacy-") :]
            result = connection.execute(
                text(
                    "DELETE FROM legacy_student_device_locks "
                    "WHERE device_hash = :hash"
                ),
                {"hash": device_hash_value},
            )
        else:
            result = connection.execute(
                text(
                    "UPDATE device_registry SET status = 'unlocked', "
                    "registered_ip = '', admin_unlock_timestamp = :now, "
                    "unlock_reason = :reason WHERE id = :id AND status = 'active'"
                ),
                {"now": now, "reason": reason.strip(), "id": device_id},
            )
        if result.rowcount != 1:
            raise AuthenticationError("The active device registration was not found.")
        _audit(
            connection,
            actor["id"],
            actor["effective_role"],
            "legacy_device_unlock" if device_id.startswith("legacy-") else "device_unlock",
            device_id,
            reason.strip(),
        )


def admin_audit(engine: Engine, account_only: bool = False) -> list[dict]:
    filter_sql = (
        "AND (substr(action, 1, 6) = 'admin_' OR "
        "substr(action, 1, 11) = 'main_admin_')"
        if account_only
        else ""
    )
    return rows(
        engine,
        f"""
        SELECT log.id, log.timestamp, log.admin_id,
          CASE WHEN admins.name = 'Removed admin' THEN 'Removed admin' ELSE admins.email END AS admin_email,
          log.acting_admin_role, log.target_admin_id, log.action,
          log.affected_record, log.reason, log.result
        FROM admin_audit_log AS log
        JOIN admins ON admins.id = log.admin_id
        WHERE 1 = 1 {filter_sql}
        ORDER BY log.timestamp DESC LIMIT 500
        """,
    )
