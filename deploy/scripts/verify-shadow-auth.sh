#!/usr/bin/env bash
# deploy/scripts/verify-shadow-auth.sh
# Script de inspeção pré-implantação e verificação positiva da versão, semântica de -auth/+auth
# e conflitos de porta no Debian 13 antes de ativar as unidades systemd.
# Não altera nenhuma configuração do servidor nem toca no XRDP (porta 3389).

set -euo pipefail

echo "=================================================================="
echo "1. Inspeção de Sistema Operacional e XRDP (Porta 3389 Intocada)"
echo "=================================================================="
if [[ -f /etc/os-release ]]; then
    grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release || true
fi

echo ""
echo "-> Verificando serviço xrdp na porta 3389 (somente leitura):"
systemctl is-active xrdp.service || true
ss -tlnp 'sport = :3389' || true

echo ""
echo "=================================================================="
echo "2. Verificação de Versão e Ajuda do Binário freerdp-shadow-cli3"
echo "=================================================================="
if command -v freerdp-shadow-cli3 >/dev/null 2>&1; then
    freerdp-shadow-cli3 /version || true
    echo ""
    echo "-> Semântica de flags de autenticação e segurança reportadas pelo binário:"
    freerdp-shadow-cli3 /help 2>&1 | grep -E 'auth|sec|sam-file|bind-address|gfx|server-side-cursor' || true
else
    echo "[AVISO] freerdp-shadow-cli3 ainda não está instalado no PATH."
fi

echo ""
echo "=================================================================="
echo "3. Inspeção de Contas Unix, Sessões Gráficas XFCE e Portas Locais"
echo "=================================================================="
for item in "tv01:3391" "tv02:3392" "tv03:3393"; do
    USER_NAME="${item%%:*}"
    PORT_NUM="${item##*:}"
    echo "--- Verificando ${USER_NAME} (porta proposta 127.0.0.1:${PORT_NUM}) ---"
    if id "${USER_NAME}" >/dev/null 2>&1; then
        echo "  [OK] Conta Unix '${USER_NAME}' existe (UID=$(id -u "${USER_NAME}"))."
        XFCE_PID="$(pgrep -u "${USER_NAME}" -f "xfce4-session" | head -n 1 || true)"
        if [[ -n "${XFCE_PID}" ]]; then
            echo "  [OK] Sessão gráfica xfce4-session ativa (PID=${XFCE_PID})."
        else
            echo "  [INFO] Sem sessão xfce4-session ativa no momento para '${USER_NAME}'."
        fi
    else
        echo "  [PENDENTE] Conta Unix '${USER_NAME}' não encontrada."
    fi

    if ss -H -tln "sport = :${PORT_NUM}" | grep -q .; then
        echo "  [ATENÇÃO] Porta ${PORT_NUM} já possui listener ativo:"
        ss -tlnp "sport = :${PORT_NUM}" || true
    else
        echo "  [OK] Porta ${PORT_NUM} livre para alocação em 127.0.0.1."
    fi
done

echo ""
echo "=================================================================="
echo "4. Nota Crítica sobre -auth vs +auth no FreeRDP 3"
echo "=================================================================="
cat << 'EOF'
Na sintaxe booleana do FreeRDP 3 (`freerdp-shadow-cli3`):
  * `-auth` DESABILITA a verificação de credenciais no listener Shadow.
  * `+auth` HABILITA a verificação de credenciais (padrão NLA via `/sam-file` ou PAM via `-sec-nla +auth`).
Para testar positivamente se o build atual aceita PAM sem privilégios de root:
  1. Na sessão ativa de tv03, execute em teste:
     freerdp-shadow-cli3 /port:3393 /bind-address:127.0.0.1 +auth -sec-nla /sec:rdp -gfx +server-side-cursor
  2. Caso a autenticação PAM de usuário não-root falhe (porque o módulo pam_unix exige leitura de /etc/shadow
     ou helper setuid específico), mantenha `-auth` ESTRITAMENTE vinculado a `/bind-address:127.0.0.1`
     com `IPAddressAllow=127.0.0.1/32` no systemd e delegue a autenticação forte ao gateway web HTTPS.
EOF

