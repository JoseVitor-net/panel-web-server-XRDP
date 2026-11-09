import os
import pwd
import re
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Any

from app.config import get_settings
from app.schemas import (
    FORBIDDEN_UNIX_USERS,
    SystemOverviewTelemetry,
    TVRuntimeState,
    UNIX_USER_REGEX,
)
from app.security import iso_utc

# Registro em memória de conexões WebSocket ativas por TV ID
_ACTIVE_WS_VIEWERS: dict[int, int] = {}

# Cache leve de inspeção (evita dezenas de forks de subprocessos por requisição e elimina travamentos)
_RUNTIME_CACHE: dict[int, tuple[float, TVRuntimeState]] = {}
_CACHE_TTL_SECONDS = 2.0

# Cache de métricas de recursos por usuário e do sistema (CPU, RAM, Disco, Load)
_RESOURCE_CACHE: tuple[float, dict[str, Any]] | None = None
_PREV_CPU_TIMES: tuple[int, int] | None = None

# Cooldown para auto-start de unidades systemd (evita bloquear chamadas GET repetidamente)
_LAST_AUTOSTART_ATTEMPT: dict[str, float] = {}
_AUTOSTART_COOLDOWN_SECONDS = 45.0

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


def invalidate_runtime_cache(tv_id: int | None = None) -> None:
    global _RESOURCE_CACHE
    _RESOURCE_CACHE = None
    if tv_id is None:
        _RUNTIME_CACHE.clear()
    else:
        _RUNTIME_CACHE.pop(tv_id, None)


def _read_cpu_percent_delta() -> float:
    global _PREV_CPU_TIMES
    stat_path = Path("/proc/stat")
    if not stat_path.exists():
        return 0.0
    try:
        first_line = stat_path.read_text(encoding="utf-8").splitlines()[0]
        parts = [int(x) for x in first_line.split()[1:]]
        idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
        total = sum(parts)
        if _PREV_CPU_TIMES is None:
            _PREV_CPU_TIMES = (total, idle)
            time.sleep(0.04)
            first_line2 = stat_path.read_text(encoding="utf-8").splitlines()[0]
            parts2 = [int(x) for x in first_line2.split()[1:]]
            idle2 = parts2[3] + (parts2[4] if len(parts2) > 4 else 0)
            total2 = sum(parts2)
            _PREV_CPU_TIMES = (total2, idle2)
            dt = total2 - total
            di = idle2 - idle
            return round(max(0.0, min(100.0, (1.0 - (di / dt)) * 100.0)), 1) if dt > 0 else 0.0

        prev_total, prev_idle = _PREV_CPU_TIMES
        dt = total - prev_total
        di = idle - prev_idle
        _PREV_CPU_TIMES = (total, idle)
        if dt <= 0:
            return 0.0
        return round(max(0.0, min(100.0, (1.0 - (di / dt)) * 100.0)), 1)
    except Exception:
        return 0.0


def _collect_resource_snapshot() -> dict[str, Any]:
    """
    Coleta em uma única chamada rápida (cache de 2s) o consumo de CPU, RAM, Disco, Load Average,
    Uptime e o consumo detalhado por usuário Unix (incluindo o overhead específico do freerdp-shadow).
    """
    global _RESOURCE_CACHE
    now_mono = time.monotonic()
    if _RESOURCE_CACHE is not None and (now_mono - _RESOURCE_CACHE[0]) < _CACHE_TTL_SECONDS:
        return _RESOURCE_CACHE[1]

    settings = get_settings()
    cpu_cores = max(1, os.cpu_count() or 2)
    hostname = socket.gethostname() or "serverxrd"

    if settings.env_mode == "simulation" or os.name == "nt":
        snap = {
            "hostname": hostname,
            "cpu_cores": cpu_cores,
            "cpu_percent": 18.4,
            "load_avg": (0.72, 0.58, 0.45),
            "mem_total_mb": 8192.0,
            "mem_used_mb": 1940.0,
            "mem_available_mb": 6252.0,
            "mem_percent": 23.7,
            "swap_total_mb": 2048.0,
            "swap_used_mb": 0.0,
            "swap_percent": 0.0,
            "disk_total_gb": 40.0,
            "disk_used_gb": 11.4,
            "disk_percent": 28.5,
            "uptime_seconds": 86400,
            "users": {
                "tv01": {
                    "cpu_percent": 6.4,
                    "memory_mb": 420.5,
                    "memory_percent": 5.1,
                    "process_count": 28,
                    "shadow_cpu_percent": 1.8,
                    "shadow_memory_mb": 34.2,
                },
                "tv02": {
                    "cpu_percent": 4.2,
                    "memory_mb": 365.0,
                    "memory_percent": 4.5,
                    "process_count": 24,
                    "shadow_cpu_percent": 1.1,
                    "shadow_memory_mb": 29.8,
                },
                "tv03": {
                    "cpu_percent": 5.1,
                    "memory_mb": 392.0,
                    "memory_percent": 4.8,
                    "process_count": 26,
                    "shadow_cpu_percent": 1.4,
                    "shadow_memory_mb": 31.5,
                },
            },
        }
        _RESOURCE_CACHE = (now_mono, snap)
        return snap

    # 1. Memória RAM e Swap (/proc/meminfo)
    mem_total_kb = 0
    mem_avail_kb = 0
    swap_total_kb = 0
    swap_free_kb = 0
    try:
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            if line.startswith("MemTotal:"):
                mem_total_kb = int(line.split()[1])
            elif line.startswith("MemAvailable:"):
                mem_avail_kb = int(line.split()[1])
            elif line.startswith("SwapTotal:"):
                swap_total_kb = int(line.split()[1])
            elif line.startswith("SwapFree:"):
                swap_free_kb = int(line.split()[1])
    except Exception:
        pass

    mem_total_mb = round(mem_total_kb / 1024.0, 1) if mem_total_kb > 0 else 1024.0
    mem_avail_mb = round(mem_avail_kb / 1024.0, 1)
    mem_used_mb = round(max(0.0, mem_total_mb - mem_avail_mb), 1)
    mem_percent = round((mem_used_mb / mem_total_mb) * 100.0, 1) if mem_total_mb > 0 else 0.0

    swap_total_mb = round(swap_total_kb / 1024.0, 1)
    swap_used_mb = round(max(0.0, (swap_total_kb - swap_free_kb) / 1024.0), 1)
    swap_percent = round((swap_used_mb / swap_total_mb) * 100.0, 1) if swap_total_mb > 0 else 0.0

    # 2. Load average e Uptime
    load_1, load_5, load_15 = 0.0, 0.0, 0.0
    try:
        la_parts = Path("/proc/loadavg").read_text(encoding="utf-8").split()
        load_1, load_5, load_15 = round(float(la_parts[0]), 2), round(float(la_parts[1]), 2), round(float(la_parts[2]), 2)
    except Exception:
        pass

    uptime_seconds = 0
    try:
        uptime_seconds = int(float(Path("/proc/uptime").read_text(encoding="utf-8").split()[0]))
    except Exception:
        pass

    # 3. Uso de disco em /
    disk_total_gb, disk_used_gb, disk_percent = 0.0, 0.0, 0.0
    try:
        du = shutil.disk_usage("/")
        disk_total_gb = round(du.total / (1024.0 ** 3), 2)
        disk_used_gb = round(du.used / (1024.0 ** 3), 2)
        disk_percent = round((du.used / du.total) * 100.0, 1) if du.total > 0 else 0.0
    except Exception:
        pass

    # 4. Processos por usuário via `ps -eo user:32,pcpu,rss,comm --no-headers`
    users_map: dict[str, dict[str, Any]] = {}
    try:
        ps_proc = subprocess.run(
            ["/usr/bin/ps", "-eo", "user:32,pcpu,rss,comm", "--no-headers"],
            capture_output=True,
            text=True,
            timeout=1.5,
            check=False,
        )
        if ps_proc.returncode == 0:
            for line in ps_proc.stdout.splitlines():
                parts = line.split(None, 3)
                if len(parts) < 4:
                    continue
                u_name, pcpu_str, rss_str, comm_str = parts[0], parts[1], parts[2], parts[3]
                try:
                    pcpu_val = float(pcpu_str)
                    rss_kb = int(rss_str)
                except ValueError:
                    continue

                entry = users_map.setdefault(
                    u_name,
                    {
                        "raw_cpu": 0.0,
                        "rss_kb": 0,
                        "process_count": 0,
                        "shadow_raw_cpu": 0.0,
                        "shadow_rss_kb": 0,
                    },
                )
                entry["raw_cpu"] += pcpu_val
                entry["rss_kb"] += rss_kb
                entry["process_count"] += 1
                if "freerdp-shadow" in comm_str:
                    entry["shadow_raw_cpu"] += pcpu_val
                    entry["shadow_rss_kb"] += rss_kb
    except Exception:
        pass

    formatted_users: dict[str, dict[str, Any]] = {}
    for u_name, data in users_map.items():
        u_mem_mb = round(data["rss_kb"] / 1024.0, 1)
        u_mem_pct = round((u_mem_mb / mem_total_mb) * 100.0, 1) if mem_total_mb > 0 else 0.0
        # Normaliza CPU pela quantidade de núcleos para manter escala 0-100% do servidor
        u_cpu_pct = round(min(100.0, data["raw_cpu"] / cpu_cores), 1)
        sh_cpu_pct = round(min(100.0, data["shadow_raw_cpu"] / cpu_cores), 1)
        sh_mem_mb = round(data["shadow_rss_kb"] / 1024.0, 1)
        formatted_users[u_name] = {
            "cpu_percent": u_cpu_pct,
            "memory_mb": u_mem_mb,
            "memory_percent": u_mem_pct,
            "process_count": int(data["process_count"]),
            "shadow_cpu_percent": sh_cpu_pct,
            "shadow_memory_mb": sh_mem_mb,
        }

    host_cpu_pct = _read_cpu_percent_delta()
    sum_users_cpu = round(min(100.0, sum(u["cpu_percent"] for u in formatted_users.values())), 1)
    if host_cpu_pct < sum_users_cpu:
        host_cpu_pct = sum_users_cpu

    snap = {
        "hostname": hostname,
        "cpu_cores": cpu_cores,
        "cpu_percent": host_cpu_pct,
        "load_avg": (load_1, load_5, load_15),
        "mem_total_mb": mem_total_mb,
        "mem_used_mb": mem_used_mb,
        "mem_available_mb": mem_avail_mb,
        "mem_percent": mem_percent,
        "swap_total_mb": swap_total_mb,
        "swap_used_mb": swap_used_mb,
        "swap_percent": swap_percent,
        "disk_total_gb": disk_total_gb,
        "disk_used_gb": disk_used_gb,
        "disk_percent": disk_percent,
        "uptime_seconds": uptime_seconds,
        "users": formatted_users,
    }
    _RESOURCE_CACHE = (now_mono, snap)
    return snap


def inspect_system_overview(tv_rows: list[dict[str, Any]]) -> SystemOverviewTelemetry:
    """
    Retorna a telemetria global do servidor Linux e o comparativo direto entre o consumo
    agregado de todas as sessões de TV vs. o restante do sistema operacional.
    """
    snap = _collect_resource_snapshot()
    users_Resource = snap["users"]
    mem_total_mb = float(snap["mem_total_mb"])
    mem_used_mb = float(snap["mem_used_mb"])
    mem_avail_mb = float(snap["mem_available_mb"])
    host_cpu_pct = float(snap["cpu_percent"])

    tv_users = {str(r["unix_user"]) for r in tv_rows}
    tvs_cpu = 0.0
    tvs_mem_mb = 0.0
    active_sessions = 0

    for u in tv_users:
        u_metrics = users_Resource.get(u)
        if u_metrics and u_metrics["process_count"] > 0:
            active_sessions += 1
            tvs_cpu += float(u_metrics["cpu_percent"])
            tvs_mem_mb += float(u_metrics["memory_mb"])

    tvs_cpu = round(min(100.0, tvs_cpu), 1)
    tvs_mem_mb = round(tvs_mem_mb, 1)
    tvs_mem_pct = round((tvs_mem_mb / mem_total_mb) * 100.0, 1) if mem_total_mb > 0 else 0.0

    other_cpu = round(max(0.0, host_cpu_pct - tvs_cpu), 1)
    other_mem_mb = round(max(0.0, mem_used_mb - tvs_mem_mb), 1)
    other_mem_pct = round((other_mem_mb / mem_total_mb) * 100.0, 1) if mem_total_mb > 0 else 0.0

    avg_tv_cpu = round(tvs_cpu / active_sessions, 1) if active_sessions > 0 else 0.0
    avg_tv_mem = round(tvs_mem_mb / active_sessions, 1) if active_sessions > 0 else 280.0
    baseline_per_tv_mb = max(180.0, avg_tv_mem)
    usable_free_mb = max(0.0, mem_avail_mb - 512.0)  # reserva de segurança de 512 MB para o SO
    extra_capacity = int(usable_free_mb // baseline_per_tv_mb)

    la1, la5, la15 = snap["load_avg"]
    return SystemOverviewTelemetry(
        hostname=str(snap["hostname"]),
        cpu_cores=int(snap["cpu_cores"]),
        cpu_percent=host_cpu_pct,
        load_avg_1m=la1,
        load_avg_5m=la5,
        load_avg_15m=la15,
        mem_total_mb=mem_total_mb,
        mem_used_mb=mem_used_mb,
        mem_available_mb=mem_avail_mb,
        mem_percent=float(snap["mem_percent"]),
        swap_total_mb=float(snap["swap_total_mb"]),
        swap_used_mb=float(snap["swap_used_mb"]),
        swap_percent=float(snap["swap_percent"]),
        disk_total_gb=float(snap["disk_total_gb"]),
        disk_used_gb=float(snap["disk_used_gb"]),
        disk_percent=float(snap["disk_percent"]),
        uptime_seconds=int(snap["uptime_seconds"]),
        tvs_total_cpu_percent=tvs_cpu,
        tvs_total_memory_mb=tvs_mem_mb,
        tvs_total_memory_percent=tvs_mem_pct,
        other_system_cpu_percent=other_cpu,
        other_system_memory_mb=other_mem_mb,
        other_system_memory_percent=other_mem_pct,
        active_tv_sessions_count=active_sessions,
        avg_tv_cpu_percent=avg_tv_cpu,
        avg_tv_memory_mb=round(tvs_mem_mb / active_sessions, 1) if active_sessions > 0 else 0.0,
        estimated_extra_tvs_capacity=extra_capacity,
        timestamp=iso_utc(),
    )


def register_ws_viewer(tv_id: int) -> None:
    _ACTIVE_WS_VIEWERS[tv_id] = _ACTIVE_WS_VIEWERS.get(tv_id, 0) + 1
    invalidate_runtime_cache(tv_id)


def unregister_ws_viewer(tv_id: int) -> None:
    current = _ACTIVE_WS_VIEWERS.get(tv_id, 0)
    if current <= 1:
        _ACTIVE_WS_VIEWERS.pop(tv_id, None)
    else:
        _ACTIVE_WS_VIEWERS[tv_id] = current - 1
    invalidate_runtime_cache(tv_id)


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
        f"/sec:{sec_mode} {gfx_flag} {cursor_flag} +may-view +may-interact"
    )


def _validate_safe_unix_user(unix_user: str) -> None:
    if not UNIX_USER_REGEX.match(unix_user) or unix_user in FORBIDDEN_UNIX_USERS:
        raise ValueError("Usuário Unix inválido ou proibido para operação.")


def provision_tv_unix_user(unix_user: str, unix_password: str = "") -> tuple[bool, str]:
    """
    Garante que o usuário Unix da TV exista no servidor Linux, possua ~/.xsession (xfce4-session)
    e, se unix_password for informado, redefine a senha da conta Unix da TV para login no XRDP.
    """
    _validate_safe_unix_user(unix_user)
    settings = get_settings()
    if settings.env_mode == "simulation" or os.name == "nt":
        return True, "Provisionamento simulado concluído."

    helper_path = "/usr/local/libexec/tv-panel/tv-user-manage.sh"
    if not Path(helper_path).exists():
        return False, "Script tv-user-manage.sh não encontrado em /usr/local/libexec/tv-panel/."

    clean_pw = (unix_password or "").replace("\r", "").replace("\n", "")
    try:
        proc = subprocess.run(
            ["/usr/bin/sudo", "-n", helper_path, unix_user],
            input=f"{clean_pw}\n",
            capture_output=True,
            text=True,
            timeout=8.0,
            check=False,
        )
        if proc.returncode != 0:
            err_detail = (proc.stderr or proc.stdout or "").strip()
            return False, err_detail or f"Falha ao provisionar usuário Unix '{unix_user}'."
        return True, f"Usuário Unix '{unix_user}' provisionado com sucesso."
    except Exception as exc:
        return False, f"Erro ao executar provisionamento do usuário '{unix_user}': {exc}"


def _find_xfce_display_and_xauth_linux(unix_user: str) -> tuple[bool, str | None, bool]:
    """
    Inspeciona no Debian 13 se o usuário possui uma sessão gráfica XFCE/XRDP ativa
    e descobre o número real do DISPLAY (ex: :10.0, :11.0, :12.0) mesmo sem privilégio de root.
    """
    try:
        pw_entry = pwd.getpwnam(unix_user)
        user_uid = pw_entry.pw_uid
    except KeyError:
        return False, None, False

    proc = subprocess.run(
        [
            "/usr/bin/pgrep",
            "-u",
            unix_user,
            "-f",
            "xfce4-session|startxfce4|x-session-manager|xfwm4",
        ],
        capture_output=True,
        text=True,
        timeout=1.5,
        check=False,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        return False, None, False

    # 1. Descobre o número do display pelos sockets /tmp/.X11-unix/X* pertencentes ao UID do usuário
    x11_dir = Path("/tmp/.X11-unix")
    if x11_dir.is_dir():
        try:
            for sock_path in sorted(x11_dir.glob("X*")):
                m = re.match(r"^X(\d+)$", sock_path.name)
                if m and sock_path.stat().st_uid == user_uid:
                    return True, f":{m.group(1)}.0", True
        except OSError:
            pass

    # 2. Fallback rápido via argumentos do processo Xorg / Xvnc do usuário
    ps_proc = subprocess.run(
        ["/usr/bin/ps", "-u", unix_user, "-o", "args="],
        capture_output=True,
        text=True,
        timeout=1.5,
        check=False,
    )
    if ps_proc.returncode == 0:
        for line in ps_proc.stdout.splitlines():
            m = re.search(r"(?:Xorg|Xvnc)\s+:(\d+)", line)
            if m:
                return True, f":{m.group(1)}.0", True

    return True, ":10.0", True


def _inspect_shadow_port_linux(local_port: int, unix_user: str | None = None) -> tuple[str, str | None, int]:
    """
    Verifica na pilha TCP local (ss) se a porta Shadow está ouvindo (seja iniciada pela própria
    conexão da TV ou pela unidade tv-shadow@.service) e quantas conexões estabelecidas existem.
    """
    ss_bin = "/usr/bin/ss" if Path("/usr/bin/ss").exists() else "/bin/ss"
    target_port = local_port

    listen_proc = subprocess.run(
        [ss_bin, "-H", "-tln", f"sport = :{target_port}"],
        capture_output=True,
        text=True,
        timeout=1.5,
        check=False,
    )
    if listen_proc.returncode != 0:
        raise RuntimeError("Falha ao consultar sockets TCP de escuta.")

    lines = [ln.strip() for ln in listen_proc.stdout.splitlines() if ln.strip()]

    # Se a conexão da TV iniciou o freerdp-shadow-cli automaticamente em outra porta (/port:XXXX), detecta-a
    if not lines and unix_user:
        ps_proc = subprocess.run(
            ["/usr/bin/ps", "-u", unix_user, "-o", "args="],
            capture_output=True,
            text=True,
            timeout=1.5,
            check=False,
        )
        if ps_proc.returncode == 0:
            for cmd in ps_proc.stdout.splitlines():
                if "freerdp-shadow" in cmd:
                    m = re.search(r"/port:(\d+)", cmd)
                    if m:
                        cand_port = int(m.group(1))
                        if cand_port != 3389:
                            alt_proc = subprocess.run(
                                [ss_bin, "-H", "-tln", f"sport = :{cand_port}"],
                                capture_output=True,
                                text=True,
                                timeout=1.5,
                                check=False,
                            )
                            alt_lines = [ln.strip() for ln in alt_proc.stdout.splitlines() if ln.strip()]
                            if alt_lines:
                                lines = alt_lines
                                target_port = cand_port
                                break

    if not lines:
        return "unavailable", None, 0

    estab_proc = subprocess.run(
        [ss_bin, "-H", "-tn", "state", "established", f"sport = :{target_port}"],
        capture_output=True,
        text=True,
        timeout=1.5,
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
        timeout=1.5,
        check=False,
    )
    state = proc.stdout.strip() or "unknown"
    return unit_name, state


def inspect_tv_runtime(tv_row: dict[str, Any], *, force_refresh: bool = False) -> TVRuntimeState:
    """
    Inspeciona o estado real da TV separando estritamente:
    1. Sessão gráfica XFCE (active / inactive / unknown)
    2. Serviço FreeRDP Shadow na porta local (available / unavailable / conflict / error / unknown)
    3. Espectador conectado (connected / idle / unknown)
    Usa cache curto em produção para responder instantaneamente e não travar o painel.
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

        res_snap = _collect_resource_snapshot()
        u_res = res_snap["users"].get(unix_user, {})
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
            cpu_percent=float(u_res.get("cpu_percent", 0.0)),
            memory_mb=float(u_res.get("memory_mb", 0.0)),
            memory_percent=float(u_res.get("memory_percent", 0.0)),
            process_count=int(u_res.get("process_count", 0)),
            shadow_cpu_percent=float(u_res.get("shadow_cpu_percent", 0.0)),
            shadow_memory_mb=float(u_res.get("shadow_memory_mb", 0.0)),
        )

    now_mono = time.monotonic()
    if not force_refresh and tv_id in _RUNTIME_CACHE:
        cached_at, cached_state = _RUNTIME_CACHE[tv_id]
        if (now_mono - cached_at) < _CACHE_TTL_SECONDS:
            return cached_state

    # Modo Produção (Debian 13 Linux)
    try:
        _validate_safe_unix_user(unix_user)
        xfce_active, display_val, xauth_ok = _find_xfce_display_and_xauth_linux(unix_user)
        unit_name, unit_state = _inspect_systemd_unit_linux(unix_user)
        shadow_port_state, conflict_msg, tcp_estab = _inspect_shadow_port_linux(local_port, unix_user)

        # Auto-ativação não-bloqueante com cooldown de 45s (evita travar a API em polls sucessivos)
        if xfce_active and shadow_port_state == "unavailable" and unit_state in ("inactive", "failed"):
            last_try = _LAST_AUTOSTART_ATTEMPT.get(unix_user, 0.0)
            if (now_mono - last_try) >= _AUTOSTART_COOLDOWN_SECONDS:
                _LAST_AUTOSTART_ATTEMPT[unix_user] = now_mono
                try:
                    subprocess.Popen(
                        ["/usr/bin/sudo", "-n", "/usr/bin/systemctl", "start", unit_name],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    unit_state = "activating"
                except Exception:
                    pass

        xfce_state_str = "active" if xfce_active else "inactive"
        total_viewers = max(ws_viewers, tcp_estab)
        viewer_state_str = "connected" if total_viewers > 0 else "idle"

        if shadow_port_state == "conflict":
            shadow_state_str = "conflict"
            overall_str = "degraded"
            user_msg = conflict_msg or f"Conflito de porta detectado em 127.0.0.1:{local_port}."
        elif xfce_active and shadow_port_state == "available":
            shadow_state_str = "available"
            overall_str = "online"
            user_msg = (
                f"Sessão XFCE ativa ({display_val}) e Shadow disponível em 127.0.0.1:{local_port}."
                + (" Há operador conectado." if total_viewers > 0 else " Pronta para conexão.")
            )
        elif xfce_active and shadow_port_state != "available":
            shadow_state_str = (
                "starting"
                if unit_state in ("activating", "active")
                else ("error" if unit_state == "failed" else "unavailable")
            )
            overall_str = "degraded"
            user_msg = (
                f"Sessão XFCE ativa ({display_val}), aguardando listener Shadow em 127.0.0.1:{local_port} ({unit_state})."
            )
        else:
            shadow_state_str = "unavailable"
            overall_str = "offline"
            user_msg = f"Sem sessão XFCE ativa para '{unix_user}'. O Shadow aguarda login gráfico."

        res_snap = _collect_resource_snapshot()
        u_res = res_snap["users"].get(unix_user, {})
        result = TVRuntimeState(
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
            cpu_percent=float(u_res.get("cpu_percent", 0.0)),
            memory_mb=float(u_res.get("memory_mb", 0.0)),
            memory_percent=float(u_res.get("memory_percent", 0.0)),
            process_count=int(u_res.get("process_count", 0)),
            shadow_cpu_percent=float(u_res.get("shadow_cpu_percent", 0.0)),
            shadow_memory_mb=float(u_res.get("shadow_memory_mb", 0.0)),
        )
        _RUNTIME_CACHE[tv_id] = (now_mono, result)
        return result
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
    tv_id = int(tv_row["id"])
    slug = str(tv_row["slug"])
    unix_user = str(tv_row["unix_user"])
    local_port = int(tv_row["local_port"])
    _validate_safe_unix_user(unix_user)

    if local_port == 3389:
        return False, "Operação bloqueada: a porta 3389 pertence ao XRDP principal."

    unit_name = f"tv-shadow@{unix_user}.service"
    invalidate_runtime_cache(tv_id)

    if settings.env_mode == "simulation" or os.name == "nt":
        sim = _SIMULATED_STATE.setdefault(
            slug,
            {
                "xfce_session_state": "active",
                "shadow_service_state": "unavailable",
                "detected_display": f":{10 + tv_id}.0",
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

    if action in ("start", "restart"):
        xfce_active, _, xauth_ok = _find_xfce_display_and_xauth_linux(unix_user)
        if not xfce_active or not xauth_ok:
            return (
                False,
                f"Operação recusada: o usuário '{unix_user}' não possui sessão XFCE ativa no momento.",
            )

    try:
        proc = subprocess.run(
            ["/usr/bin/sudo", "-n", "/usr/bin/systemctl", action, unit_name],
            capture_output=True,
            text=True,
            timeout=6.0,
            check=False,
        )
        invalidate_runtime_cache(tv_id)
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
