#!/usr/bin/env bash
# deploy/scripts/install-debian13.sh
# Script de instalação reproduzível do Painel TV Shadow RDP no Debian 13 (Trixie).
# Preserva integralmente o XRDP existente na porta 3389.

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
    echo "Execute este script como root (ou via sudo) no servidor Debian 13." >&2
    exit 1
fi

INSTALL_DIR="/opt/tv-panel"
DATA_DIR="/var/lib/tv-panel"
CONFIG_DIR="/etc/tv-panel"
LIBEXEC_DIR="/usr/local/libexec/tv-panel"
SRC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "[1/8] Verificando que o serviço XRDP (3389) não será alterado..."
if systemctl is-active --quiet xrdp.service; then
    echo "  -> xrdp.service está ativo na porta 3389 e será preservado."
fi

echo "[2/8] Instalando dependências de sistema (sem tocar em xrdp)..."
apt-get update
if apt-cache show freerdp2-shadow-x11 >/dev/null 2>&1; then
    SHADOW_PKG="freerdp2-shadow-x11"
else
    SHADOW_PKG="freerdp3-shadow-x11"
fi
apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip sqlite3 \
    "${SHADOW_PKG}" iproute2 procps sudo ca-certificates curl

echo "[3/8] Criando usuário dedicado sem privilégios 'tv-panel'..."
if ! id -u tv-panel >/dev/null 2>&1; then
    useradd --system --home-dir "${DATA_DIR}" --shell /usr/sbin/nologin tv-panel
fi

echo "[4/8] Preparando diretórios e copiando arquivos..."
mkdir -p "${INSTALL_DIR}" "${DATA_DIR}" "${CONFIG_DIR}" "${LIBEXEC_DIR}"
cp -r "${SRC_ROOT}/backend" "${INSTALL_DIR}/"
if [[ -d "${SRC_ROOT}/frontend/dist" ]]; then
    mkdir -p "${INSTALL_DIR}/frontend"
    cp -r "${SRC_ROOT}/frontend/dist" "${INSTALL_DIR}/frontend/"
fi

install -m 0755 "${SRC_ROOT}/deploy/scripts/tv-shadow-launch.sh" "${LIBEXEC_DIR}/tv-shadow-launch.sh"
if [[ ! -f "${CONFIG_DIR}/tv-panel.env" ]]; then
    install -m 0640 -o root -g tv-panel "${SRC_ROOT}/deploy/config/tv-panel.env.example" "${CONFIG_DIR}/tv-panel.env"
fi

echo "[5/8] Configurando ambiente virtual Python e aplicando migrações SQLite..."
python3 -m venv "${INSTALL_DIR}/venv"
"${INSTALL_DIR}/venv/bin/pip" install --upgrade pip
"${INSTALL_DIR}/venv/bin/pip" install -r "${INSTALL_DIR}/backend/requirements.txt"

chown -R tv-panel:tv-panel "${DATA_DIR}"
chmod 0775 "${DATA_DIR}"

sudo -u tv-panel TV_PANEL_DB_PATH="${DATA_DIR}/tv_panel.db" \
    "${INSTALL_DIR}/venv/bin/python" -m app.cli migrate --PYTHONPATH "${INSTALL_DIR}/backend" 2>/dev/null || \
    (cd "${INSTALL_DIR}/backend" && sudo -u tv-panel TV_PANEL_DB_PATH="${DATA_DIR}/tv_panel.db" "${INSTALL_DIR}/venv/bin/python" -m app.cli migrate)

# Permite escrita pelo tv-panel e leitura somente-leitura do SQLite pelas contas das TVs
chown -R tv-panel:tv-panel "${DATA_DIR}"
chmod 0775 "${DATA_DIR}"
chmod 0664 "${DATA_DIR}/tv_panel.db"

echo "[6/8] Instalando regra sudoers restrita e unidades systemd..."
install -m 0440 "${SRC_ROOT}/deploy/sudoers/tv-panel-admin" /etc/sudoers.d/tv-panel-admin
visudo -cf /etc/sudoers.d/tv-panel-admin

install -m 0644 "${SRC_ROOT}/deploy/systemd/system/tv-shadow@.service" /etc/systemd/system/tv-shadow@.service
install -m 0644 "${SRC_ROOT}/deploy/systemd/system/tv-panel-api.service" /etc/systemd/system/tv-panel-api.service
install -m 0644 "${SRC_ROOT}/deploy/systemd/tv-shadow-session-hook.desktop" /etc/xdg/autostart/tv-shadow-session-hook.desktop

systemctl daemon-reload
systemctl enable --now tv-panel-api.service

echo "[7/8] Instalação concluída com sucesso!"
echo "[8/8] PRÓXIMO PASSO OBRIGATÓRIO: Crie o usuário administrador inicial com:"
echo "  cd /opt/tv-panel/backend && sudo -u tv-panel TV_PANEL_DB_PATH=/var/lib/tv-panel/tv_panel.db /opt/tv-panel/venv/bin/python -m app.cli create-admin --username operador_noc"

