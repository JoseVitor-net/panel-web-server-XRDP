#!/usr/bin/env bash
# deploy/scripts/rollback-debian13.sh
# Procedimento seguro de rollback / desativação do Painel TV Shadow RDP.
# Preserva o banco de dados em backup e não afeta o XRDP na porta 3389 nem as sessões XFCE abertas.

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
    echo "Execute este script como root (ou via sudo)." >&2
    exit 1
fi

echo "[1/4] Parando serviços Shadow locais e API do painel (sem tocar no xrdp.service)..."
for unit in $(systemctl list-units --type=service --all 'tv-shadow@*.service' --no-legend | awk '{print $1}'); do
    systemctl stop "${unit}" || true
    systemctl disable "${unit}" || true
done

systemctl stop tv-panel-api.service || true
systemctl disable tv-panel-api.service || true

echo "[2/4] Removendo unidades systemd e regra sudoers..."
rm -f /etc/systemd/system/tv-shadow@.service
rm -f /etc/systemd/system/tv-panel-api.service
rm -f /etc/sudoers.d/tv-panel-admin
rm -f /etc/xdg/autostart/tv-shadow-session-hook.desktop
systemctl daemon-reload

echo "[3/4] Criando backup do banco SQLite em /var/backups/..."
if [[ -f /var/lib/tv-panel/tv_panel.db ]]; then
    BACKUP_FILE="/var/backups/tv_panel_$(date +%Y%m%d_%H%M%S).db"
    cp -a /var/lib/tv-panel/tv_panel.db "${BACKUP_FILE}"
    echo "  -> Backup salvo em: ${BACKUP_FILE}"
fi

echo "[4/4] Rollback concluído. O serviço XRDP na porta 3389 e as sessões XFCE continuam intactos."

