#!/usr/bin/env bash
# /usr/local/libexec/tv-panel/tv-shadow-launch.sh
# Wrapper seguro para iniciar ou monitorar o FreeRDP Shadow anexado exclusivamente a uma sessão XFCE já ativa.
# Se a própria conexão XRDP da TV já tiver iniciado o freerdp-shadow-cli, adota e monitora o processo existente
# sem gerar conflito. Nunca cria sessão XRDP nova e nunca altera a porta 3389.

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

# 1. Consulta parâmetros validados no banco SQLite
if [[ ! -f "${DB_PATH}" ]]; then
    echo "[ERRO] Banco de inventário não encontrado em ${DB_PATH}." >&2
    exit 1
fi

SQL_QUERY="SELECT local_port, sec_mode, gfx_enabled, server_side_cursor, shadow_auth_enabled, enabled FROM tvs WHERE unix_user = '${TARGET_USER}' LIMIT 1;"
CONFIG_LINE="$(sqlite3 -readonly "${DB_PATH}" "${SQL_QUERY}" 2>/dev/null || sqlite3 "file:${DB_PATH}?immutable=1" "${SQL_QUERY}" 2>/dev/null || sqlite3 "${DB_PATH}" "${SQL_QUERY}" 2>/dev/null || true)"

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

if [[ ! "${LOCAL_PORT}" =~ ^[0-9]+$ ]] || (( LOCAL_PORT < 3390 || LOCAL_PORT > 3499 || LOCAL_PORT == 3389 )); then
    echo "[ERRO] Porta local inválida ou reservada: ${LOCAL_PORT}" >&2
    exit 1
fi

# 2. Aguarda até que a sessão gráfica XFCE/X11 do usuário esteja ativa (sem falhar no systemd)
XFCE_PID=""
while [[ -z "${XFCE_PID}" ]]; do
    XFCE_PID="$(pgrep -u "${TARGET_USER}" -f "xfce4-session|startxfce4|x-session-manager|xfwm4" | head -n 1 || true)"
    if [[ -z "${XFCE_PID}" ]]; then
        sleep 2
    fi
done

# 3. Se a própria conexão da TV (ex: .xsession / startwm.sh / autostart) já iniciou o freerdp-shadow-cli,
# adota e monitora o processo existente em vez de acusar conflito de porta.
EXISTING_SHADOW_PID="$(pgrep -u "${TARGET_USER}" -f "freerdp-shadow" | head -n 1 || true)"
if [[ -n "${EXISTING_SHADOW_PID}" ]]; then
    sleep 1
    if ss -H -tln "sport = :${LOCAL_PORT}" | grep -q .; then
        echo "[INFO] FreeRDP Shadow já iniciado pela conexão da TV (PID=${EXISTING_SHADOW_PID}) na porta ${LOCAL_PORT}. Monitorando..."
        while kill -0 "${EXISTING_SHADOW_PID}" 2>/dev/null && kill -0 "${XFCE_PID}" 2>/dev/null; do
            sleep 2
        done
        exit 0
    fi
    # Se havia um processo freerdp-shadow antigo preso em outra porta ou sem escutar, encerra-o para subir na porta correta
    kill -TERM "${EXISTING_SHADOW_PID}" 2>/dev/null || true
    sleep 1
fi

# Verifica se a porta está ocupada por outro usuário diferente
if ss -H -tln "sport = :${LOCAL_PORT}" | grep -q .; then
    EXISTING_SHADOW_PID="$(pgrep -u "${TARGET_USER}" -f "freerdp-shadow" | head -n 1 || true)"
    if [[ -n "${EXISTING_SHADOW_PID}" ]]; then
        echo "[INFO] FreeRDP Shadow ativo para '${TARGET_USER}' (PID=${EXISTING_SHADOW_PID}) na porta ${LOCAL_PORT}. Monitorando..."
        while kill -0 "${EXISTING_SHADOW_PID}" 2>/dev/null && kill -0 "${XFCE_PID}" 2>/dev/null; do
            sleep 2
        done
        exit 0
    fi
    echo "[ERRO] Conflito detectado: a porta ${LOCAL_PORT} já está em uso por outro processo." >&2
    sleep 3
    exit 1
fi

# 4. Descobre DISPLAY e XAUTHORITY da sessão gráfica existente do usuário
DETECTED_DISPLAY=""
DETECTED_XAUTH=""

# 4a. Lê o arquivo sincronizado pelo hook XDG autostart da sessão XFCE (~/.tv-shadow-env), se existir
if [[ -r "${HOME}/.tv-shadow-env" ]]; then
    DETECTED_DISPLAY="$(sed -n 's/^DISPLAY=//p' "${HOME}/.tv-shadow-env" | head -n 1 || true)"
    DETECTED_XAUTH="$(sed -n 's/^XAUTHORITY=//p' "${HOME}/.tv-shadow-env" | head -n 1 || true)"
fi

# 4b. Inspeciona sockets X11 em /tmp/.X11-unix/X* pertencentes ao UID deste usuário (funciona com yama.ptrace_scope=1)
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

# 4c. Inspeciona linha de comando do Xorg/Xvnc do usuário (sempre legível em /proc/<pid>/cmdline)
if [[ -z "${DETECTED_DISPLAY}" || -z "${DETECTED_XAUTH}" ]]; then
    while IFS= read -r cmdline; do
        if [[ -z "${DETECTED_DISPLAY}" ]] && [[ "${cmdline}" =~ (Xorg|Xvnc)[[:space:]]+:([0-9]+) ]]; then
            DETECTED_DISPLAY=":${BASH_REMATCH[2]}.0"
        fi
        if [[ -z "${DETECTED_XAUTH}" ]] && [[ "${cmdline}" =~ -auth[[:space:]]+([^[:space:]]+) ]]; then
            cand_auth="${BASH_REMATCH[1]}"
            if [[ "${cand_auth}" != /* ]]; then
                cand_auth="${HOME}/${cand_auth}"
            fi
            if [[ -r "${cand_auth}" ]]; then
                DETECTED_XAUTH="${cand_auth}"
            fi
        fi
    done < <(ps -u "${TARGET_USER}" -o args= 2>/dev/null || true)
fi

# 4d. Fallback via /proc/<pid>/environ caso permitido pelo kernel
if [[ -z "${DETECTED_DISPLAY}" || -z "${DETECTED_XAUTH}" ]]; then
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

# 5. Detecta automaticamente o binário do FreeRDP Shadow:
# Ubuntu 24.04 LTS instala /usr/bin/freerdp-shadow-cli (FreeRDP 2.11.5);
# Debian 13 instala /usr/bin/freerdp-shadow-cli3 ou FreeRDP 3.
SHADOW_BIN=""
IS_FREERDP3="0"

if [[ -x "/usr/bin/freerdp-shadow-cli3" ]]; then
    SHADOW_BIN="/usr/bin/freerdp-shadow-cli3"
    IS_FREERDP3="1"
elif [[ -x "/usr/bin/freerdp-shadow-cli" ]]; then
    SHADOW_BIN="/usr/bin/freerdp-shadow-cli"
    if dpkg-query -W -f='${Status}' freerdp3-shadow-x11 2>/dev/null | grep -q "install ok installed"; then
        IS_FREERDP3="1"
    fi
else
    echo "[ERRO] Binário freerdp-shadow-cli não encontrado. Instale freerdp2-shadow-x11 (Ubuntu 24.04) ou freerdp3-shadow-x11 (Debian 13)." >&2
    exit 1
fi

CERT_DIR="${HOME}/.config/freerdp/server"
mkdir -p "${CERT_DIR}" 2>/dev/null || true

if [[ "${IS_FREERDP3}" == "1" ]]; then
    # FreeRDP 3 exige geração prévia de certificado TLS X.509 em ~/.config/freerdp/server/
    if [[ ! -s "${CERT_DIR}/shadow.crt" || ! -s "${CERT_DIR}/shadow.key" ]]; then
        if command -v openssl >/dev/null 2>&1; then
            openssl req -x509 -nodes -newkey rsa:2048 \
                -keyout "${CERT_DIR}/shadow.key" \
                -out "${CERT_DIR}/shadow.crt" \
                -days 3650 -subj "/CN=127.0.0.1" >/dev/null 2>&1 || true
        fi
    fi
else
    # FreeRDP 2 (Ubuntu 24.04 LTS) possui gerador interno makecert (winpr) que cria shadow.crt/shadow.key
    # no formato RSA tradicional esperado pela libfreerdp-server2. Se houver chave PKCS#8 gerada pelo OpenSSL 3,
    # converte para RSA tradicional ou remove para que o próprio FreeRDP 2 gere nativamente.
    if [[ -f "${CERT_DIR}/shadow.key" ]] && grep -q "BEGIN PRIVATE KEY" "${CERT_DIR}/shadow.key" 2>/dev/null; then
        rm -f "${CERT_DIR}/shadow.key" "${CERT_DIR}/shadow.crt" 2>/dev/null || true
    fi
fi

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

# No FreeRDP 2 (Ubuntu 24.04 LTS), as flags -gfx / +server-side-cursor NÃO existem (causam erro de sintaxe).
if [[ "${IS_FREERDP3}" == "1" ]]; then
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
else
    case "${SEC_MODE}" in
        nla) ARGS+=("/sec:nla") ;;
        tls) ARGS+=("/sec:tls") ;;
        rdp|*) ARGS+=("/sec:rdp") ;;
    esac
fi

echo "[INFO] Anexando FreeRDP Shadow (${SHADOW_BIN}, FreeRDP3=${IS_FREERDP3}) ao DISPLAY=${DISPLAY} (XAUTHORITY=${XAUTHORITY:-padrao}, PID XFCE=${XFCE_PID}) em 127.0.0.1:${LOCAL_PORT}"

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
