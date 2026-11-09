#!/usr/bin/env bash
# /usr/local/libexec/tv-panel/tv-user-manage.sh
# Cria o usuário Unix da TV (se não existir), garante diretório home e ~/.xsession,
# redefine a senha do usuário Unix via stdin para login no XRDP e habilita tv-shadow@<user>.service.
# Nunca permite alterar contas administrativas ou de sistema (UID < 1000).

set -euo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

TARGET_USER="${1:-}"

if [[ -z "${TARGET_USER}" ]]; then
    echo "[ERRO] Usuário Unix não informado." >&2
    exit 1
fi

if [[ ! "${TARGET_USER}" =~ ^[a-z_][a-z0-9_-]{1,30}$ ]]; then
    echo "[ERRO] Formato de usuário Unix inválido: ${TARGET_USER}" >&2
    exit 1
fi

case "${TARGET_USER}" in
    root|admin|administrator|ubuntu|user|debian|sudo|wheel|xrdp|guacd|tv-panel|postgres|www-data|nobody|daemon|sshd|operador_noc)
        echo "[ERRO] Operação bloqueada: conta administrativa ou de sistema proibida (${TARGET_USER})." >&2
        exit 1
        ;;
esac

# Se a conta já existir no Linux, bloqueia qualquer conta de sistema (UID < 1000)
if id -u "${TARGET_USER}" >/dev/null 2>&1; then
    EXISTING_UID="$(id -u "${TARGET_USER}")"
    if (( EXISTING_UID < 1000 )); then
        echo "[ERRO] Operação bloqueada: a conta '${TARGET_USER}' possui UID de sistema (${EXISTING_UID})." >&2
        exit 1
    fi
fi

# Lê a nova senha da entrada padrão (stdin)
IFS= read -r NEW_PASSWORD || true
NEW_PASSWORD="${NEW_PASSWORD//$'\r'/}"

IS_NEW_USER="0"

# 1. Cria o usuário Unix com diretório home se ainda não existir
if ! id -u "${TARGET_USER}" >/dev/null 2>&1; then
    /usr/sbin/useradd -m -s /bin/bash "${TARGET_USER}"
    IS_NEW_USER="1"
fi

# Garante que o diretório home exista e pertença ao usuário da TV
if [[ ! -d "/home/${TARGET_USER}" ]]; then
    mkdir -p "/home/${TARGET_USER}"
    chown "${TARGET_USER}:${TARGET_USER}" "/home/${TARGET_USER}"
    chmod 0755 "/home/${TARGET_USER}"
fi

# 2. Garante ~/.xsession para abrir sessão XFCE4 no XRDP (preservando caso já exista customização)
if [[ ! -s "/home/${TARGET_USER}/.xsession" ]]; then
    echo "xfce4-session" > "/home/${TARGET_USER}/.xsession"
    chown "${TARGET_USER}:${TARGET_USER}" "/home/${TARGET_USER}/.xsession"
    chmod 0644 "/home/${TARGET_USER}/.xsession"
fi

# 3. Define/redefine a senha da conta Unix da TV para login XRDP
if [[ -n "${NEW_PASSWORD}" ]]; then
    printf '%s:%s\n' "${TARGET_USER}" "${NEW_PASSWORD}" | /usr/sbin/chpasswd
    /usr/sbin/usermod -U "${TARGET_USER}" 2>/dev/null || true
elif [[ "${IS_NEW_USER}" == "1" ]]; then
    # Se o usuário acabou de ser criado sem senha informada, define senha inicial padrão Tv@2026! para não ficar bloqueado no XRDP
    printf '%s:%s\n' "${TARGET_USER}" "Tv@2026!" | /usr/sbin/chpasswd
    /usr/sbin/usermod -U "${TARGET_USER}" 2>/dev/null || true
fi

# 4. Habilita e inicia a unidade systemd tv-shadow@<usuario>.service
systemctl enable "tv-shadow@${TARGET_USER}.service" >/dev/null 2>&1 || true
systemctl start "tv-shadow@${TARGET_USER}.service" >/dev/null 2>&1 || true

echo "OK"
