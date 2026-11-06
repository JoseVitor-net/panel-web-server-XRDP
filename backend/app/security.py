import base64
import hashlib
import hmac
import json
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, Request, status

from app.config import get_settings

PBKDF2_ITERATIONS = 600_000


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(dt: datetime | None = None) -> str:
    target = dt or utcnow()
    return target.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso_utc(value: str) -> datetime:
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    return datetime.fromisoformat(value)


def hash_password(password: str) -> str:
    """Gera hash seguro PBKDF2-HMAC-SHA256 com salt de 16 bytes e 600.000 iterações (OWASP)."""
    if len(password) < 10:
        raise ValueError("A senha administrativa deve ter no mínimo 10 caracteres.")
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS
    )
    salt_b64 = base64.b64encode(salt).decode("ascii")
    dk_b64 = base64.b64encode(dk).decode("ascii")
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt_b64}${dk_b64}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, iterations_str, salt_b64, dk_b64 = stored_hash.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        iterations = int(iterations_str)
        salt = base64.b64decode(salt_b64.encode("ascii"))
        expected_dk = base64.b64decode(dk_b64.encode("ascii"))
        candidate_dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, iterations
        )
        return hmac.compare_digest(candidate_dk, expected_dk)
    except Exception:
        return False


def record_audit_log(
    conn: sqlite3.Connection,
    *,
    actor_username: str | None,
    ip_address: str | None,
    action: str,
    target_type: str,
    target_id: str | None,
    outcome: str,
    details: dict[str, Any] | None = None,
) -> None:
    """Registra evento de auditoria garantindo que segredos/senhas/tokens nunca sejam gravados."""
    safe_details = {}
    forbidden_keys = {"password", "password_hash", "token", "csrf_token", "secret", "key"}
    if details:
        for k, v in details.items():
            if k.lower() in forbidden_keys:
                continue
            safe_details[k] = v

    conn.execute(
        """
        INSERT INTO audit_logs (
            timestamp, actor_username, ip_address, action, target_type, target_id, outcome, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            iso_utc(),
            actor_username,
            ip_address,
            action,
            target_type,
            target_id,
            outcome,
            json.dumps(safe_details, ensure_ascii=False),
        ),
    )


def create_session(
    conn: sqlite3.Connection,
    *,
    admin_id: int,
    ip_address: str,
    user_agent: str,
) -> tuple[str, str, str]:
    settings = get_settings()
    session_id = secrets.token_urlsafe(32)
    csrf_token = secrets.token_urlsafe(32)
    expires_at = iso_utc(utcnow() + timedelta(minutes=settings.session_ttl_minutes))

    conn.execute(
        """
        INSERT INTO sessions (id, admin_id, csrf_token, ip_address, user_agent, created_at, expires_at, revoked)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        """,
        (
            session_id,
            admin_id,
            csrf_token,
            ip_address[:128],
            user_agent[:256],
            iso_utc(),
            expires_at,
        ),
    )
    return session_id, csrf_token, expires_at


def get_authenticated_session(
    conn: sqlite3.Connection,
    request: Request,
    *,
    require_csrf: bool = False,
) -> dict[str, Any]:
    settings = get_settings()
    session_id = request.cookies.get(settings.session_cookie_name)
    if not session_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sessão não autenticada. Faça login novamente.",
        )

    row = conn.execute(
        """
        SELECT
            s.id AS session_id,
            s.csrf_token,
            s.expires_at,
            s.revoked,
            a.id AS admin_id,
            a.username,
            a.is_active
        FROM sessions s
        JOIN admins a ON a.id = s.admin_id
        WHERE s.id = ?
        """,
        (session_id,),
    ).fetchone()

    if not row or row["revoked"] or not row["is_active"]:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sessão inválida ou encerrada.",
        )

    if parse_iso_utc(row["expires_at"]) <= utcnow():
        conn.execute("UPDATE sessions SET revoked = 1 WHERE id = ?", (session_id,))
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sua sessão expirou. Faça login novamente.",
        )

    if require_csrf:
        header_csrf = request.headers.get("X-CSRF-Token", "")
        if not header_csrf or not hmac.compare_digest(header_csrf, row["csrf_token"]):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Falha na validação de proteção CSRF.",
            )

    return dict(row)
