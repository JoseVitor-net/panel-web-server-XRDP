import os
from dataclasses import dataclass, field
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    app_name: str = "Painel TV Shadow RDP"
    env_mode: str = field(
        default_factory=lambda: os.getenv("TV_PANEL_ENV_MODE", "production").lower()
    )
    db_path: Path = field(
        default_factory=lambda: Path(
            os.getenv("TV_PANEL_DB_PATH", str(BASE_DIR / "data" / "tv_panel.db"))
        )
    )
    migrations_dir: Path = field(
        default_factory=lambda: BASE_DIR / "migrations"
    )
    session_cookie_name: str = field(
        default_factory=lambda: os.getenv("TV_PANEL_SESSION_COOKIE", "tv_panel_session")
    )
    session_ttl_minutes: int = field(
        default_factory=lambda: int(os.getenv("TV_PANEL_SESSION_TTL_MINUTES", "480"))
    )
    cookie_secure: bool = field(
        default_factory=lambda: os.getenv("TV_PANEL_COOKIE_SECURE", "true").lower()
        in ("1", "true", "yes")
    )
    cookie_samesite: str = field(
        default_factory=lambda: os.getenv("TV_PANEL_COOKIE_SAMESITE", "strict").lower()
    )
    max_failed_logins: int = field(
        default_factory=lambda: int(os.getenv("TV_PANEL_MAX_FAILED_LOGINS", "5"))
    )
    lockout_minutes: int = field(
        default_factory=lambda: int(os.getenv("TV_PANEL_LOCKOUT_MINUTES", "15"))
    )
    guacd_host: str = field(
        default_factory=lambda: os.getenv("TV_PANEL_GUACD_HOST", "127.0.0.1")
    )
    guacd_port: int = field(
        default_factory=lambda: int(os.getenv("TV_PANEL_GUACD_PORT", "4822"))
    )
    guac_json_secret_key_hex: str = field(
        default_factory=lambda: os.getenv("TV_PANEL_GUAC_JSON_KEY_HEX", "")
    )
    systemd_mode: str = field(
        default_factory=lambda: os.getenv("TV_PANEL_SYSTEMD_MODE", "system-template")
    )
    allowed_origins: list[str] = field(
        default_factory=lambda: [
            o.strip()
            for o in os.getenv(
                "TV_PANEL_ALLOWED_ORIGINS", "https://localhost,https://127.0.0.1"
            ).split(",")
            if o.strip()
        ]
    )


def get_settings() -> Settings:
    return Settings()
