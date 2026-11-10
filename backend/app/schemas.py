import re
from typing import Literal
from pydantic import BaseModel, Field, field_validator

FORBIDDEN_UNIX_USERS = {
    "root",
    "daemon",
    "bin",
    "sys",
    "sync",
    "games",
    "man",
    "lp",
    "mail",
    "news",
    "uucp",
    "proxy",
    "www-data",
    "backup",
    "list",
    "irc",
    "gnats",
    "nobody",
    "systemd-network",
    "systemd-resolve",
    "messagebus",
    "sshd",
    "xrdp",
    "guacd",
    "postgres",
    "tv-panel",
    "caddy",
    "nginx",
}

UNIX_USER_REGEX = re.compile(r"^[a-z_][a-z0-9_-]{1,30}$")
SLUG_REGEX = re.compile(r"^[a-z0-9][a-z0-9_-]{1,30}$")


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=64)
    password: str = Field(..., min_length=1, max_length=256)


class AuthSessionResponse(BaseModel):
    authenticated: bool
    username: str
    csrf_token: str
    expires_at: str
    env_mode: str


class TVBasePayload(BaseModel):
    slug: str = Field(..., min_length=2, max_length=31, description="Identificador curto da TV, ex: tv01")
    name: str = Field(..., min_length=2, max_length=80, description="Nome amigável da TV")
    location: str = Field(default="", max_length=80, description="Local físico da TV")
    unix_user: str = Field(..., min_length=2, max_length=31, description="Usuário Unix dedicado da sessão XFCE")
    local_port: int = Field(..., ge=3391, le=3499, description="Porta local exclusiva do FreeRDP Shadow (3391-3499)")
    display_number: int | None = Field(default=None, ge=0, le=99, description="Display X11 esperado (opcional, ex: 10 para :10)")
    gfx_enabled: bool = Field(default=True, description="Se verdadeiro, desativa pipeline GFX (-gfx) conforme perfil estável tv03; se falso, mantém GFX padrão")
    server_side_cursor: bool = Field(default=True, description="Ativa +server-side-cursor no FreeRDP Shadow")
    sec_mode: Literal["rdp", "tls", "nla"] = Field(default="rdp", description="Camada de segurança RDP (/sec:rdp, /sec:tls, /sec:nla)")
    shadow_auth_enabled: bool = Field(default=False, description="Se verdadeiro, usa +auth (exige PAM/SAM funcional); se falso, usa -auth restrito a 127.0.0.1")
    enabled: bool = Field(default=True, description="Habilita ou desabilita a TV no painel")
    notes: str = Field(default="", max_length=500, description="Observações operacionais")
    unix_password: str = Field(
        default="",
        max_length=128,
        description="Senha opcional da conta Unix da TV para login XRDP (se preenchida, cria/redefine a senha do usuário Unix da TV)",
    )

    @field_validator("slug")
    @classmethod
    def validate_slug(cls, value: str) -> str:
        cleaned = value.strip().lower()
        if not SLUG_REGEX.match(cleaned):
            raise ValueError("O identificador (slug) deve conter apenas letras minúsculas, números, hífen ou sublinhado.")
        return cleaned

    @field_validator("unix_user")
    @classmethod
    def validate_unix_user(cls, value: str) -> str:
        cleaned = value.strip()
        if not UNIX_USER_REGEX.match(cleaned):
            raise ValueError("Nome de usuário Unix inválido. Use apenas letras minúsculas, números, '_' ou '-'.")
        if cleaned in FORBIDDEN_UNIX_USERS:
            raise ValueError(f"O usuário Unix '{cleaned}' é reservado do sistema e não pode ser associado a uma TV.")
        return cleaned

    @field_validator("local_port")
    @classmethod
    def validate_local_port(cls, value: int) -> int:
        if value in (3389, 3350, 4822, 8000, 80, 443, 22):
            raise ValueError(f"A porta {value} é reservada para serviços de sistema (XRDP/guacd/HTTP/SSH).")
        return value


class TVCreateRequest(TVBasePayload):
    pass


class TVUpdateRequest(TVBasePayload):
    confirm_disruption: bool = Field(
        default=False,
        description="Confirmação explícita caso a alteração afete uma sessão ativa ou conectada.",
    )


class TVServiceActionRequest(BaseModel):
    action: Literal["start", "stop", "restart"]
    confirm_disruption: bool = Field(
        default=False,
        description="Obrigatório para 'stop' ou 'restart' ou quando há espectador conectado.",
    )


class TVRuntimeState(BaseModel):
    overall_status: Literal["online", "degraded", "offline", "disabled", "unknown"]
    xfce_session_state: Literal["active", "inactive", "unknown"]
    shadow_service_state: Literal["available", "unavailable", "conflict", "starting", "error", "unknown"]
    viewer_connection_state: Literal["connected", "idle", "unknown"]
    active_viewers_count: int
    detected_display: str | None
    xauthority_ready: bool
    systemd_unit: str
    systemd_active_state: str
    port_conflict_detail: str | None
    user_message: str
    last_checked_at: str
    cpu_percent: float = 0.0
    memory_mb: float = 0.0
    memory_percent: float = 0.0
    process_count: int = 0
    shadow_cpu_percent: float = 0.0
    shadow_memory_mb: float = 0.0


class SystemOverviewTelemetry(BaseModel):
    hostname: str
    cpu_cores: int
    cpu_percent: float
    load_avg_1m: float
    load_avg_5m: float
    load_avg_15m: float
    mem_total_mb: float
    mem_used_mb: float
    mem_available_mb: float
    mem_percent: float
    swap_total_mb: float
    swap_used_mb: float
    swap_percent: float
    disk_total_gb: float
    disk_used_gb: float
    disk_percent: float
    uptime_seconds: int
    tvs_total_cpu_percent: float
    tvs_total_memory_mb: float
    tvs_total_memory_percent: float
    other_system_cpu_percent: float
    other_system_memory_mb: float
    other_system_memory_percent: float
    active_tv_sessions_count: int
    avg_tv_cpu_percent: float
    avg_tv_memory_mb: float
    estimated_extra_tvs_capacity: int
    timestamp: str


class TVResponse(BaseModel):
    id: int
    slug: str
    name: str
    location: str
    unix_user: str
    local_port: int
    bind_address: str
    display_number: int | None
    gfx_enabled: bool
    server_side_cursor: bool
    sec_mode: Literal["rdp", "tls", "nla"]
    shadow_auth_enabled: bool
    enabled: bool
    notes: str
    effective_shadow_flags_preview: str
    created_at: str
    updated_at: str
    runtime: TVRuntimeState


class AuditLogItem(BaseModel):
    id: int
    timestamp: str
    actor_username: str | None
    ip_address: str | None
    action: str
    target_type: str
    target_id: str | None
    outcome: str
    details: dict


class UserResponse(BaseModel):
    id: int
    username: str
    is_active: bool
    failed_attempts: int
    locked_until: str | None
    created_at: str
    last_login_at: str | None


class UserCreateRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=64)
    password: str = Field(..., min_length=10, max_length=128)
    is_active: bool = Field(default=True)

    @field_validator("username")
    @classmethod
    def validate_username(cls, value: str) -> str:
        cleaned = value.strip().lower()
        if not re.match(r"^[a-z0-9_\-\.]{3,64}$", cleaned):
            raise ValueError(
                "O nome de usuário deve conter apenas letras, números, hífens, sublinhados ou pontos."
            )
        if cleaned in FORBIDDEN_UNIX_USERS:
            raise ValueError(f"O nome de usuário '{cleaned}' é reservado pelo sistema.")
        return cleaned


class UserPasswordResetRequest(BaseModel):
    new_password: str = Field(..., min_length=10, max_length=128)


class UserStatusUpdateRequest(BaseModel):
    is_active: bool


class GenericMessageResponse(BaseModel):
    ok: bool
    message: str

