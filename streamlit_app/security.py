from __future__ import annotations

import bcrypt
import hashlib
import hmac
import re
import secrets
from datetime import datetime, timezone
from typing import Any


EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
STUDENT_NAME_PATTERN = re.compile(r"^(?=.{3,}$)[A-Za-z]+(?: [A-Za-z]+)*$")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_iso() -> str:
    return utc_now().isoformat()


def normalize_email(email: str) -> str:
    return str(email or "").strip().lower()


def valid_email(email: str) -> bool:
    return bool(EMAIL_PATTERN.fullmatch(normalize_email(email)))


def valid_password(password: str) -> bool:
    return isinstance(password, str) and 8 <= len(password) <= 128


def valid_student_name(name: str) -> bool:
    return bool(STUDENT_NAME_PATTERN.fullmatch(" ".join(str(name or "").split())))


def password_digest(password: str) -> str:
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def hash_password(password: str, rounds: int = 12) -> str:
    digest = password_digest(password).encode("ascii")
    return "bcrypt-sha256:" + bcrypt.hashpw(
        digest, bcrypt.gensalt(rounds=rounds)
    ).decode("ascii")


def verify_password(password: str, stored_hash: str | None) -> bool:
    if not stored_hash:
        bcrypt.checkpw(b"invalid", bcrypt.hashpw(b"invalid", bcrypt.gensalt()))
        return False
    if stored_hash.startswith("scrypt$"):
        try:
            _, salt, digest_hex = stored_hash.split("$", 2)
            derived = hashlib.scrypt(
                password.encode("utf-8"),
                salt=salt.encode("utf-8"),
                n=16384,
                r=8,
                p=1,
                dklen=64,
            )
            return hmac.compare_digest(derived.hex(), digest_hex)
        except (ValueError, TypeError):
            return False
    if stored_hash.startswith("bcrypt-sha256:"):
        stored_hash = stored_hash.split(":", 1)[1]
        candidate = password_digest(password).encode("ascii")
    else:
        candidate = password.encode("utf-8")
    try:
        return bcrypt.checkpw(candidate, stored_hash.encode("ascii"))
    except (ValueError, TypeError):
        return False


def hash_otp(code: str) -> str:
    return bcrypt.hashpw(code.encode("ascii"), bcrypt.gensalt(rounds=12)).decode("ascii")


def verify_otp(code: str, stored_hash: str) -> bool:
    try:
        return bcrypt.checkpw(code.encode("ascii"), stored_hash.encode("ascii"))
    except (ValueError, TypeError):
        return False


def new_otp() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def sign_qr_session(session_id: str, secret: str) -> str:
    signature = hmac.new(
        secret.encode("utf-8"), session_id.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return f"{session_id}.{signature}"


def verify_qr_session(token: str, secret: str) -> str | None:
    session_id, separator, signature = str(token or "").rpartition(".")
    if not separator or not session_id:
        return None
    expected = sign_qr_session(session_id, secret).rpartition(".")[2]
    return session_id if hmac.compare_digest(signature, expected) else None


def device_hash(device_token: str) -> str:
    return hashlib.sha256(device_token.strip().encode("utf-8")).hexdigest()


def student_key(student_id: str, name: str, batch: str) -> str:
    identity = f"id:{student_id.strip().lower()}" if student_id.strip() else (
        f"name:{name.strip().lower()}|{batch.strip()}"
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()
