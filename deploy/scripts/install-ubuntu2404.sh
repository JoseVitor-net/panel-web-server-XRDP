#!/usr/bin/env bash
# deploy/scripts/install-ubuntu2404.sh
# Script de instalação completa e reproduzível do Painel TV Shadow RDP no Ubuntu Server 24.04 LTS (Noble Numbat)
# (também compatível com Debian 13 Trixie).
# Preserva integralmente o XRDP existente na porta 3389.

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
    echo "Execute este script como root (ou via sudo) no Ubuntu Server 24.04 LTS." >&2
    exit 1
fi

INSTALL_DIR="/opt/tv-panel"
DATA_DIR="/var/lib/tv-panel"
CONFIG_DIR="/etc/tv-panel"
LIBEXEC_DIR="/usr/local/libexec/tv-panel"
SRC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "[1/9] Verificando que o serviço XRDP (3389) não será alterado..."
if systemctl is-active --quiet xrdp.service; then
    echo "  -> xrdp.service está ativo na porta 3389 e será preservado."
fi

echo "[2/9] Instalando dependências de sistema (Ubuntu 24.04 LTS / Debian)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update

# No Ubuntu 24.04 LTS, freerdp2-shadow-x11 e guacd nativo usam a mesma libfreerdp2-2 (2.11.5),
# garantindo compatibilidade total sem necessidade de container Docker.
if apt-cache show freerdp2-shadow-x11 >/dev/null 2>&1; then
    SHADOW_PKG="freerdp2-shadow-x11"
else
    SHADOW_PKG="freerdp3-shadow-x11"
fi

apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip sqlite3 \
    "${SHADOW_PKG}" iproute2 procps sudo ca-certificates curl \
    nodejs npm caddy

# Instala guacd nativo no Ubuntu 24.04 LTS se disponível (ou mantém container Docker caso já exista)
if apt-cache show guacd >/dev/null 2>&1 && apt-cache show libguac-client-rdp0 >/dev/null 2>&1; then
    echo "[3/9] Instalando e configurando guacd nativo do Ubuntu 24.04 LTS em 127.0.0.1:4822..."
    docker rm -f tv-panel-guacd 2>/dev/null || true
    apt-get install -y --no-install-recommends guacd libguac-client-rdp0
    mkdir -p /etc/guacamole
    cat > /etc/guacamole/guacd.conf <<'EOF'
[server]
bind_host = 127.0.0.1
bind_port = 4822

[daemon]
log_level = info
EOF
    systemctl enable guacd.service
    systemctl restart guacd.service
else
    echo "[3/9] Pacote guacd nativo não utilizado; verifique o container tv-panel-guacd na porta 4822."
fi

echo "[4/9] Compilando frontend React + TypeScript (NOC Display Ops)..."
cd "${SRC_ROOT}/frontend"
npm install
npm run build

echo "[5/9] Criando usuário dedicado sem privilégios 'tv-panel'..."
if ! id -u tv-panel >/dev/null 2>&1; then
    useradd --system --home-dir "${DATA_DIR}" --shell /usr/sbin/nologin tv-panel
fi

echo "[6/9] Preparando diretórios e copiando backend e frontend..."
mkdir -p "${INSTALL_DIR}" "${DATA_DIR}" "${CONFIG_DIR}" "${LIBEXEC_DIR}"
rm -rf "${INSTALL_DIR}/backend" "${INSTALL_DIR}/frontend"
cp -r "${SRC_ROOT}/backend" "${INSTALL_DIR}/"
mkdir -p "${INSTALL_DIR}/frontend"
cp -r "${SRC_ROOT}/frontend/dist" "${INSTALL_DIR}/frontend/"

install -m 0755 "${SRC_ROOT}/deploy/scripts/tv-shadow-launch.sh" "${LIBEXEC_DIR}/tv-shadow-launch.sh"
if [[ ! -f "${CONFIG_DIR}/tv-panel.env" ]]; then
    install -m 0640 -o root -g tv-panel "${SRC_ROOT}/deploy/config/tv-panel.env.example" "${CONFIG_DIR}/tv-panel.env"
    sed -i 's/^TV_PANEL_ENV_MODE=.*/TV_PANEL_ENV_MODE=production/' "${CONFIG_DIR}/tv-panel.env" || true
fi

echo "[7/9] Configurando ambiente virtual Python e aplicando migrações SQLite..."
python3 -m venv "${INSTALL_DIR}/venv"
"${INSTALL_DIR}/venv/bin/pip" install --upgrade pip
"${INSTALL_DIR}/venv/bin/pip" install -r "${INSTALL_DIR}/backend/requirements.txt"

chown -R tv-panel:tv-panel "${DATA_DIR}"
chmod 0775 "${DATA_DIR}"

(cd "${INSTALL_DIR}/backend" && sudo -u tv-panel TV_PANEL_DB_PATH="${DATA_DIR}/tv_panel.db" "${INSTALL_DIR}/venv/bin/python" -m app.cli migrate)

# Configura portas padrão (3391, 3392, 3393) e sec_mode='rdp' para FreeRDP 2 no Ubuntu 24.04 LTS
sqlite3 "${DATA_DIR}/tv_panel.db" "
PRAGMA journal_mode=DELETE;
UPDATE tvs SET local_port = 3490 + id;
UPDATE tvs SET local_port = 3391, sec_mode = 'rdp' WHERE unix_user = 'tv01';
UPDATE tvs SET local_port = 3392, sec_mode = 'rdp' WHERE unix_user = 'tv02';
UPDATE tvs SET local_port = 3393, sec_mode = 'rdp' WHERE unix_user = 'tv03';
"

# Cria ou atualiza o administrador padrão 'operador_noc'
(cd "${INSTALL_DIR}/backend" && echo "Admin#2026!" | sudo -u tv-panel TV_PANEL_DB_PATH="${DATA_DIR}/tv_panel.db" "${INSTALL_DIR}/venv/bin/python" -m app.cli create-admin --username operador_noc --password-stdin)

# Garante permissões corretas para escrita pelo tv-panel e leitura pelas contas das TVs
chown -R tv-panel:tv-panel "${DATA_DIR}"
chmod 0775 "${DATA_DIR}"
chmod 0664 "${DATA_DIR}/tv_panel.db"

echo "[8/9] Instalando regra sudoers, unidades systemd e proxy HTTPS Caddy..."
install -m 0440 "${SRC_ROOT}/deploy/sudoers/tv-panel-admin" /etc/sudoers.d/tv-panel-admin
visudo -cf /etc/sudoers.d/tv-panel-admin

install -m 0644 "${SRC_ROOT}/deploy/systemd/system/tv-shadow@.service" /etc/systemd/system/tv-shadow@.service
install -m 0644 "${SRC_ROOT}/deploy/systemd/system/tv-panel-api.service" /etc/systemd/system/tv-panel-api.service
install -m 0644 "${SRC_ROOT}/deploy/systemd/tv-shadow-session-hook.desktop" /etc/xdg/autostart/tv-shadow-session-hook.desktop
install -m 0644 "${SRC_ROOT}/deploy/reverse-proxy/Caddyfile.example" /etc/caddy/Caddyfile

# Se o UFW estiver ativo no Ubuntu 24.04 LTS, libera HTTPS (443), HTTP (80) e preserva XRDP (3389)
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow 443/tcp >/dev/null 2>&1 || true
    ufw allow 80/tcp >/dev/null 2>&1 || true
    ufw allow 3389/tcp >/dev/null 2>&1 || true
fi

systemctl daemon-reload
systemctl enable --now tv-panel-api.service
systemctl restart tv-panel-api.service
systemctl enable --now caddy.service
systemctl restart caddy.service

for tv_user in tv01 tv02 tv03; do
    if id -u "${tv_user}" >/dev/null 2>&1; then
        systemctl enable "tv-shadow@${tv_user}.service" || true
        systemctl restart "tv-shadow@${tv_user}.service" || true
    fi
done

echo "[9/9] Instalação no Ubuntu Server 24.04 LTS concluída com sucesso!"
echo "Para criar ou redefinir a senha do administrador 'operador_noc', execute:"
echo "  cd /opt/tv-panel/backend && sudo -u tv-panel TV_PANEL_DB_PATH=/var/lib/tv-panel/tv_panel.db /opt/tv-panel/venv/bin/python -m app.cli create-admin --username operador_noc"

