from __future__ import annotations

import hmac
import secrets
import uuid
from typing import Iterable

from sqlalchemy import text
from sqlalchemy.engine import Engine

from streamlit_app.database import row, rows
from streamlit_app.email_service import send_otp
from streamlit_app.security import (
    hash_otp,
    hash_password,
    new_otp,
    normalize_email,
    utc_iso,
    valid_email,
    valid_password,
    verify_otp,
    verify_password,
)
from streamlit_app.settings import Settings


OTP_LIFETIME_MS = 10 * 60 * 1000
OTP_RESEND_MS = 60 * 1000
SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000


class AuthenticationError(ValueError):
    pass


def effective_admin(engine: Engine, admin_id: str) -> dict | None:
    admin = row(
        engine,
        """
        SELECT admins.*, main_admin_config.admin_id AS main_admin_id
        FROM admins CROSS JOIN main_admin_config
        WHERE admins.id = :id AND main_admin_config.singleton = 1
        """,
        {"id": admin_id},
    )
    if (
        not admin
        or admin["removed_at"]
        or not admin["is_active"]
        or not admin["is_verified"]
        or admin["approval_status"] != "approved"
    ):
        return None
    admin["effective_role"] = (
        "MAIN_ADMIN" if admin["main_admin_id"] == admin["id"] else "ADMIN"
    )
    admin["subjects"] = (
        list(
            dict.fromkeys(
                item["subject"]
                for item in rows(
                    engine,
                    "SELECT subject FROM admin_subject_assignments "
                    "WHERE admin_id = :id ORDER BY subject",
                    {"id": admin_id},
                )
            )
        )
        if admin["effective_role"] != "MAIN_ADMIN"
        else []
    )
    return admin


def _audit(
    connection,
    actor_id: str,
    actor_role: str,
    action: str,
    affected_record: str,
    reason: str,
    target_id: str | None = None,
    result: str = "success",
) -> None:
    connection.execute(
        text(
            "INSERT INTO admin_audit_log "
            "(id, timestamp, admin_id, acting_admin_role, target_admin_id, "
            "action, affected_record, reason, result) "
            "VALUES (:id, :timestamp, :admin_id, :role, :target, :action, "
            ":record, :reason, :result)"
        ),
        {
            "id": str(uuid.uuid4()),
            "timestamp": utc_iso(),
            "admin_id": actor_id,
            "role": actor_role,
            "target": target_id,
            "action": action,
            "record": affected_record,
            "reason": reason,
            "result": result,
        },
    )


def _new_challenge(
    engine: Engine,
    settings: Settings,
    admin: dict,
    purpose: str,
    temporary_password: str = "",
    force: bool = False,
) -> None:
    existing = row(
        engine,
        "SELECT last_sent_at FROM otp_verifications WHERE admin_id = :id",
        {"id": admin["id"]},
    )
    now_ms = int(__import__("time").time() * 1000)
    if existing and not force and now_ms - int(existing["last_sent_at"]) < OTP_RESEND_MS:
        raise AuthenticationError("Please wait one minute before requesting another code.")
    code = new_otp()
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                INSERT INTO otp_verifications
                  (id, admin_id, purpose, otp_hash, expires_at, attempts,
                   last_sent_at, created_at, verified)
                VALUES
                  (:id, :admin_id, :purpose, :otp_hash, :expires_at, 0,
                   :last_sent_at, :created_at, 0)
                ON CONFLICT (admin_id) DO UPDATE SET
                  id = excluded.id, purpose = excluded.purpose,
                  otp_hash = excluded.otp_hash, expires_at = excluded.expires_at,
                  attempts = 0, last_sent_at = excluded.last_sent_at,
                  created_at = excluded.created_at, verified = 0
                """
            ),
            {
                "id": str(uuid.uuid4()),
                "admin_id": admin["id"],
                "purpose": purpose,
                "otp_hash": hash_otp(code),
                "expires_at": now_ms + OTP_LIFETIME_MS,
                "last_sent_at": now_ms,
                "created_at": utc_iso(),
            },
        )
    send_otp(
        settings,
        admin["email"],
        admin["name"],
        code,
        purpose,
        temporary_password,
    )


def sign_up(
    engine: Engine,
    settings: Settings,
    name: str,
    email: str,
    phone: str,
    password: str,
    confirm_password: str,
) -> None:
    normalized_email = normalize_email(email)
    normalized_phone = "".join(character for character in phone if character.isdigit())
    if len(" ".join(name.split())) < 2 or not valid_email(normalized_email):
        raise AuthenticationError("Enter a valid full name and email address.")
    if len(normalized_phone) < 7 or len(normalized_phone) > 15:
        raise AuthenticationError("Enter a valid phone number.")
    if not valid_password(password) or password != confirm_password:
        raise AuthenticationError("Enter matching passwords of at least 8 characters.")
    admin = {
        "id": str(uuid.uuid4()),
        "name": " ".join(name.split()),
        "email": normalized_email,
    }
    now = utc_iso()
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO admins
                      (id, name, email, phone, password_hash, role, is_verified,
                       is_active, approval_status, created_at, updated_at)
                    VALUES (:id, :name, :email, :phone, :password_hash, 'ADMIN',
                      0, 0, 'pending', :now, :now)
                    """
                ),
                {
                    **admin,
                    "phone": normalized_phone,
                    "password_hash": hash_password(password),
                    "now": now,
                },
            )
    except Exception as error:
        if "unique" in str(error).lower() or "duplicate" in str(error).lower():
            raise AuthenticationError(
                "An account with this email or phone number already exists."
            ) from error
        raise
    try:
        _new_challenge(engine, settings, admin, "verify")
    except Exception:
        with engine.begin() as connection:
            connection.execute(
                text("DELETE FROM admins WHERE id = :id AND is_verified = 0"),
                {"id": admin["id"]},
            )
        raise


def _challenge(engine: Engine, admin_id: str, purpose: str) -> dict | None:
    return row(
        engine,
        "SELECT * FROM otp_verifications "
        "WHERE admin_id = :admin_id AND purpose = :purpose",
        {"admin_id": admin_id, "purpose": purpose},
    )


def verify_registration(engine: Engine, settings: Settings, email: str, code: str) -> None:
    admin = row(
        engine,
        "SELECT * FROM admins WHERE lower(email) = :email AND removed_at IS NULL",
        {"email": normalize_email(email)},
    )
    challenge = _challenge(engine, admin["id"], "verify") if admin else None
    _verify_challenge(engine, admin, challenge, "verify", code)
    with engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE admins SET is_verified = 1, is_active = "
                "CASE WHEN approval_status = 'approved' THEN 1 ELSE 0 END, "
                "updated_at = :now WHERE id = :id"
            ),
            {"now": utc_iso(), "id": admin["id"]},
        )
        connection.execute(
            text("DELETE FROM otp_verifications WHERE admin_id = :id"),
            {"id": admin["id"]},
        )
    if admin["approval_status"] == "pending":
        raise AuthenticationError(
            "Email verified. Your account is waiting for Main Admin approval."
        )


def _verify_challenge(
    engine: Engine,
    admin: dict | None,
    challenge: dict | None,
    purpose: str,
    code: str,
) -> None:
    import time

    if not admin or not challenge:
        raise AuthenticationError("The verification code is invalid or expired. Request a new one.")
    error_message = None
    now_ms = int(time.time() * 1000)
    query = (
        "SELECT * FROM otp_verifications "
        "WHERE id = :id AND admin_id = :admin_id"
    )
    if engine.dialect.name == "postgresql":
        query += " FOR UPDATE"
    with engine.begin() as connection:
        current = connection.execute(
            text(query),
            {"id": challenge["id"], "admin_id": admin["id"]},
        ).mappings().first()
        if (
            not current
            or int(current["expires_at"]) <= now_ms
            or int(current["attempts"]) >= 5
        ):
            if current and int(current["attempts"]) >= 5:
                connection.execute(
                    text("DELETE FROM otp_verifications WHERE id = :id"),
                    {"id": current["id"]},
                )
            error_message = "The verification code is invalid or expired. Request a new one."
        elif current["purpose"] != purpose:
            error_message = "The verification code is not valid for this action."
        elif not code.isdigit() or len(code) != 6:
            error_message = "The verification code is invalid or expired. Request a new one."
        elif not verify_otp(code, current["otp_hash"]):
            connection.execute(
                text(
                    "UPDATE otp_verifications SET attempts = attempts + 1 "
                    "WHERE id = :id AND attempts < 5"
                ),
                {"id": current["id"]},
            )
            updated = connection.execute(
                text("SELECT attempts FROM otp_verifications WHERE id = :id"),
                {"id": current["id"]},
            ).mappings().first()
            if updated and int(updated["attempts"]) >= 5:
                connection.execute(
                    text("DELETE FROM otp_verifications WHERE id = :id"),
                    {"id": current["id"]},
                )
            error_message = "The one-time code is incorrect."
        else:
            consumed = connection.execute(
                text(
                    "DELETE FROM otp_verifications WHERE id = :id "
                    "AND admin_id = :admin_id AND purpose = :purpose "
                    "AND expires_at > :now AND attempts < 5"
                ),
                {
                    "id": current["id"],
                    "admin_id": admin["id"],
                    "purpose": purpose,
                    "now": now_ms,
                },
            )
            if consumed.rowcount != 1:
                error_message = "The verification code is invalid or expired. Request a new one."
    if error_message:
        raise AuthenticationError(error_message)


def request_otp(
    engine: Engine,
    settings: Settings,
    email: str,
    purpose: str,
) -> None:
    if purpose not in {"verify", "invite", "reset"} or not valid_email(email):
        raise AuthenticationError("Enter a valid email address.")
    admin = row(
        engine,
        "SELECT id, name, email, is_verified, is_active, approval_status, "
        "must_change_password FROM admins WHERE lower(email) = :email "
        "AND removed_at IS NULL",
        {"email": normalize_email(email)},
    )
    if not admin:
        return
    allowed = (
        (purpose == "verify" and not admin["is_verified"])
        or (purpose == "invite" and not admin["is_verified"] and admin["must_change_password"])
        or (purpose == "reset" and admin["is_verified"] and admin["is_active"])
    )
    if not allowed:
        return
    _new_challenge(engine, settings, admin, purpose)


def login(
    engine: Engine, email: str, password: str, otp_code: str = ""
) -> tuple[str | None, str]:
    import time

    normalized_email = normalize_email(email)
    admin = row(
        engine,
        "SELECT * FROM admins WHERE lower(email) = :email AND removed_at IS NULL",
        {"email": normalized_email},
    )
    if not admin:
        raise AuthenticationError("Invalid email or password, or account is not verified or active.")
    if admin["account_lock_until"] and int(admin["account_lock_until"]) > int(time.time() * 1000):
        raise AuthenticationError(
            "This admin account is temporarily locked after repeated failed sign-in attempts."
        )
    if not verify_password(password, admin["password_hash"]):
        attempts = int(admin["failed_login_attempts"]) + 1
        lock_until = int(time.time() * 1000) + 15 * 60 * 1000 if attempts >= 8 else None
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE admins SET failed_login_attempts = :attempts, "
                    "account_lock_until = :lock_until WHERE id = :id"
                ),
                {
                    "attempts": 0 if lock_until else attempts,
                    "lock_until": lock_until,
                    "id": admin["id"],
                },
            )
        raise AuthenticationError("Invalid email or password, or account is not verified or active.")
    if admin["approval_status"] == "pending":
        raise AuthenticationError("Your account is waiting for Main Admin approval before signing in.")
    if admin["approval_status"] != "approved":
        raise AuthenticationError("Invalid email or password, or account is not verified or active.")
    if admin["must_change_password"] or not admin["is_verified"]:
        purpose = "invite" if admin["must_change_password"] else "verify"
        challenge = _challenge(engine, admin["id"], purpose)
        if not otp_code:
            raise AuthenticationError("OTP_REQUIRED")
        _verify_challenge(engine, admin, challenge, purpose, otp_code)
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE admins SET is_verified = 1, is_active = 1, "
                    "updated_at = :now WHERE id = :id"
                ),
                {"now": utc_iso(), "id": admin["id"]},
            )
            connection.execute(
                text("DELETE FROM otp_verifications WHERE admin_id = :id"),
                {"id": admin["id"]},
            )
            _audit(
                connection,
                admin["id"],
                "ADMIN",
                "admin_invite_login" if purpose == "invite" else "admin_email_verified_login",
                admin["email"],
                "First sign-in verified with a one-time email code.",
                admin["id"],
            )
    elif not admin["is_active"]:
        raise AuthenticationError("This admin account is inactive. Contact the Main Admin for assistance.")

    token = secrets.token_urlsafe(32)
    token_hash = __import__("hashlib").sha256(token.encode("utf-8")).hexdigest()
    now = utc_iso()
    with engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE admins SET last_login = :now, last_successful_login = :now, "
                "failed_login_attempts = 0, account_lock_until = NULL WHERE id = :id"
            ),
            {"now": now, "id": admin["id"]},
        )
        connection.execute(
            text(
                "INSERT INTO auth_sessions (token_hash, admin_id, expires_at, created_at) "
                "VALUES (:hash, :id, :expiry, :now)"
            ),
            {
                "hash": token_hash,
                "id": admin["id"],
                "expiry": int(time.time() * 1000) + SESSION_LIFETIME_MS,
                "now": now,
            },
        )
        effective_role = row(
            engine,
            "SELECT admin_id FROM main_admin_config WHERE singleton = 1",
        )
        _audit(
            connection,
            admin["id"],
            "MAIN_ADMIN"
            if effective_role and effective_role["admin_id"] == admin["id"]
            else "ADMIN",
            "admin_login",
            admin["email"],
            "Successful administrator login.",
            admin["id"],
        )
    return token, "password-change" if admin["must_change_password"] else "dashboard"


def current_admin(engine: Engine, token: str) -> dict | None:
    import hashlib
    import time

    if not token:
        return None
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    login_session = row(
        engine,
        "SELECT admin_id FROM auth_sessions "
        "WHERE token_hash = :hash AND expires_at > :now",
        {"hash": token_hash, "now": int(time.time() * 1000)},
    )
    return effective_admin(engine, login_session["admin_id"]) if login_session else None


def logout(engine: Engine, token: str) -> None:
    import hashlib

    if token:
        with engine.begin() as connection:
            connection.execute(
                text("DELETE FROM auth_sessions WHERE token_hash = :hash"),
                {"hash": hashlib.sha256(token.encode("utf-8")).hexdigest()},
            )


def change_temporary_password(
    engine: Engine,
    admin: dict,
    password: str,
    confirm_password: str,
) -> None:
    if not admin["must_change_password"]:
        raise AuthenticationError("A temporary password change is not pending.")
    if not valid_password(password) or password != confirm_password:
        raise AuthenticationError("Enter matching passwords of at least 8 characters.")
    if verify_password(password, admin["password_hash"]):
        raise AuthenticationError("Choose a new password different from the temporary password.")
    with engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE admins SET password_hash = :hash, must_change_password = 0, "
                "last_password_change_at = :now, updated_at = :now WHERE id = :id"
            ),
            {"hash": hash_password(password), "now": utc_iso(), "id": admin["id"]},
        )
        _audit(
            connection,
            admin["id"],
            admin["effective_role"],
            "admin_password_change",
            admin["email"],
            "Temporary password changed after first sign-in.",
            admin["id"],
        )


def reset_password(
    engine: Engine,
    email: str,
    otp_code: str,
    password: str,
    confirm_password: str,
) -> None:
    if not valid_password(password) or password != confirm_password:
        raise AuthenticationError("Enter matching passwords of at least 8 characters.")
    admin = row(
        engine,
        "SELECT * FROM admins WHERE lower(email) = :email AND removed_at IS NULL",
        {"email": normalize_email(email)},
    )
    challenge = _challenge(engine, admin["id"], "reset") if admin else None
    _verify_challenge(engine, admin, challenge, "reset", otp_code)
    with engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE admins SET password_hash = :hash, updated_at = :now, "
                "last_password_change_at = :now, must_change_password = 0, "
                "failed_login_attempts = 0, account_lock_until = NULL "
                "WHERE id = :id"
            ),
            {
                "hash": hash_password(password),
                "now": utc_iso(),
                "id": admin["id"],
            },
        )
        connection.execute(
            text("DELETE FROM auth_sessions WHERE admin_id = :id"),
            {"id": admin["id"]},
        )
        connection.execute(
            text("DELETE FROM otp_verifications WHERE admin_id = :id"),
            {"id": admin["id"]},
        )
        _audit(
            connection,
            admin["id"],
            "ADMIN",
            "admin_password_reset",
            admin["email"],
            "Password reset completed with verified email code.",
            admin["id"],
        )


def bootstrap_main_admin(
    engine: Engine,
    settings: Settings,
    name: str,
    email: str,
    phone: str,
    password: str,
    confirm_password: str,
    bootstrap_secret: str,
) -> str:
    if not settings.bootstrap_secret or not hmac.compare_digest(
        settings.bootstrap_secret, bootstrap_secret
    ):
        raise AuthenticationError("The Main Admin bootstrap secret is invalid or not configured.")
    if not valid_email(email):
        raise AuthenticationError("Enter a valid email address.")
    main = row(engine, "SELECT admin_id FROM main_admin_config WHERE singleton = 1")
    if main and main["admin_id"]:
        raise AuthenticationError("Main Admin setup has already been completed.")
    existing = row(
        engine,
        "SELECT * FROM admins WHERE lower(email) = :email AND removed_at IS NULL",
        {"email": normalize_email(email)},
    )
    if existing:
        if (
            not existing["is_verified"]
            or not existing["is_active"]
            or existing["approval_status"] != "approved"
            or not verify_password(password, existing["password_hash"])
        ):
            raise AuthenticationError(
                "Use an existing verified, active, approved admin account and its password to claim Main Admin access."
            )
        admin = existing
    else:
        if len(" ".join(name.split())) < 2:
            raise AuthenticationError("Enter a valid full name.")
        if not valid_password(password) or password != confirm_password:
            raise AuthenticationError("Enter matching passwords of at least 8 characters.")
        phone_digits = "".join(character for character in phone if character.isdigit())
        if len(phone_digits) < 7 or len(phone_digits) > 15:
            raise AuthenticationError("Enter a valid phone number.")
        admin = {
            "id": str(uuid.uuid4()),
            "name": " ".join(name.split()),
            "email": normalize_email(email),
        }
        now = utc_iso()
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    INSERT INTO admins
                      (id, name, email, phone, password_hash, role, is_verified,
                       is_active, approval_status, created_at, updated_at)
                    VALUES (:id, :name, :email, :phone, :hash, 'ADMIN',
                      0, 0, 'approved', :now, :now)
                    """
                ),
                {
                    **admin,
                    "phone": phone_digits,
                    "hash": hash_password(password),
                    "now": now,
                },
            )
            connection.execute(
                text(
                    "UPDATE main_admin_config SET admin_id = :id, created_at = :now "
                    "WHERE singleton = 1 AND admin_id IS NULL"
                ),
                {"id": admin["id"], "now": now},
            )
            for subject in settings.subjects:
                connection.execute(
                    text(
                        "INSERT INTO admin_subject_assignments "
                        "(admin_id, subject, assigned_at) VALUES (:id, :subject, :now)"
                    ),
                    {"id": admin["id"], "subject": subject, "now": now},
                )
            _audit(
                connection,
                admin["id"],
                "MAIN_ADMIN",
                "main_admin_bootstrap",
                admin["email"],
                "Main Admin account created with the one-time bootstrap secret.",
                admin["id"],
            )
        try:
            _new_challenge(engine, settings, admin, "verify")
        except Exception:
            with engine.begin() as connection:
                connection.execute(
                    text("UPDATE main_admin_config SET admin_id = NULL, created_at = NULL WHERE admin_id = :id"),
                    {"id": admin["id"]},
                )
                connection.execute(text("DELETE FROM admins WHERE id = :id"), {"id": admin["id"]})
            raise
        return "created"
    now = utc_iso()
    with engine.begin() as connection:
        result = connection.execute(
            text(
                "UPDATE main_admin_config SET admin_id = :id, created_at = :now "
                "WHERE singleton = 1 AND admin_id IS NULL"
            ),
            {"id": admin["id"], "now": now},
        )
        if result.rowcount != 1:
            raise AuthenticationError("Main Admin setup has already been completed.")
        _audit(
            connection,
            admin["id"],
            "MAIN_ADMIN",
            "main_admin_bootstrap",
            admin["email"],
            "Main Admin claimed using the one-time bootstrap secret.",
            admin["id"],
        )
    return "claimed"


def approve_admin(
    engine: Engine,
    settings: Settings,
    actor: dict,
    target_id: str,
    approve: bool,
    reason: str,
) -> None:
    if actor["effective_role"] != "MAIN_ADMIN":
        raise AuthenticationError("Main Admin access required.")
    if not 5 <= len(reason.strip()) <= 500:
        raise AuthenticationError("Enter a reason between 5 and 500 characters.")
    target = row(
        engine,
        "SELECT * FROM admins WHERE id = :id AND removed_at IS NULL",
        {"id": target_id},
    )
    if not target or target["approval_status"] not in {"pending", "approved"}:
        raise AuthenticationError("This pending regular admin was not found.")
    decision = "approved" if approve else "rejected"
    now = utc_iso()
    with engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE admins SET approval_status = :status, "
                "is_active = :active, approval_reviewed_at = :now, "
                "approval_reviewed_by = :actor, last_status_change_at = :now, "
                "updated_at = :now WHERE id = :id"
            ),
            {
                "status": decision,
                "active": int(approve and bool(target["is_verified"])),
                "now": now,
                "actor": actor["id"],
                "id": target_id,
            },
        )
        connection.execute(
            text("DELETE FROM admin_subject_assignments WHERE admin_id = :id"),
            {"id": target_id},
        )
        if approve:
            for subject in settings.subjects:
                connection.execute(
                    text(
                        "INSERT INTO admin_subject_assignments "
                        "(admin_id, subject, assigned_at, assigned_by) "
                        "VALUES (:id, :subject, :now, :actor)"
                    ),
                    {
                        "id": target_id,
                        "subject": subject,
                        "now": now,
                        "actor": actor["id"],
                    },
                )
        else:
            connection.execute(
                text("DELETE FROM auth_sessions WHERE admin_id = :id"),
                {"id": target_id},
            )
        _audit(
            connection,
            actor["id"],
            "MAIN_ADMIN",
            "admin_approve" if approve else "admin_reject",
            target["email"],
            reason.strip(),
            target_id,
        )


def change_subjects(
    engine: Engine,
    settings: Settings,
    actor: dict,
    target_id: str,
    subjects: Iterable[str],
    reason: str,
) -> None:
    if actor["effective_role"] != "MAIN_ADMIN":
        raise AuthenticationError("Main Admin access required.")
    selected = list(dict.fromkeys(subjects))
    if any(subject not in settings.subjects for subject in selected):
        raise AuthenticationError("Choose valid subjects.")
    if not 5 <= len(reason.strip()) <= 500:
        raise AuthenticationError("Enter a reason between 5 and 500 characters.")
    target = row(engine, "SELECT * FROM admins WHERE id = :id AND removed_at IS NULL", {"id": target_id})
    if not target or target_id == actor["id"]:
        raise AuthenticationError("The Main Admin's subject access cannot be changed here.")
    main = row(engine, "SELECT admin_id FROM main_admin_config WHERE singleton = 1")
    if main and target_id == main["admin_id"]:
        raise AuthenticationError("The Main Admin always retains every configured subject.")
    now = utc_iso()
    with engine.begin() as connection:
        connection.execute(
            text("DELETE FROM admin_subject_assignments WHERE admin_id = :id"),
            {"id": target_id},
        )
        for subject in selected:
            connection.execute(
                text(
                    "INSERT INTO admin_subject_assignments "
                    "(admin_id, subject, assigned_at, assigned_by) "
                    "VALUES (:id, :subject, :now, :actor)"
                ),
                {"id": target_id, "subject": subject, "now": now, "actor": actor["id"]},
            )
        _audit(connection, actor["id"], "MAIN_ADMIN", "admin_subjects_changed", target["email"], reason.strip(), target_id)


def admin_accounts(engine: Engine) -> list[dict]:
    result = rows(
        engine,
        """
        SELECT admins.*, main_admin_config.admin_id AS main_admin_id
        FROM admins CROSS JOIN main_admin_config
        WHERE admins.removed_at IS NULL AND main_admin_config.singleton = 1
        ORDER BY admins.created_at
        """,
    )
    for admin in result:
        admin["effective_role"] = (
            "MAIN_ADMIN" if admin["id"] == admin["main_admin_id"] else "ADMIN"
        )
        admin["subjects"] = [
            item["subject"]
            for item in rows(
                engine,
                "SELECT subject FROM admin_subject_assignments WHERE admin_id = :id ORDER BY subject",
                {"id": admin["id"]},
            )
        ]
    return result
