#!/usr/bin/env bash
# /usr/local/libexec/tv-panel/tv-shadow-launch.sh
# Wrapper seguro para iniciar o FreeRDP Shadow anexado exclusivamente a uma sessão XFCE já ativa.
# Nunca inicia antes do login gráfico, nunca cria sessão XRDP nova e nunca altera a porta 3389.

set -euo pipefail

TARGET_USER="${1:-}"
DB_PATH="${TV_PANEL_DB_PATH:-/var/lib/tv-panel/tv_panel.db}"

if [[ -z "${TARGET_USER}" ]]; then
    echo "[ERRO] Usuário Unix não informado." >&2
    exit 1
fi

if [[ ! "${TARGET_USER}" =~ ^[a-z_][a-z0-9_-]{1,30}$ ]] || [[ "${TARGET_USER}" == "root" ]]; then
    echo "[ERRO] Usuário Unix inválido ou proibido: ${TARGET_USER}" >&2
    exit 1
fi

if [[ "$(id -un)" != "${TARGET_USER}" ]]; then
    echo "[ERRO] Este script deve ser executado sob a conta Unix '${TARGET_USER}' (atual: $(id -un))." >&2
    exit 1
fi

USER_UID="$(id -u "${TARGET_USER}")"

# 1. Consulta parâmetros validados no banco SQLite usando URI immutable=1
# (evita erro de permissão de escrita em arquivos -wal/-shm no diretório /var/lib/tv-panel)
if [[ ! -f "${DB_PATH}" ]]; then
    echo "[ERRO] Banco de inventário não encontrado em ${DB_PATH}." >&2
    exit 1
fi

CONFIG_LINE="$(sqlite3 "file:${DB_PATH}?immutable=1" \
    "SELECT local_port, sec_mode, gfx_enabled, server_side_cursor, shadow_auth_enabled, enabled FROM tvs WHERE unix_user = '${TARGET_USER}' LIMIT 1;" 2>/dev/null || true)"

if [[ -z "${CONFIG_LINE}" ]]; then
    echo "[ERRO] Usuário '${TARGET_USER}' não consta no inventário autorizado de TVs." >&2
    exit 1
fi

IFS='|' read -r LOCAL_PORT SEC_MODE GFX_ENABLED CURSOR_ENABLED AUTH_ENABLED TV_ENABLED <<< "${CONFIG_LINE}"

if [[ "${TV_ENABLED}" != "1" ]]; then
    echo "[INFO] TV associada ao usuário '${TARGET_USER}' está desabilitada no painel. Aguardando..."
    sleep 5
    exit 0
fi

if [[ ! "${LOCAL_PORT}" =~ ^[0-9]+$ ]] || (( LOCAL_PORT < 3391 || LOCAL_PORT > 3499 || LOCAL_PORT == 3389 )); then
    echo "[ERRO] Porta local inválida ou reservada: ${LOCAL_PORT}" >&2
    exit 1
fi

# 2. Aguarda até que a sessão gráfica XFCE do usuário esteja ativa (sem falhar no systemd)
XFCE_PID=""
while [[ -z "${XFCE_PID}" ]]; do
    XFCE_PID="$(pgrep -u "${TARGET_USER}" -f "xfce4-session|startxfce4|x-session-manager|xfwm4" | head -n 1 || true)"
    if [[ -z "${XFCE_PID}" ]]; then
        sleep 3
    fi
done

# 3. Verifica conflitos de porta antes de iniciar
if ss -H -tln "sport = :${LOCAL_PORT}" | grep -q .; then
    echo "[ERRO] Conflito detectado: a porta 127.0.0.1:${LOCAL_PORT} já está em uso por outro processo." >&2
    sleep 3
    exit 1
fi

# 4. Descobre DISPLAY e XAUTHORITY da sessão gráfica existente do usuário
DETECTED_DISPLAY=""
DETECTED_XAUTH=""

# Varre os processos do próprio usuário em busca de DISPLAY e XAUTHORITY
for pid in $(pgrep -u "${TARGET_USER}" || true); do
    if [[ -r "/proc/${pid}/environ" ]]; then
        if [[ -z "${DETECTED_DISPLAY}" ]]; then
            DETECTED_DISPLAY="$({ tr '\0' '\n' < "/proc/${pid}/environ"; } 2>/dev/null | sed -n 's/^DISPLAY=//p' | head -n 1 || true)"
        fi
        if [[ -z "${DETECTED_XAUTH}" ]]; then
            DETECTED_XAUTH="$({ tr '\0' '\n' < "/proc/${pid}/environ"; } 2>/dev/null | sed -n 's/^XAUTHORITY=//p' | head -n 1 || true)"
        fi
        if [[ -n "${DETECTED_DISPLAY}" && -n "${DETECTED_XAUTH}" ]]; then
            break
        fi
    fi
done

# Fallback: verifica qual socket /tmp/.X11-unix/X* pertence ao UID deste usuário
if [[ -z "${DETECTED_DISPLAY}" ]] && [[ -d /tmp/.X11-unix ]]; then
    for sock in /tmp/.X11-unix/X*; do
        [[ -e "${sock}" ]] || continue
        if [[ "$(stat -c '%u' "${sock}" 2>/dev/null || echo '')" == "${USER_UID}" ]]; then
            disp_num="${sock##*/tmp/.X11-unix/X}"
            DETECTED_DISPLAY=":${disp_num}.0"
            break
        fi
    done
fi

if [[ -z "${DETECTED_DISPLAY}" ]]; then
    echo "[AVISO] Sessão XFCE encontrada (PID ${XFCE_PID}), mas DISPLAY ainda não disponível. Tentando novamente em 2s..." >&2
    sleep 2
    exit 0
fi

if [[ -z "${DETECTED_XAUTH}" || ! -r "${DETECTED_XAUTH}" ]]; then
    if [[ -r "${HOME}/.Xauthority" ]]; then
        DETECTED_XAUTH="${HOME}/.Xauthority"
    fi
fi

export DISPLAY="${DETECTED_DISPLAY}"
if [[ -n "${DETECTED_XAUTH}" && -r "${DETECTED_XAUTH}" ]]; then
    export XAUTHORITY="${DETECTED_XAUTH}"
fi

# 5. Monta argumentos fixos do freerdp-shadow-cli3
SHADOW_BIN="/usr/bin/freerdp-shadow-cli3"
if [[ ! -x "${SHADOW_BIN}" ]]; then
    echo "[ERRO] Binário ${SHADOW_BIN} não encontrado. Instale o pacote freerdp3-shadow-x11." >&2
    exit 1
fi

# Garante diretório de certificado TLS local do FreeRDP 3 no HOME do usuário da TV
mkdir -p "${HOME}/.config/freerdp/server" 2>/dev/null || true

ARGS=(
    "/port:${LOCAL_PORT}"
    "/bind-address:127.0.0.1"
    "+may-view"
    "+may-interact"
)

if [[ "${AUTH_ENABLED}" == "1" ]]; then
    ARGS+=("+auth")
else
    ARGS+=("-auth")
fi

# No FreeRDP 3.15 (Debian 13), /sec:rdp em 127.0.0.1 desativa a criptografia RDP ("Turning off encryption for local peer")
# e causa erro BIO_read no guacd. Usando TLS padrão do FreeRDP 3 (ou /sec:tls), o handshake com guacd funciona sem queda.
case "${SEC_MODE}" in
    nla) ARGS+=("/sec:nla") ;;
    tls|rdp|*) ARGS+=("/sec:tls") ;;
esac

if [[ "${GFX_ENABLED}" == "1" ]]; then
    ARGS+=("-gfx")
else
    ARGS+=("+gfx")
fi

if [[ "${CURSOR_ENABLED}" == "1" ]]; then
    ARGS+=("+server-side-cursor")
else
    ARGS+=("-server-side-cursor")
fi

echo "[INFO] Anexando FreeRDP Shadow ao DISPLAY=${DISPLAY} (XAUTHORITY=${XAUTHORITY:-padrao}, PID XFCE=${XFCE_PID}) em 127.0.0.1:${LOCAL_PORT}"

# 6. Inicia o FreeRDP Shadow em background e monitora o PID da sessão XFCE:
# se a sessão gráfica XFCE encerrar, o Shadow para imediatamente.
"${SHADOW_BIN}" "${ARGS[@]}" &
SHADOW_PID=$!

cleanup() {
    if kill -0 "${SHADOW_PID}" 2>/dev/null; then
        kill -TERM "${SHADOW_PID}" 2>/dev/null || true
        wait "${SHADOW_PID}" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

while kill -0 "${SHADOW_PID}" 2>/dev/null; do
    if ! kill -0 "${XFCE_PID}" 2>/dev/null; then
        echo "[INFO] A sessão gráfica XFCE (PID ${XFCE_PID}) foi encerrada. Parando o serviço Shadow."
        cleanup
        exit 0
    fi
    sleep 2
done

wait "${SHADOW_PID}" || true
