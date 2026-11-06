# Painel Web de Administração e Espelhamento Shadow RDP (Debian 13 + XRDP + XFCE)

Solução completa (Backend **FastAPI + SQLite**, Frontend **React + TypeScript + `guacamole-common-js`**, unidades **systemd** isoladas e Reverse Proxy **HTTPS**) para administrar e acessar ao vivo, pelo navegador, as sessões gráficas XFCE existentes das TVs conectadas a um servidor **Debian 13 ("Trixie")** sem criar novas sessões XRDP e sem alterar a porta `3389`.

---

## 1. Inspeção de Ambiente e Compatibilidade de Versões (Debian 13)

> **Transparência de Verificação:** Este workspace de desenvolvimento foi inspecionado localmente (Windows, diretório `c:\Users\admin\Documents\server-rdp`, sem conexão SSH ativa com o host Debian 13). Nenhum pacote de sistema foi instalado e nenhuma configuração do servidor foi modificada. As sessões reais no servidor Debian 13 e a autenticação PAM do binário local **devem ser confirmadas no host** executando o script de inspeção `deploy/scripts/verify-shadow-auth.sh` antes da ativação em produção.

### Matriz de Compatibilidade Oficial Verificada
| Componente | Versão no Debian 13 ("Trixie") / Upstream | Observações Técnicas e Compatibilidade |
| :--- | :--- | :--- |
| **FreeRDP Shadow X11** | `freerdp3-shadow-x11` (`~3.15.0+dfsg`) | Fornece o binário `/usr/bin/freerdp-shadow-cli3`. Suporta os parâmetros validados em `tv03`: `/port:<N> /bind-address:127.0.0.1 /sec:rdp -gfx +server-side-cursor`. |
| **Apache Guacamole (`guacd`)** | `1.6.0` (ou `1.5.5`) | O pacote antigo do repositório Debian (`guacd 1.3.0`) foi construído para FreeRDP 2 e conflita com bibliotecas nativas FreeRDP 3. No Guacamole `1.6.0`, o suporte a FreeRDP 3 na compilação é experimental; portanto, a forma mais estável e suportada no Debian 13 é executar o daemon oficial `guacamole/guacd:1.6.0` com `network_mode: host` escutando apenas em `-b 127.0.0.1 -l 4822` (veja seção 4). |
| **Cliente HTML5** | `guacamole-common-js` (`1.5.x` / `1.6.x`) | Integrado diretamente na interface React/TypeScript via `Guacamole.WebSocketTunnel` (`/api/ws/tv/{id}`), eliminando a necessidade de manter Tomcat/Java (`guacamole.war`) aberto ao usuário final. Um gerador de tokens `guacamole-auth-json` (AES-128-CBC + HMAC-SHA256) também está incluído em `backend/app/services/guac_json_auth.py` caso deseje usar o webapp Java oficial em paralelo. |
| **Banco de Dados** | SQLite 3 (modo `WAL`) | Ideal para inventário local em servidor único (`tv01`, `tv02`, `tv03`...), sessões administrativas e trilha de auditoria. |

---

## 2. Análise de Segurança: `-auth` vs `+auth` no `freerdp-shadow-cli3`

Na sintaxe de linha de comando booleana do FreeRDP 3:
- **`-auth` DESATIVA a autenticação RDP** (qualquer cliente TCP que alcance a porta pode visualizar e controlar a sessão sem credenciais).
- **`+auth` ATIVA a autenticação RDP**:
  - Por padrão (`/sec:nla`), exige um arquivo NTLM SAM (`/sam-file:/caminho/sam`).
  - Com `-sec-nla +auth /sec:rdp`, utiliza **PAM** (`pam_unix`). Contudo, quando `freerdp-shadow-cli3` executa como um usuário comum sem privilégios (`tv01`, `tv02`, `tv03`), a validação PAM pode falhar dependendo das permissões de `/etc/shadow` ou do helper PAM do Debian 13, além de exigir que o `guacd` envie a senha Unix da TV a cada conexão.

### Decisão Arquitetural e Limite de Segurança Explícito
1. **Não presumimos que `-auth` autentica usuários.** Pelo contrário: tratamos `-auth` como um socket **sem autenticação nativa RDP**.
2. Por padrão, os serviços Shadow operam com `-auth /sec:rdp -gfx +server-side-cursor`, mas **estritamente confinados ao loopback `127.0.0.1`** em três camadas independentes:
   - Parâmetro explícito `/bind-address:127.0.0.1` no `freerdp-shadow-cli3`;
   - Restrição de cgroup/kernel na unidade systemd (`IPAddressAllow=127.0.0.1/32` e `IPAddressDeny=any`);
   - Inspeção contínua pelo backend (`ss -H -tln`): se uma porta Shadow aparecer vinculada fora de `127.0.0.1`, o painel marca a TV como **Conflito/Bloqueada** e recusa conexões.
3. Todo o controle de acesso, autenticação forte (hash PBKDF2-HMAC-SHA256 com 600.000 iterações), bloqueio contra força bruta, cookies `HttpOnly; Secure; SameSite=Strict`, proteção CSRF e trilha de auditoria ocorre no **Gateway Web HTTPS (FastAPI)**.
4. Caso você comprove positivamente no host (usando `deploy/scripts/verify-shadow-auth.sh`) que `+auth` com SAM ou PAM funciona no seu ambiente, a opção `shadow_auth_enabled` (`+auth`) pode ser ativada individualmente por TV na aba **Administração**.

---

## 3. Arquitetura de Sessões Shadow e Escolha do Modelo `systemd`

### Por que escolhemos `tv-shadow@<usuario>.service` com `User=%i` + Wrapper de Sessão?
Avaliamos duas abordagens para o Debian 13 com XRDP:
1. `systemd --user`: Sessões criadas pelo `xrdp-sesman` no Debian frequentemente não inicializam um barramento `systemd --user` completo ou consistente sem `loginctl enable-linger` (o que violaria a regra de não habilitar `linger` sem justificativa e de não iniciar o Shadow antes do login gráfico).
2. **Serviço de sistema parametrizado (`deploy/systemd/system/tv-shadow@.service`) executando sem privilégios como `User=%i` (Escolhido)**:
   - Executa sob a própria conta Unix dedicada da TV (`User=tv01`, `User=tv02`, `User=tv03`), **nunca como `root`**.
   - Utiliza o wrapper `/usr/local/libexec/tv-panel/tv-shadow-launch.sh`:
     - Verifica conflitos de porta antes de abrir o listener.
     - Procura o processo `xfce4-session` ativo daquele usuário e extrai `DISPLAY` e `XAUTHORITY` diretamente de `/proc/<pid>/environ`.
     - **Recusa iniciar** caso o usuário não esteja logado numa sessão gráfica XFCE ativa com `DISPLAY` e `XAUTHORITY` válidos.
     - Monitora o PID do `xfce4-session` a cada 2 segundos: **assim que a sessão gráfica XFCE encerra, o processo Shadow é terminado imediatamente**.
     - Inclui também o hook XDG Autostart (`/etc/xdg/autostart/tv-shadow-session-hook.desktop`) para sincronizar o ambiente gráfico após o login XFCE.
   - **Preservação total do XRDP (`3389`)**: Nenhuma configuração em `/etc/xrdp` é alterada e o serviço `xrdp.service` jamais é reiniciado ou modificado.

### Mapeamento Inicial Proposto
| TV | Identificador (`slug`) | Usuário Unix | Porta Local Shadow | Flags de Captura Padrão |
| :--- | :--- | :--- | :--- | :--- |
| **TV 01** | `tv01` | `tv01` | `127.0.0.1:3391` | `/port:3391 /bind-address:127.0.0.1 -auth /sec:rdp -gfx +server-side-cursor` |
| **TV 02** | `tv02` | `tv02` | `127.0.0.1:3392` | `/port:3392 /bind-address:127.0.0.1 -auth /sec:rdp -gfx +server-side-cursor` |
| **TV 03** | `tv03` | `tv03` | `127.0.0.1:3393` | `/port:3393 /bind-address:127.0.0.1 -auth /sec:rdp -gfx +server-side-cursor` |

---

## 4. Rede do `guacd` e Containers (`127.0.0.1` no Container vs Host)

> **Atenção:** Se você executar o `guacd` em container Docker/Podman, lembre-se de que `127.0.0.1` dentro de um container em modo `bridge` aponta para o próprio container, e **não** para o host Debian 13 onde o `freerdp-shadow-cli3` escuta em `127.0.0.1:3391..3393`. **Nunca resolva isso expondo o FreeRDP Shadow no IP da LAN!**

A solução correta está configurada em [`deploy/guacamole/docker-compose.guacd-host.yml`](file:///c:/Users/admin/Documents/server-rdp/deploy/guacamole/docker-compose.guacd-host.yml):
- Utiliza `network_mode: host` combinado com `-b 127.0.0.1 -l 4822`.
- Assim, o `guacd` compartilha o loopback `127.0.0.1` do host Debian 13 (alcançando `127.0.0.1:3391..3393` localmente) e ao mesmo tempo vincula sua própria porta `4822` apenas a `127.0.0.1` (inacessível pela rede externa).

---

## 5. Procedimento de Instalação no Debian 13

### Passo 1: Pré-inspeção sem alterar o sistema
No servidor Debian 13, execute o script de diagnóstico pré-implantação:
```bash
bash deploy/scripts/verify-shadow-auth.sh
```
Confirme na saída:
1. Que `xrdp.service` está ativo na porta `3389`;
2. A versão exata do `freerdp-shadow-cli3`;
3. Que as contas `tv01`, `tv02`, `tv03` existem e que as portas `3391`, `3392`, `3393` não possuem conflitos.

### Passo 2: Compilar o Frontend React/TypeScript
Em máquina de build (ou no próprio servidor com Node.js 20+):
```bash
cd frontend
npm install
npm run build
cd ..
```

### Passo 3: Executar o instalador do Backend e Unidades Systemd
```bash
sudo bash deploy/scripts/install-debian13.sh
```

### Passo 4: Iniciar o daemon `guacd` em loopback (`127.0.0.1:4822`)
Com Docker Compose (recomendado para Debian 13 pela compatibilidade FreeRDP 2 estável no `guacd 1.6.0`):
```bash
docker compose -f deploy/guacamole/docker-compose.guacd-host.yml up -d
```
*(Ou, se utilizar pacote nativo `guacd`, copie `deploy/guacamole/guacd.conf.example` para `/etc/guacamole/guacd.conf` e reinicie `guacd.service`).*

### Passo 5: Criar o Usuário Administrador Inicial (Sem Credenciais Padrão no Código)
O sistema não possui nenhuma senha padrão no código. Crie o primeiro administrador de forma interativa e segura:
```bash
cd /opt/tv-panel/backend
sudo -u tv-panel TV_PANEL_DB_PATH=/var/lib/tv-panel/tv_panel.db \
  /opt/tv-panel/venv/bin/python -m app.cli create-admin --username operador_noc
```
*(Nota: A conta `root` é bloqueada pelo CLI e pela API por política de segurança).*

### Passo 6: Configurar o Reverse Proxy HTTPS (Caddy ou Nginx)
- **Com Caddy**: Copie [`deploy/reverse-proxy/Caddyfile.example`](file:///c:/Users/admin/Documents/server-rdp/deploy/reverse-proxy/Caddyfile.example) para `/etc/caddy/Caddyfile`, ajuste o hostname da sua rede e execute `sudo systemctl reload caddy`.
- **Com Nginx**: Copie [`deploy/reverse-proxy/nginx-tv-panel.conf.example`](file:///c:/Users/admin/Documents/server-rdp/deploy/reverse-proxy/nginx-tv-panel.conf.example) para `/etc/nginx/sites-available/tv-panel.conf`, habilite o site e execute `sudo systemctl reload nginx`.

### Passo 7: Iniciar os Serviços Shadow para as Sessões XFCE Ativas
Quando `tv01`, `tv02` e `tv03` estiverem com sessão gráfica XFCE aberta:
```bash
sudo systemctl start tv-shadow@tv01.service
sudo systemctl start tv-shadow@tv02.service
sudo systemctl start tv-shadow@tv03.service
```

---

## 6. Comandos de Operação, Diagnóstico, Atualização e Rollback

### Diagnóstico Administrativo via CLI
```bash
cd /opt/tv-panel/backend
sudo -u tv-panel TV_PANEL_DB_PATH=/var/lib/tv-panel/tv_panel.db \
  /opt/tv-panel/venv/bin/python -m app.cli diagnose
```

### Verificar Sockets em Escuta (Garantir apenas `127.0.0.1`)
```bash
ss -tlnp '( sport >= :3391 and sport <= :3399 ) or sport = :4822 or sport = :8000'
```

### Consultar Logs de um Serviço Shadow ou da API
```bash
journalctl -u tv-shadow@tv03.service -n 50 --no-pager
journalctl -u tv-panel-api.service -n 50 --no-pager
```

### Procedimento de Atualização
```bash
# 1. Faça backup do banco SQLite
sudo cp -a /var/lib/tv-panel/tv_panel.db /var/backups/tv_panel_pre_update.db

# 2. Atualize os arquivos em /opt/tv-panel e aplique novas migrações
cd /opt/tv-panel/backend
sudo -u tv-panel TV_PANEL_DB_PATH=/var/lib/tv-panel/tv_panel.db \
  /opt/tv-panel/venv/bin/python -m app.cli migrate

# 3. Reinicie apenas a API do painel (não interrompe sessões XFCE nem o XRDP 3389)
sudo systemctl restart tv-panel-api.service
```

### Procedimento de Rollback
Caso precise reverter a instalação sem afetar o XRDP na porta `3389` nem encerrar as sessões XFCE das TVs:
```bash
sudo bash deploy/scripts/rollback-debian13.sh
```

---

## 7. Checklist de Validação dos Critérios de Conclusão

- [ ] **1. Estados separados na interface:** O painel exibe cartões para `tv01`, `tv02` e `tv03` distinguindo claramente:
  - *Sessão Gráfica XFCE* (`Ativa (:10.0)` / `Inativa` / `Estado Desconhecido`);
  - *Listener FreeRDP Shadow* (`Disponível (127.0.0.1:339X)` / `Indisponível` / `Conflito`);
  - *Espectador / Operador* (`Alguém Conectado (N)` / `Livre`).
  - Se a API falhar, o estado muda para **Estado Desconhecido** (nunca mostra `Online` falsamente).
- [ ] **2. Espelhamento ao vivo no navegador:** Clicar em **“Abrir Tela ao Vivo”** numa sessão ativa renderiza o desktop XFCE existente pelo `guacamole-common-js` com vídeo, cursor do servidor (`+server-side-cursor`), mouse e teclado.
- [ ] **3. Persistência da sessão XFCE ao desconectar:** Clicar em **“Desconectar Visão”** ou fechar a aba do navegador encerra apenas o túnel WebSocket/Guacamole; a sessão XFCE da TV permanece intacta e nenhuma nova sessão XRDP é criada.
- [ ] **4. Isolamento do XRDP (porta `3389`):** Reiniciar ou parar `tv-shadow@tv03.service` pelo painel (com modal de confirmação explícita) não afeta `xrdp.service` nem desconecta sessões XRDP existentes na porta `3389`.
- [ ] **5. Vínculo estrito ao loopback (`127.0.0.1`):** `ss -tlnp` confirma que `3391`, `3392`, `3393`, `4822` e `8000` escutam somente em `127.0.0.1`.
- [ ] **6. Autenticação e Autorização verificadas:** Rotas `/api/tvs` e `/api/ws/tv/{id}` bloqueiam acessos não autenticados (`401`/`4401`), exigem token CSRF em mutações (`403`), bloqueiam força bruta (`429`) e proíbem o uso da conta `root`.
- [ ] **7. Inicialização condicionada ao `DISPLAY` e `XAUTHORITY`:** Tentar iniciar `tv-shadow@tv01.service` quando `tv01` não possui `xfce4-session` ativa falha de forma limpa informando que aguarda login gráfico; ao encerrar o `xfce4-session`, o serviço Shadow para automaticamente.

