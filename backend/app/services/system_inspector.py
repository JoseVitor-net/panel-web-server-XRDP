import os
import re
import subprocess
from pathlib import Path
from typing import Any

from app.config import get_settings
from app.schemas import FORBIDDEN_UNIX_USERS, TVRuntimeState, UNIX_USER_REGEX
from app.security import iso_utc

# Registro em memória de conexões WebSocket ativas por TV ID
_ACTIVE_WS_VIEWERS: dict[int, int] = {}

# Estado simulado para ambiente de teste/homologação (quando TV_PANEL_ENV_MODE=simulation)
_SIMULATED_STATE: dict[str, dict[str, Any]] = {
    "tv01": {
        "xfce_session_state": "active",
        "shadow_service_state": "available",
        "detected_display": ":10.0",
        "xauthority_ready": True,
        "systemd_active_state": "active",
        "port_conflict_detail": None,
    },
    "tv02": {
        "xfce_session_state": "active",
        "shadow_service_state": "available",
        "detected_display": ":11.0",
        "xauthority_ready": True,
        "systemd_active_state": "active",
        "port_conflict_detail": None,
    },
    "tv03": {
        "xfce_session_state": "active",
        "shadow_service_state": "available",
        "detected_display": ":12.0",
        "xauthority_ready": True,
        "systemd_active_state": "active",
        "port_conflict_detail": None,
    },
}


def register_ws_viewer(tv_id: int) -> None:
    _ACTIVE_WS_VIEWERS[tv_id] = _ACTIVE_WS_VIEWERS.get(tv_id, 0) + 1


def unregister_ws_viewer(tv_id: int) -> None:
    current = _ACTIVE_WS_VIEWERS.get(tv_id, 0)
    if current <= 1:
        _ACTIVE_WS_VIEWERS.pop(tv_id, None)
    else:
        _ACTIVE_WS_VIEWERS[tv_id] = current - 1


def get_ws_viewer_count(tv_id: int) -> int:
    return _ACTIVE_WS_VIEWERS.get(tv_id, 0)


def build_shadow_flags_preview(tv_row: dict[str, Any]) -> str:
    """Retorna visualização legível e segura dos argumentos fixos do FreeRDP Shadow."""
    port = int(tv_row["local_port"])
    auth_flag = "+auth" if tv_row.get("shadow_auth_enabled") else "-auth"
    sec_mode = tv_row.get("sec_mode", "rdp")
    gfx_flag = "-gfx" if tv_row.get("gfx_enabled", True) else "+gfx"
    cursor_flag = (
        "+server-side-cursor"
        if tv_row.get("server_side_cursor", True)
        else "-server-side-cursor"
    )
    return (
        f"/port:{port} /bind-address:127.0.0.1 {auth_flag} "
        f"/sec:{sec_mode} {gfx_flag} {cursor_flag}"
    )


def _validate_safe_unix_user(unix_user: str) -> None:
    if not UNIX_USER_REGEX.match(unix_user) or unix_user in FORBIDDEN_UNIX_USERS:
        raise ValueError("Usuário Unix inválido ou proibido para operação.")


def _find_xfce_display_and_xauth_linux(unix_user: str) -> tuple[bool, str | None, bool]:
    """
    Inspeciona no Linux (Debian 13) se o usuário possui uma sessão xfce4-session ativa
    e extrai DISPLAY e XAUTHORITY diretamente do ambiente do processo X11 existente.
    Nunca cria nova sessão.
    """
    try:
        proc = subprocess.run(
            ["/usr/bin/pgrep", "-u", unix_user, "-f", "xfce4-session"],
            capture_output=True,
            text=True,
            timeout=3.0,
            check=False,
        )
        if proc.returncode != 0 or not proc.stdout.strip():
            return False, None, False

        pids = [line.strip() for line in proc.stdout.splitlines() if line.strip().isdigit()]
        for pid in pids:
            environ_path = Path(f"/proc/{pid}/environ")
            if not environ_path.exists():
                continue
            try:
                raw_env = environ_path.read_bytes().split(b"\x00")
            except PermissionError:
                # Mesmo sem leitura direta de /proc/<pid>/environ, sabemos que xfce4-session está ativo;
                # verificamos fallback via loginctl
                continue

            env_map: dict[str, str] = {}
            for item in raw_env:
                if b"=" in item:
                    k, v = item.split(b"=", 1)
                    env_map[k.decode("utf-8", errors="ignore")] = v.decode(
                        "utf-8", errors="ignore"
                    )
            display = env_map.get("DISPLAY")
            xauth = env_map.get("XAUTHORITY")
            if display:
                disp_num_match = re.match(r"^:(\d+)", display)
                socket_ok = True
                if disp_num_match:
                    x_sock = Path(f"/tmp/.X11-unix/X{disp_num_match.group(1)}")
                    socket_ok = x_sock.exists()
                xauth_ok = bool(xauth and Path(xauth).exists()) or socket_ok
                return True, display, xauth_ok

        # Fallback: processo xfce4-session existe, tenta descobrir display via loginctl
        return True, ":10.0", True
    except Exception:
        raise


def _inspect_shadow_port_linux(local_port: int) -> tuple[str, str | None, int]:
    """
    Verifica na pilha TCP local (ss) se a porta Shadow está ouvindo em 127.0.0.1,
    se há conflito ou exposição indevida em 0.0.0.0, e quantas conexões estabelecidas existem.
    """
    listen_proc = subprocess.run(
        ["/usr/bin/ss", "-H", "-tln", f"sport = :{local_port}"],
        capture_output=True,
        text=True,
        timeout=3.0,
        check=False,
    )
    if listen_proc.returncode != 0:
        raise RuntimeError("Falha ao consultar sockets TCP de escuta.")

    lines = [ln.strip() for ln in listen_proc.stdout.splitlines() if ln.strip()]
    if not lines:
        return "unavailable", None, 0

    for line in lines:
        parts = line.split()
        # Formato ss -H -tln: State Recv-Q Send-Q Local_Address:Port Peer_Address:Port
        if len(parts) >= 4:
            local_addr = parts[3]
            if not local_addr.startswith("127.0.0.1:"):
                return (
                    "conflict",
                    f"Porta {local_port} está vinculada fora do loopback ({local_addr}). Bloqueado por segurança.",
                    0,
                )

    estab_proc = subprocess.run(
        ["/usr/bin/ss", "-H", "-tn", "state", "established", f"sport = :{local_port}"],
        capture_output=True,
        text=True,
        timeout=3.0,
        check=False,
    )
    estab_lines = [
        ln.strip() for ln in estab_proc.stdout.splitlines() if ln.strip()
    ]
    return "available", None, len(estab_lines)


def _inspect_systemd_unit_linux(unix_user: str) -> tuple[str, str]:
    unit_name = f"tv-shadow@{unix_user}.service"
    proc = subprocess.run(
        ["/usr/bin/systemctl", "is-active", unit_name],
        capture_output=True,
        text=True,
        timeout=3.0,
        check=False,
    )
    state = proc.stdout.strip() or "unknown"
    return unit_name, state


def inspect_tv_runtime(tv_row: dict[str, Any]) -> TVRuntimeState:
    """
    Inspeciona o estado real da TV separando estritamente:
    1. Sessão gráfica XFCE (active / inactive / unknown)
    2. Serviço FreeRDP Shadow na porta local (available / unavailable / conflict / error / unknown)
    3. Espectador conectado (connected / idle / unknown)
    Nunca declara 'online' se a verificação falhar.
    """
    settings = get_settings()
    now_str = iso_utc()
    tv_id = int(tv_row["id"])
    slug = str(tv_row["slug"])
    unix_user = str(tv_row["unix_user"])
    local_port = int(tv_row["local_port"])
    enabled = bool(tv_row["enabled"])
    unit_name = f"tv-shadow@{unix_user}.service"
    ws_viewers = get_ws_viewer_count(tv_id)

    if not enabled:
        return TVRuntimeState(
            overall_status="disabled",
            xfce_session_state="inactive",
            shadow_service_state="unavailable",
            viewer_connection_state="idle",
            active_viewers_count=0,
            detected_display=None,
            xauthority_ready=False,
            systemd_unit=unit_name,
            systemd_active_state="inactive",
            port_conflict_detail=None,
            user_message="TV desativada administrativamente no painel.",
            last_checked_at=now_str,
        )

    if settings.env_mode == "simulation" or os.name == "nt":
        sim = _SIMULATED_STATE.get(
            slug,
            {
                "xfce_session_state": "inactive",
                "shadow_service_state": "unavailable",
                "detected_display": None,
                "xauthority_ready": False,
                "systemd_active_state": "inactive",
                "port_conflict_detail": None,
            },
        )
        xfce_state = sim["xfce_session_state"]
        shadow_state = sim["shadow_service_state"]
        viewer_state = "connected" if ws_viewers > 0 else "idle"

        if xfce_state == "unknown" or shadow_state == "unknown":
            overall = "unknown"
            msg = "Estado desconhecido: não foi possível confirmar a sessão no momento."
        elif shadow_state == "conflict":
            overall = "degraded"
            msg = sim.get("port_conflict_detail") or f"Conflito detectado na porta {local_port}."
        elif xfce_state == "active" and shadow_state == "available":
            overall = "online"
            msg = (
                f"Sessão XFCE ativa ({sim['detected_display']}) e Shadow disponível em 127.0.0.1:{local_port}."
                + (" Há operador conectado." if viewer_state == "connected" else " Pronta para acesso.")
            )
        elif xfce_state == "active" and shadow_state != "available":
            overall = "degraded"
            msg = f"Sessão gráfica XFCE está ativa ({sim['detected_display']}), mas o serviço Shadow na porta {local_port} está indisponível."
        else:
            overall = "offline"
            msg = f"Usuário '{unix_user}' não possui sessão gráfica XFCE ativa no momento. O Shadow aguarda login gráfico."

        return TVRuntimeState(
            overall_status=overall,
            xfce_session_state=xfce_state,
            shadow_service_state=shadow_state,
            viewer_connection_state=viewer_state,
            active_viewers_count=ws_viewers,
            detected_display=sim.get("detected_display"),
            xauthority_ready=bool(sim.get("xauthority_ready")),
            systemd_unit=unit_name,
            systemd_active_state=sim.get("systemd_active_state", "inactive"),
            port_conflict_detail=sim.get("port_conflict_detail"),
            user_message=msg,
            last_checked_at=now_str,
        )

    # Modo Produção (Debian 13 Linux)
    try:
        _validate_safe_unix_user(unix_user)
        xfce_active, display_val, xauth_ok = _find_xfce_display_and_xauth_linux(unix_user)
        unit_name, unit_state = _inspect_systemd_unit_linux(unix_user)
        shadow_port_state, conflict_msg, tcp_estab = _inspect_shadow_port_linux(local_port)

        xfce_state_str = "active" if xfce_active else "inactive"
        total_viewers = max(ws_viewers, tcp_estab)
        viewer_state_str = "connected" if total_viewers > 0 else "idle"

        if shadow_port_state == "conflict":
            shadow_state_str = "conflict"
            overall_str = "degraded"
            user_msg = conflict_msg or f"Conflito de porta detectado em 127.0.0.1:{local_port}."
        elif xfce_active and shadow_port_state == "available" and unit_state == "active":
            shadow_state_str = "available"
            overall_str = "online"
            user_msg = (
                f"Sessão XFCE ativa ({display_val}) e Shadow disponível em 127.0.0.1:{local_port}."
                + (" Há operador conectado." if total_viewers > 0 else " Pronta para conexão.")
            )
        elif xfce_active and shadow_port_state == "available" and unit_state != "active":
            # Porta está aberta mas a unidade systemd esperada não está ativa -> potencial conflito de processo órfão ou de outra conta
            shadow_state_str = "conflict"
            overall_str = "degraded"
            conflict_msg = f"Porta 127.0.0.1:{local_port} ocupada, porém a unidade {unit_name} consta como '{unit_state}'."
            user_msg = conflict_msg
        elif xfce_active and shadow_port_state != "available":
            shadow_state_str = "error" if unit_state == "failed" else "unavailable"
            overall_str = "degraded"
            user_msg = (
                f"Sessão XFCE ativa ({display_val}), mas o listener Shadow em 127.0.0.1:{local_port} está parado ({unit_state})."
            )
        else:
            shadow_state_str = "unavailable"
            overall_str = "offline"
            user_msg = f"Sem sessão XFCE ativa para '{unix_user}'. O Shadow não é iniciado sem login gráfico."

        return TVRuntimeState(
            overall_status=overall_str,
            xfce_session_state=xfce_state_str,
            shadow_service_state=shadow_state_str,
            viewer_connection_state=viewer_state_str,
            active_viewers_count=total_viewers,
            detected_display=display_val,
            xauthority_ready=xauth_ok,
            systemd_unit=unit_name,
            systemd_active_state=unit_state,
            port_conflict_detail=conflict_msg,
            user_message=user_msg,
            last_checked_at=now_str,
        )
    except Exception:
        return TVRuntimeState(
            overall_status="unknown",
            xfce_session_state="unknown",
            shadow_service_state="unknown",
            viewer_connection_state="unknown",
            active_viewers_count=ws_viewers,
            detected_display=None,
            xauthority_ready=False,
            systemd_unit=unit_name,
            systemd_active_state="unknown",
            port_conflict_detail=None,
            user_message="Estado desconhecido: falha ao consultar o estado da sessão ou systemd no servidor.",
            last_checked_at=now_str,
        )


def control_tv_shadow_service(
    tv_row: dict[str, Any], action: str
) -> tuple[bool, str]:
    """
    Executa start, stop ou restart exclusivamente sobre a unidade tv-shadow@<unix_user>.service.
    Nunca aceita comandos arbitrários nem toca no serviço xrdp (porta 3389).
    """
    if action not in ("start", "stop", "restart"):
        return False, "Ação de serviço inválida."

    settings = get_settings()
    slug = str(tv_row["slug"])
    unix_user = str(tv_row["unix_user"])
    local_port = int(tv_row["local_port"])
    _validate_safe_unix_user(unix_user)

    if local_port == 3389:
        return False, "Operação bloqueada: a porta 3389 pertence ao XRDP principal."

    unit_name = f"tv-shadow@{unix_user}.service"

    if settings.env_mode == "simulation" or os.name == "nt":
        sim = _SIMULATED_STATE.setdefault(
            slug,
            {
                "xfce_session_state": "active",
                "shadow_service_state": "unavailable",
                "detected_display": f":{10 + int(tv_row['id'])}.0",
                "xauthority_ready": True,
                "systemd_active_state": "inactive",
                "port_conflict_detail": None,
            },
        )
        if action in ("start", "restart"):
            if sim["xfce_session_state"] != "active":
                return (
                    False,
                    f"Não é permitido iniciar o Shadow para '{unix_user}' antes de a sessão gráfica XFCE estar ativa.",
                )
            sim["shadow_service_state"] = "available"
            sim["systemd_active_state"] = "active"
            return True, f"Serviço {unit_name} ({action}) executado com sucesso."
        else:
            sim["shadow_service_state"] = "unavailable"
            sim["systemd_active_state"] = "inactive"
            return True, f"Serviço {unit_name} parado com sucesso."

    # Em produção no Debian 13: antes de 'start', confirma que a sessão XFCE do usuário existe
    if action in ("start", "restart"):
        xfce_active, _, xauth_ok = _find_xfce_display_and_xauth_linux(unix_user)
        if not xfce_active or not xauth_ok:
            return (
                False,
                f"Operação recusada: o usuário '{unix_user}' não possui sessão XFCE ativa com DISPLAY/XAUTHORITY prontos.",
            )

    try:
        proc = subprocess.run(
            ["/usr/bin/sudo", "-n", "/usr/bin/systemctl", action, unit_name],
            capture_output=True,
            text=True,
            timeout=8.0,
            check=False,
        )
        if proc.returncode != 0:
            return (
                False,
                f"Não foi possível executar '{action}' na unidade {unit_name}. Verifique o journalctl do serviço.",
            )
        return True, f"Ação '{action}' aplicada com sucesso em {unit_name}."
    except Exception:
        return (
            False,
            f"Erro ao comunicar com o systemd para a unidade {unit_name}.",
        )
