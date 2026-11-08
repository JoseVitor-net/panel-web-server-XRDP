import asyncio
import hmac
import json
import sqlite3
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, WebSocket, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.db import db_session, get_connection, run_migrations
from app.schemas import (
    AuditLogItem,
    AuthSessionResponse,
    LoginRequest,
    TVCreateRequest,
    TVResponse,
    TVServiceActionRequest,
    TVUpdateRequest,
)
from app.security import (
    create_session,
    get_authenticated_session,
    iso_utc,
    parse_iso_utc,
    record_audit_log,
    utcnow,
    verify_password,
)
from app.services.guacd_tunnel import encode_guac_instruction, run_guacd_websocket_tunnel
from app.services.system_inspector import (
    build_shadow_flags_preview,
    control_tv_shadow_service,
    inspect_tv_runtime,
    invalidate_runtime_cache,
    register_ws_viewer,
    unregister_ws_viewer,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    run_migrations()
    yield


app = FastAPI(
    title="Painel de Administração e Acesso Shadow RDP (Debian 13)",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)


@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    response: Response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "connect-src 'self' ws: wss:; "
        "img-src 'self' data: blob:; "
        "style-src 'self' 'unsafe-inline'; "
        "script-src 'self'; "
        "frame-ancestors 'none'; "
        "base-uri 'self'"
    )
    return response


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_: Request, exc: RequestValidationError):
    messages: list[str] = []
    for err in exc.errors():
        loc = " -> ".join(str(x) for x in err.get("loc", []) if x != "body")
        msg = err.get("msg", "Valor inválido")
        messages.append(f"{loc}: {msg}" if loc else msg)
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": "Dados inválidos: " + "; ".join(messages)},
    )


@app.exception_handler(Exception)
async def global_exception_handler(_: Request, exc: Exception):
    if isinstance(exc, HTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail},
        )
    # Nunca expor stack traces, comandos internos ou segredos ao navegador
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "detail": "Ocorreu um erro interno ao processar a solicitação. Consulte os logs administrativos do servidor."
        },
    )


def get_db():
    with db_session() as conn:
        yield conn


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def _row_to_tv_response(row: sqlite3.Row) -> TVResponse:
    tv_dict = dict(row)
    tv_dict["gfx_enabled"] = bool(tv_dict["gfx_enabled"])
    tv_dict["server_side_cursor"] = bool(tv_dict["server_side_cursor"])
    tv_dict["shadow_auth_enabled"] = bool(tv_dict["shadow_auth_enabled"])
    tv_dict["enabled"] = bool(tv_dict["enabled"])
    runtime = inspect_tv_runtime(tv_dict)
    return TVResponse(
        id=int(tv_dict["id"]),
        slug=tv_dict["slug"],
        name=tv_dict["name"],
        location=tv_dict["location"],
        unix_user=tv_dict["unix_user"],
        local_port=int(tv_dict["local_port"]),
        bind_address=tv_dict["bind_address"],
        display_number=tv_dict["display_number"],
        gfx_enabled=tv_dict["gfx_enabled"],
        server_side_cursor=tv_dict["server_side_cursor"],
        sec_mode=tv_dict["sec_mode"],
        shadow_auth_enabled=tv_dict["shadow_auth_enabled"],
        enabled=tv_dict["enabled"],
        notes=tv_dict["notes"],
        effective_shadow_flags_preview=build_shadow_flags_preview(tv_dict),
        created_at=tv_dict["created_at"],
        updated_at=tv_dict["updated_at"],
        runtime=runtime,
    )


@app.get("/api/health")
def health_check():
    settings = get_settings()
    return {"status": "ok", "env_mode": settings.env_mode}


@app.post("/api/auth/login", response_model=AuthSessionResponse)
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    conn: sqlite3.Connection = Depends(get_db),
):
    settings = get_settings()
    ip_addr = _client_ip(request)
    username = payload.username.strip()

    admin = conn.execute(
        "SELECT * FROM admins WHERE username = ?", (username,)
    ).fetchone()

    if not admin:
        record_audit_log(
            conn,
            actor_username=username,
            ip_address=ip_addr,
            action="auth.login",
            target_type="admin",
            target_id=username,
            outcome="failure",
            details={"reason": "user_not_found"},
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenciais inválidas.",
        )

    if not admin["is_active"]:
        record_audit_log(
            conn,
            actor_username=username,
            ip_address=ip_addr,
            action="auth.login",
            target_type="admin",
            target_id=username,
            outcome="denied",
            details={"reason": "account_inactive"},
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Conta administrativa desativada.",
        )

    if admin["locked_until"]:
        locked_until_dt = parse_iso_utc(admin["locked_until"])
        if locked_until_dt > utcnow():
            record_audit_log(
                conn,
                actor_username=username,
                ip_address=ip_addr,
                action="auth.login",
                target_type="admin",
                target_id=username,
                outcome="denied",
                details={"reason": "account_locked", "locked_until": admin["locked_until"]},
            )
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Conta temporariamente bloqueada por excesso de tentativas. Aguarde alguns minutos.",
            )

    if not verify_password(payload.password, admin["password_hash"]):
        new_failures = int(admin["failed_attempts"]) + 1
        locked_until_val = None
        if new_failures >= settings.max_failed_logins:
            locked_until_val = iso_utc(
                utcnow() + timedelta(minutes=settings.lockout_minutes)
            )
        conn.execute(
            "UPDATE admins SET failed_attempts = ?, locked_until = ? WHERE id = ?",
            (new_failures, locked_until_val, admin["id"]),
        )
        record_audit_log(
            conn,
            actor_username=username,
            ip_address=ip_addr,
            action="auth.login",
            target_type="admin",
            target_id=username,
            outcome="failure",
            details={"failed_attempts": new_failures, "locked": bool(locked_until_val)},
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenciais inválidas.",
        )

    conn.execute(
        "UPDATE admins SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?",
        (iso_utc(), admin["id"]),
    )

    session_id, csrf_token, expires_at = create_session(
        conn,
        admin_id=int(admin["id"]),
        ip_address=ip_addr,
        user_agent=request.headers.get("User-Agent", "unknown"),
    )

    record_audit_log(
        conn,
        actor_username=username,
        ip_address=ip_addr,
        action="auth.login",
        target_type="session",
        target_id=str(admin["id"]),
        outcome="success",
        details={},
    )

    response.set_cookie(
        key=settings.session_cookie_name,
        value=session_id,
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,  # type: ignore[arg-type]
        max_age=settings.session_ttl_minutes * 60,
        path="/",
    )

    return AuthSessionResponse(
        authenticated=True,
        username=username,
        csrf_token=csrf_token,
        expires_at=expires_at,
        env_mode=settings.env_mode,
    )


@app.post("/api/auth/logout")
def logout(
    request: Request,
    response: Response,
    conn: sqlite3.Connection = Depends(get_db),
):
    settings = get_settings()
    sess = get_authenticated_session(conn, request, require_csrf=True)
    conn.execute("UPDATE sessions SET revoked = 1 WHERE id = ?", (sess["session_id"],))
    record_audit_log(
        conn,
        actor_username=sess["username"],
        ip_address=_client_ip(request),
        action="auth.logout",
        target_type="session",
        target_id=str(sess["admin_id"]),
        outcome="success",
    )
    response.delete_cookie(key=settings.session_cookie_name, path="/")
    return {"detail": "Sessão encerrada com sucesso."}


@app.get("/api/auth/me", response_model=AuthSessionResponse)
def get_me(
    request: Request,
    conn: sqlite3.Connection = Depends(get_db),
):
    settings = get_settings()
    sess = get_authenticated_session(conn, request, require_csrf=False)
    return AuthSessionResponse(
        authenticated=True,
        username=sess["username"],
        csrf_token=sess["csrf_token"],
        expires_at=sess["expires_at"],
        env_mode=settings.env_mode,
    )


@app.get("/api/tvs", response_model=list[TVResponse])
def list_tvs(
    request: Request,
    conn: sqlite3.Connection = Depends(get_db),
):
    get_authenticated_session(conn, request, require_csrf=False)
    rows = conn.execute("SELECT * FROM tvs ORDER BY local_port ASC").fetchall()
    return [_row_to_tv_response(r) for r in rows]


@app.get("/api/tvs/{tv_id}", response_model=TVResponse)
def get_tv(
    tv_id: int,
    request: Request,
    conn: sqlite3.Connection = Depends(get_db),
):
    get_authenticated_session(conn, request, require_csrf=False)
    row = conn.execute("SELECT * FROM tvs WHERE id = ?", (tv_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="TV não encontrada.")
    return _row_to_tv_response(row)


@app.post("/api/tvs", response_model=TVResponse, status_code=status.HTTP_201_CREATED)
def create_tv(
    payload: TVCreateRequest,
    request: Request,
    conn: sqlite3.Connection = Depends(get_db),
):
    sess = get_authenticated_session(conn, request, require_csrf=True)

    conflict = conn.execute(
        """
        SELECT slug, unix_user, local_port FROM tvs
        WHERE slug = ? OR unix_user = ? OR local_port = ?
        """,
        (payload.slug, payload.unix_user, payload.local_port),
    ).fetchone()
    if conflict:
        if conflict["slug"] == payload.slug:
            msg = f"Já existe uma TV cadastrada com o identificador '{payload.slug}'."
        elif conflict["unix_user"] == payload.unix_user:
            msg = f"O usuário Unix '{payload.unix_user}' já está vinculado a outra TV."
        else:
            msg = f"A porta local {payload.local_port} já está alocada para outra TV."
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=msg)

    now_str = iso_utc()
    cursor = conn.execute(
        """
        INSERT INTO tvs (
            slug, name, location, unix_user, local_port, bind_address,
            display_number, gfx_enabled, server_side_cursor, sec_mode,
            shadow_auth_enabled, enabled, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, '127.0.0.1', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            payload.slug,
            payload.name.strip(),
            payload.location.strip(),
            payload.unix_user,
            payload.local_port,
            payload.display_number,
            1 if payload.gfx_enabled else 0,
            1 if payload.server_side_cursor else 0,
            payload.sec_mode,
            1 if payload.shadow_auth_enabled else 0,
            1 if payload.enabled else 0,
            payload.notes.strip(),
            now_str,
            now_str,
        ),
    )
    tv_id = cursor.lastrowid
    record_audit_log(
        conn,
        actor_username=sess["username"],
        ip_address=_client_ip(request),
        action="tv.create",
        target_type="tv",
        target_id=payload.slug,
        outcome="success",
        details={
            "unix_user": payload.unix_user,
            "local_port": payload.local_port,
            "enabled": payload.enabled,
        },
    )
    row = conn.execute("SELECT * FROM tvs WHERE id = ?", (tv_id,)).fetchone()
    return _row_to_tv_response(row)


@app.put("/api/tvs/{tv_id}", response_model=TVResponse)
def update_tv(
    tv_id: int,
    payload: TVUpdateRequest,
    request: Request,
    conn: sqlite3.Connection = Depends(get_db),
):
    sess = get_authenticated_session(conn, request, require_csrf=True)
    existing = conn.execute("SELECT * FROM tvs WHERE id = ?", (tv_id,)).fetchone()
    if not existing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="TV não encontrada.")

    conflict = conn.execute(
        """
        SELECT slug, unix_user, local_port FROM tvs
        WHERE (slug = ? OR unix_user = ? OR local_port = ?) AND id != ?
        """,
        (payload.slug, payload.unix_user, payload.local_port, tv_id),
    ).fetchone()
    if conflict:
        if conflict["slug"] == payload.slug:
            msg = f"Já existe outra TV com o identificador '{payload.slug}'."
        elif conflict["unix_user"] == payload.unix_user:
            msg = f"O usuário Unix '{payload.unix_user}' já está vinculado a outra TV."
        else:
            msg = f"A porta local {payload.local_port} já está alocada para outra TV."
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=msg)

    current_runtime = inspect_tv_runtime(dict(existing))
    disruptive_change = (
        (bool(existing["enabled"]) and not payload.enabled)
        or (int(existing["local_port"]) != payload.local_port)
        or (existing["unix_user"] != payload.unix_user)
        or (bool(existing["gfx_enabled"]) != payload.gfx_enabled)
        or (bool(existing["server_side_cursor"]) != payload.server_side_cursor)
        or (existing["sec_mode"] != payload.sec_mode)
        or (bool(existing["shadow_auth_enabled"]) != payload.shadow_auth_enabled)
    )

    if disruptive_change and (
        current_runtime.viewer_connection_state == "connected"
        or current_runtime.shadow_service_state == "available"
    ):
        if not payload.confirm_disruption:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Esta alteração pode interromper uma sessão Shadow ativa ou desconectar um operador. Confirme explicitamente a operação.",
            )

    conn.execute(
        """
        UPDATE tvs SET
            slug = ?,
            name = ?,
            location = ?,
            unix_user = ?,
            local_port = ?,
            display_number = ?,
            gfx_enabled = ?,
            server_side_cursor = ?,
            sec_mode = ?,
            shadow_auth_enabled = ?,
            enabled = ?,
            notes = ?,
            updated_at = ?
        WHERE id = ?
        """,
        (
            payload.slug,
            payload.name.strip(),
            payload.location.strip(),
            payload.unix_user,
            payload.local_port,
            payload.display_number,
            1 if payload.gfx_enabled else 0,
            1 if payload.server_side_cursor else 0,
            payload.sec_mode,
            1 if payload.shadow_auth_enabled else 0,
            1 if payload.enabled else 0,
            payload.notes.strip(),
            iso_utc(),
            tv_id,
        ),
    )

    record_audit_log(
        conn,
        actor_username=sess["username"],
        ip_address=_client_ip(request),
        action="tv.update",
        target_type="tv",
        target_id=payload.slug,
        outcome="success",
        details={
            "unix_user": payload.unix_user,
            "local_port": payload.local_port,
            "enabled": payload.enabled,
            "disruptive_change": disruptive_change,
        },
    )

    invalidate_runtime_cache(tv_id)
    updated = conn.execute("SELECT * FROM tvs WHERE id = ?", (tv_id,)).fetchone()
    return _row_to_tv_response(updated)


@app.post("/api/tvs/{tv_id}/service", response_model=TVResponse)
def manage_tv_service(
    tv_id: int,
    payload: TVServiceActionRequest,
    request: Request,
    conn: sqlite3.Connection = Depends(get_db),
):
    sess = get_authenticated_session(conn, request, require_csrf=True)
    row = conn.execute("SELECT * FROM tvs WHERE id = ?", (tv_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="TV não encontrada.")

    tv_dict = dict(row)
    runtime = inspect_tv_runtime(tv_dict)

    if payload.action in ("stop", "restart") or runtime.viewer_connection_state == "connected":
        if not payload.confirm_disruption:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Confirmação explícita é obrigatória antes de executar '{payload.action}' no serviço Shadow.",
            )

    ok, msg = control_tv_shadow_service(tv_dict, payload.action)
    record_audit_log(
        conn,
        actor_username=sess["username"],
        ip_address=_client_ip(request),
        action=f"service.{payload.action}",
        target_type="tv",
        target_id=tv_dict["slug"],
        outcome="success" if ok else "error",
        details={"unit": runtime.systemd_unit, "message": msg},
    )

    if not ok:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=msg)

    refreshed = conn.execute("SELECT * FROM tvs WHERE id = ?", (tv_id,)).fetchone()
    return _row_to_tv_response(refreshed)


@app.get("/api/audit-logs", response_model=list[AuditLogItem])
def list_audit_logs(
    request: Request,
    limit: int = Query(default=50, ge=1, le=200),
    conn: sqlite3.Connection = Depends(get_db),
):
    get_authenticated_session(conn, request, require_csrf=False)
    rows = conn.execute(
        "SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    items: list[AuditLogItem] = []
    for r in rows:
        try:
            details_obj = json.loads(r["details_json"])
        except Exception:
            details_obj = {}
        items.append(
            AuditLogItem(
                id=int(r["id"]),
                timestamp=r["timestamp"],
                actor_username=r["actor_username"],
                ip_address=r["ip_address"],
                action=r["action"],
                target_type=r["target_type"],
                target_id=r["target_id"],
                outcome=r["outcome"],
                details=details_obj,
            )
        )
    return items


@app.websocket("/api/ws/tv/{tv_id}")
async def tv_guacamole_websocket(
    websocket: WebSocket,
    tv_id: int,
    csrf_token: str = Query(default=""),
    width: int = Query(default=1920, ge=640, le=3840),
    height: int = Query(default=1080, ge=360, le=2160),
):
    settings = get_settings()
    session_id = websocket.cookies.get(settings.session_cookie_name)

    await websocket.accept(subprotocol="guacamole")
    await websocket.send_text(
        encode_guac_instruction("", "00000000-0000-0000-0000-000000000001")
    )

    async def reject_guac_ws(message: str, code: str = "519") -> None:
        try:
            await websocket.send_text(encode_guac_instruction("error", message, code))
            await websocket.send_text(encode_guac_instruction("disconnect"))
            await websocket.close()
        except Exception:
            pass

    conn = get_connection()
    try:
        if not session_id or not csrf_token:
            await reject_guac_ws(
                "Sessão não autenticada ou token CSRF ausente. Recarregue o painel (Ctrl+F5) e faça login novamente.",
                "769",
            )
            return

        sess = conn.execute(
            """
            SELECT s.id, s.csrf_token, s.expires_at, s.revoked, a.username, a.is_active
            FROM sessions s
            JOIN admins a ON a.id = s.admin_id
            WHERE s.id = ?
            """,
            (session_id,),
        ).fetchone()

        if (
            not sess
            or sess["revoked"]
            or not sess["is_active"]
            or parse_iso_utc(sess["expires_at"]) <= utcnow()
            or not hmac.compare_digest(csrf_token, sess["csrf_token"])
        ):
            await reject_guac_ws(
                "Sua sessão administrativa expirou ou o token CSRF mudou. Recarregue a página (Ctrl+F5) e tente novamente.",
                "769",
            )
            return

        tv_row = conn.execute("SELECT * FROM tvs WHERE id = ?", (tv_id,)).fetchone()
        if not tv_row:
            await reject_guac_ws("TV não encontrada no banco de dados.", "519")
            return

        tv_dict: dict[str, Any] = dict(tv_row)
        runtime = await asyncio.to_thread(inspect_tv_runtime, tv_dict)
        if not tv_dict["enabled"] or runtime.overall_status != "online":
            await reject_guac_ws(
                runtime.user_message
                or "Esta TV não está com sessão XFCE e Shadow disponíveis para espelhamento.",
                "519",
            )
            return

        actor_username = str(sess["username"])
        client_host = websocket.client.host if websocket.client else "unknown"
        try:
            record_audit_log(
                conn,
                actor_username=actor_username,
                ip_address=client_host,
                action="viewer.connect",
                target_type="tv",
                target_id=tv_dict["slug"],
                outcome="success",
                details={"local_port": tv_dict["local_port"]},
            )
            conn.commit()
        except Exception:
            pass
    finally:
        conn.close()

    register_ws_viewer(tv_id)
    try:
        await run_guacd_websocket_tunnel(
            websocket, tv_dict, width=width, height=height, send_initial_uuid=False
        )
    finally:
        unregister_ws_viewer(tv_id)
        try:
            with db_session() as audit_conn:
                record_audit_log(
                    audit_conn,
                    actor_username=actor_username,
                    ip_address=client_host,
                    action="viewer.disconnect",
                    target_type="tv",
                    target_id=tv_dict["slug"],
                    outcome="success",
                    details={"local_port": tv_dict["local_port"]},
                )
        except Exception:
            pass

