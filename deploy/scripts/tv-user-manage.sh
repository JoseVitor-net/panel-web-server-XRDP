#!/usr/bin/env bash
# /usr/local/libexec/tv-panel/tv-user-manage.sh
# Cria o usuário Unix da TV (se não existir), preserva ~/.xsession existente (ou cria para XFCE4 se ausente),
# redefine a senha do usuário Unix via stdin e habilita a unidade tv-shadow@<user>.service.
# Nunca permite alterar contas administrativas ou de sistema.

set -euo pipefail

TARGET_USER="${1:-}"
DB_PATH="${TV_PANEL_DB_PATH:-/var/lib/tv-panel/tv_panel.db}"

if [[ -z "${TARGET_USER}" ]]; then
    echo "[ERRO] Usuário Unix não informado." >&2
    exit 1
fi

if [[ ! "${TARGET_USER}" =~ ^[a-z_][a-z0-9_-]{1,30}$ ]]; then
    echo "[ERRO] Formato de usuário Unix inválido." >&2
    exit 1
fi

case "${TARGET_USER}" in
    root|admin|administrator|ubuntu|user|debian|sudo|wheel|xrdp|guacd|tv-panel|postgres|www-data|nobody|daemon|sshd)
        echo "[ERRO] Operação bloqueada: conta de sistema/administrativa proibida (${TARGET_USER})." >&2
        exit 1
        ;;
esac

# Garante que o usuário consta no inventário autorizado de TVs do banco SQLite
if [[ -f "${DB_PATH}" ]] && command -v sqlite3 >/dev/null 2>&1; then
    SQL_CHECK="SELECT unix_user FROM tvs WHERE unix_user = '${TARGET_USER}' LIMIT 1;"
    AUTHORIZED="$(sqlite3 -readonly "${DB_PATH}" "${SQL_CHECK}" 2>/dev/null || sqlite3 "file:${DB_PATH}?immutable=1" "${SQL_CHECK}" 2>/dev/null || sqlite3 "${DB_PATH}" "${SQL_CHECK}" 2>/dev/null || true)"
    if [[ "${AUTHORIZED}" != "${TARGET_USER}" ]]; then
        echo "[ERRO] O usuário '${TARGET_USER}' não pertence ao inventário autorizado de TVs." >&2
        exit 1
    fi
fi

# Lê a nova senha da entrada padrão (stdin)
IFS= read -r NEW_PASSWORD || true

# 1. Cria o usuário Unix com diretório home se ainda não existir
if ! id -u "${TARGET_USER}" >/dev/null 2>&1; then
    useradd -m -s /bin/bash "${TARGET_USER}"
fi

# 2. Garante configuração do XRDP para abrir sessão XFCE4 SOMENTE se o usuário ainda não tiver um ~/.xsession customizado
if [[ -d "/home/${TARGET_USER}" ]] && [[ ! -s "/home/${TARGET_USER}/.xsession" ]]; then
    echo "xfce4-session" > "/home/${TARGET_USER}/.xsession"
    chown "${TARGET_USER}:${TARGET_USER}" "/home/${TARGET_USER}/.xsession"
    chmod 0644 "/home/${TARGET_USER}/.xsession"
fi

# 3. Se uma nova senha foi fornecida, redefine a senha da conta Unix da TV
if [[ -n "${NEW_PASSWORD}" ]]; then
    printf '%s:%s\n' "${TARGET_USER}" "${NEW_PASSWORD}" | chpasswd
fi

# 4. Habilita e inicia a unidade systemd tv-shadow@<usuario>.service
systemctl enable "tv-shadow@${TARGET_USER}.service" >/dev/null 2>&1 || true
systemctl start "tv-shadow@${TARGET_USER}.service" >/dev/null 2>&1 || true

echo "OK"
