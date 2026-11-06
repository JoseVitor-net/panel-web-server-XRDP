import React, { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import { LiveShadowViewer } from "./components/LiveShadowViewer";
import {
  AuditLogItem,
  AuthSession,
  OverallStatus,
  ShadowServiceState,
  TVFormPayload,
  TVItem,
  ViewerConnectionState,
  XfceSessionState,
} from "./types";

function formatDateTimePtBr(isoString: string): string {
  try {
    const dt = new Date(isoString);
    if (Number.isNaN(dt.getTime())) return isoString;
    return dt.toLocaleString("pt-BR", {
      dateStyle: "short",
      timeStyle: "medium",
    });
  } catch {
    return isoString;
  }
}

function labelOverallStatus(status: OverallStatus): string {
  switch (status) {
    case "online":
      return "Online";
    case "degraded":
      return "Atenção / Parcial";
    case "offline":
      return "Offline";
    case "disabled":
      return "Desativada";
    case "unknown":
    default:
      return "Estado Desconhecido";
  }
}

function labelXfceState(state: XfceSessionState, display: string | null): string {
  switch (state) {
    case "active":
      return display ? `Ativa (${display})` : "Ativa";
    case "inactive":
      return "Inativa (Sem Login Gráfico)";
    case "unknown":
    default:
      return "Estado Desconhecido";
  }
}

function labelShadowState(state: ShadowServiceState, port: number): string {
  switch (state) {
    case "available":
      return `Disponível (127.0.0.1:${port})`;
    case "unavailable":
      return "Indisponível (Parado)";
    case "conflict":
      return `Conflito na Porta ${port}`;
    case "starting":
      return "Iniciando...";
    case "error":
      return "Erro na Unidade Systemd";
    case "unknown":
    default:
      return "Estado Desconhecido";
  }
}

function labelViewerState(state: ViewerConnectionState, count: number): string {
  switch (state) {
    case "connected":
      return `Alguém Conectado (${count})`;
    case "idle":
      return "Livre (Ninguém Conectado)";
    case "unknown":
    default:
      return "Estado Desconhecido";
  }
}

const INITIAL_FORM: TVFormPayload = {
  slug: "",
  name: "",
  location: "",
  unix_user: "",
  local_port: 3394,
  display_number: null,
  gfx_enabled: true,
  server_side_cursor: true,
  sec_mode: "rdp",
  shadow_auth_enabled: false,
  enabled: true,
  notes: "",
};

interface PendingConfirmation {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
}

export const App: React.FC = () => {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authChecking, setAuthChecking] = useState<boolean>(true);
  const [loginUser, setLoginUser] = useState<string>("");
  const [loginPass, setLoginPass] = useState<string>("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState<boolean>(false);

  const [activeTab, setActiveTab] = useState<"dashboard" | "admin" | "audit">("dashboard");
  const [tvs, setTvs] = useState<TVItem[]>([]);
  const [tvsLoading, setTvsLoading] = useState<boolean>(false);
  const [apiFetchFailed, setApiFetchFailed] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const [activeViewerTv, setActiveViewerTv] = useState<TVItem | null>(null);

  // Estado de formulário de cadastro/edição na aba Administração
  const [editingTvId, setEditingTvId] = useState<number | null>(null);
  const [formData, setFormData] = useState<TVFormPayload>(INITIAL_FORM);
  const [formSubmitting, setFormSubmitting] = useState<boolean>(false);

  // Modal de confirmação explícita para ações que interrompam sessão/serviço
  const [pendingConfirmation, setPendingConfirmation] =
    useState<PendingConfirmation | null>(null);

  // Logs de auditoria
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);

  const loadTVs = useCallback(async () => {
    setTvsLoading(true);
    try {
      const list = await api.listTVs();
      setTvs(list);
      setApiFetchFailed(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setSession(null);
        return;
      }
      const message =
        err instanceof Error
          ? err.message
          : "Falha ao verificar o estado das TVs na API.";
      setApiFetchFailed(message);
      // Regra crítica: Nunca mostrar uma sessão como 'online' se a API não conseguiu confirmá-la!
      setTvs((prev) =>
        prev.map((tv) => ({
          ...tv,
          runtime: {
            ...tv.runtime,
            overall_status: "unknown",
            xfce_session_state: "unknown",
            shadow_service_state: "unknown",
            viewer_connection_state: "unknown",
            user_message:
              "Estado desconhecido: a API não pôde confirmar o estado atual desta TV.",
          },
        }))
      );
    } finally {
      setTvsLoading(false);
    }
  }, []);

  const loadAuditLogs = useCallback(async () => {
    try {
      const logs = await api.listAuditLogs(80);
      setAuditLogs(logs);
    } catch {
      // ignora erro secundário
    }
  }, []);

  useEffect(() => {
    api
      .getMe()
      .then((sess) => {
        setSession(sess);
      })
      .catch(() => {
        setSession(null);
      })
      .finally(() => {
        setAuthChecking(false);
      });
  }, []);

  useEffect(() => {
    if (!session) return;
    void loadTVs();
    const timer = window.setInterval(() => {
      void loadTVs();
    }, 8000);
    return () => window.clearInterval(timer);
  }, [session, loadTVs]);

  useEffect(() => {
    if (session && activeTab === "audit") {
      void loadAuditLogs();
    }
  }, [session, activeTab, loadAuditLogs]);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    setLoginLoading(true);
    try {
      const sess = await api.login(loginUser, loginPass);
      setSession(sess);
      setLoginPass("");
    } catch (err) {
      setLoginError(
        err instanceof Error ? err.message : "Erro ao efetuar login."
      );
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = async () => {
    if (!session) return;
    try {
      await api.logout(session.csrf_token);
    } catch {
      // prossegue limpando estado local
    }
    setSession(null);
    setActiveViewerTv(null);
  };

  const handleStartEdit = (tv: TVItem) => {
    setEditingTvId(tv.id);
    setFormData({
      slug: tv.slug,
      name: tv.name,
      location: tv.location,
      unix_user: tv.unix_user,
      local_port: tv.local_port,
      display_number: tv.display_number,
      gfx_enabled: tv.gfx_enabled,
      server_side_cursor: tv.server_side_cursor,
      sec_mode: tv.sec_mode,
      shadow_auth_enabled: tv.shadow_auth_enabled,
      enabled: tv.enabled,
      notes: tv.notes,
    });
    setActiveTab("admin");
    setActionFeedback(null);
  };

  const handleResetForm = () => {
    setEditingTvId(null);
    const maxPort = tvs.reduce((acc, item) => Math.max(acc, item.local_port), 3393);
    setFormData({
      ...INITIAL_FORM,
      local_port: Math.min(3499, maxPort + 1),
    });
  };

  const executeSaveTv = async (confirmDisruption: boolean) => {
    if (!session) return;
    setFormSubmitting(true);
    setActionFeedback(null);
    try {
      if (editingTvId === null) {
        await api.createTV(formData, session.csrf_token);
        setActionFeedback({
          type: "success",
          text: `TV '${formData.name}' (${formData.slug}) cadastrada com sucesso na porta local ${formData.local_port}.`,
        });
      } else {
        await api.updateTV(
          editingTvId,
          { ...formData, confirm_disruption: confirmDisruption },
          session.csrf_token
        );
        setActionFeedback({
          type: "success",
          text: `Configuração da TV '${formData.name}' atualizada com sucesso.`,
        });
      }
      await loadTVs();
      handleResetForm();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && !confirmDisruption && editingTvId !== null) {
        setPendingConfirmation({
          title: "Confirmar alteração com impacto na sessão",
          description: err.message,
          confirmLabel: "Confirmar e Salvar Alterações",
          onConfirm: async () => {
            setPendingConfirmation(null);
            await executeSaveTv(true);
          },
        });
        return;
      }
      setActionFeedback({
        type: "error",
        text: err instanceof Error ? err.message : "Erro ao salvar TV.",
      });
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await executeSaveTv(false);
  };

  const triggerServiceAction = (
    tv: TVItem,
    action: "start" | "stop" | "restart"
  ) => {
    if (!session) return;

    const executeAction = async (confirmed: boolean) => {
      setActionFeedback(null);
      try {
        const updated = await api.controlService(
          tv.id,
          action,
          confirmed,
          session.csrf_token
        );
        setTvs((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
        setActionFeedback({
          type: "success",
          text: `Ação '${action}' executada com sucesso para ${tv.name} (${tv.runtime.systemd_unit}).`,
        });
      } catch (err) {
        setActionFeedback({
          type: "error",
          text:
            err instanceof Error
              ? err.message
              : "Falha ao controlar o serviço systemd.",
        });
      }
    };

    if (
      action === "stop" ||
      action === "restart" ||
      tv.runtime.viewer_connection_state === "connected"
    ) {
      const actionLabel =
        action === "stop" ? "Parar Serviço Shadow" : "Reiniciar Serviço Shadow";
      setPendingConfirmation({
        title: `${actionLabel} — ${tv.name} (${tv.slug})`,
        description:
          tv.runtime.viewer_connection_state === "connected"
            ? `Há um operador conectado à ${tv.name} neste momento. Executar '${action}' interromperá imediatamente o espelhamento no navegador (a sessão gráfica XFCE na TV não será encerrada, e o XRDP na porta 3389 não será afetado). Deseja continuar?`
            : `Você está prestes a executar '${action}' na unidade ${tv.runtime.systemd_unit} (porta local 127.0.0.1:${tv.local_port}). Qualquer visualização ativa desta TV será desconectada. A sessão XFCE local e o XRDP na porta 3389 serão preservados. Confirmar?`,
        confirmLabel: `Sim, ${action === "stop" ? "Parar" : "Reiniciar"} Shadow`,
        onConfirm: async () => {
          setPendingConfirmation(null);
          await executeAction(true);
        },
      });
    } else {
      void executeAction(false);
    }
  };

  if (authChecking) {
    return (
      <div className="centered-screen">
        <div className="spinner" />
        <p>Verificando sessão administrativa...</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-header">
            <span className="security-tag">Acesso Restrito • HTTPS + Loopback Shadow</span>
            <h1>Painel de Controle de TVs</h1>
            <p>
              Administração e espelhamento ao vivo de sessões gráficas XFCE em servidor
              Debian 13 via Apache Guacamole (`guacd`) e FreeRDP Shadow.
            </p>
          </div>

          {loginError && (
            <div className="alert alert-error" role="alert">
              {loginError}
            </div>
          )}

          <form onSubmit={handleLoginSubmit} className="login-form">
            <div className="form-group">
              <label htmlFor="username">Usuário Administrador</label>
              <input
                id="username"
                type="text"
                autoComplete="username"
                required
                value={loginUser}
                onChange={(e) => setLoginUser(e.target.value)}
                placeholder="Ex: operador_noc"
              />
            </div>

            <div className="form-group">
              <label htmlFor="password">Senha</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={loginPass}
                onChange={(e) => setLoginPass(e.target.value)}
                placeholder="••••••••••••"
              />
            </div>

            <button
              type="submit"
              className="btn btn-primary btn-block"
              disabled={loginLoading}
            >
              {loginLoading ? "Autenticando..." : "Entrar no Painel"}
            </button>
          </form>

          <footer className="login-footer">
            <small>
              Nota de segurança: O serviço XRDP na porta 3389 permanece isolado. Os
              listeners FreeRDP Shadow escutam exclusivamente em <code>127.0.0.1</code>.
            </small>
          </footer>
        </div>
      </div>
    );
  }

  const onlineCount = tvs.filter((t) => t.runtime.overall_status === "online").length;
  const xfceActiveCount = tvs.filter(
    (t) => t.runtime.xfce_session_state === "active"
  ).length;
  const shadowAvailableCount = tvs.filter(
    (t) => t.runtime.shadow_service_state === "available"
  ).length;
  const connectedViewersCount = tvs.filter(
    (t) => t.runtime.viewer_connection_state === "connected"
  ).length;

  return (
    <div className="app-layout">
      <header className="top-navbar">
        <div className="brand-area">
          <h1>Painel TV Shadow RDP</h1>
          <span className="env-pill">
            Debian 13 • XRDP 3389 Preservado • Modo:{" "}
            {session.env_mode === "simulation" ? "Homologação/Simulação" : "Produção"}
          </span>
        </div>

        <nav className="nav-tabs" aria-label="Navegação principal">
          <button
            type="button"
            className={`nav-tab ${activeTab === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            Visão Geral das TVs ({tvs.length})
          </button>
          <button
            type="button"
            className={`nav-tab ${activeTab === "admin" ? "active" : ""}`}
            onClick={() => setActiveTab("admin")}
          >
            Administração e Cadastro
          </button>
          <button
            type="button"
            className={`nav-tab ${activeTab === "audit" ? "active" : ""}`}
            onClick={() => setActiveTab("audit")}
          >
            Auditoria e Segurança
          </button>
        </nav>

        <div className="user-area">
          <span className="user-badge">Admin: {session.username}</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void loadTVs()}
            disabled={tvsLoading}
          >
            {tvsLoading ? "Verificando..." : "Atualizar Estado"}
          </button>
          <button
            type="button"
            className="btn btn-outline-danger btn-sm"
            onClick={handleLogout}
          >
            Sair
          </button>
        </div>
      </header>

      <main className="main-content">
        {apiFetchFailed && (
          <div className="alert alert-warning" role="alert">
            <strong>Estado Desconhecido:</strong> {apiFetchFailed} Nenhuma sessão é
            exibida como "Online" enquanto a comunicação com a API não for confirmada.
          </div>
        )}

        {actionFeedback && (
          <div
            className={`alert ${
              actionFeedback.type === "success" ? "alert-success" : "alert-error"
            }`}
            role="status"
          >
            <span>{actionFeedback.text}</span>
            <button
              type="button"
              className="alert-close"
              onClick={() => setActionFeedback(null)}
            >
              ×
            </button>
          </div>
        )}

        {/* Resumo Operacional Distinto */}
        <section className="metrics-strip" aria-label="Resumo operacional">
          <div className="metric-box">
            <span className="metric-label">TVs Prontas (Online)</span>
            <strong className="metric-value status-text-online">
              {onlineCount} / {tvs.length}
            </strong>
          </div>
          <div className="metric-box">
            <span className="metric-label">Sessões Gráficas XFCE Ativas</span>
            <strong className="metric-value">{xfceActiveCount}</strong>
          </div>
          <div className="metric-box">
            <span className="metric-label">Listeners Shadow Disponíveis</span>
            <strong className="metric-value">{shadowAvailableCount}</strong>
          </div>
          <div className="metric-box">
            <span className="metric-label">Sessões com Operador Conectado</span>
            <strong className="metric-value status-text-connected">
              {connectedViewersCount}
            </strong>
          </div>
        </section>

        {activeTab === "dashboard" && (
          <section className="tv-grid" aria-label="Cartões das TVs cadastradas">
            {tvs.map((tv) => {
              const rt = tv.runtime;
              const canOpenLive =
                tv.enabled &&
                rt.overall_status === "online" &&
                rt.xfce_session_state === "active" &&
                rt.shadow_service_state === "available";

              return (
                <article
                  key={tv.id}
                  className={`tv-card tv-card-${rt.overall_status}`}
                >
                  <header className="tv-card-header">
                    <div>
                      <div className="tv-card-title-row">
                        <h2>{tv.name}</h2>
                        <span className="mono-badge">{tv.slug}</span>
                      </div>
                      <p className="tv-location">
                        {tv.location || "Local não especificado"} • Usuário Unix:{" "}
                        <code>{tv.unix_user}</code> • Porta Loopback:{" "}
                        <code>127.0.0.1:{tv.local_port}</code>
                      </p>
                    </div>
                    <span className={`status-pill status-${rt.overall_status}`}>
                      {labelOverallStatus(rt.overall_status)}
                    </span>
                  </header>

                  {/* 3 Indicadores separados: Sessão XFCE, Listener Shadow e Operador Conectado */}
                  <div className="indicators-list">
                    <div className="indicator-row">
                      <span className="indicator-label">1. Sessão Gráfica XFCE:</span>
                      <span
                        className={`indicator-badge xfce-${rt.xfce_session_state}`}
                      >
                        {labelXfceState(rt.xfce_session_state, rt.detected_display)}
                      </span>
                    </div>

                    <div className="indicator-row">
                      <span className="indicator-label">2. Listener FreeRDP Shadow:</span>
                      <span
                        className={`indicator-badge shadow-${rt.shadow_service_state}`}
                      >
                        {labelShadowState(rt.shadow_service_state, tv.local_port)}
                      </span>
                    </div>

                    <div className="indicator-row">
                      <span className="indicator-label">3. Espectador / Controle:</span>
                      <span
                        className={`indicator-badge viewer-${rt.viewer_connection_state}`}
                      >
                        {labelViewerState(
                          rt.viewer_connection_state,
                          rt.active_viewers_count
                        )}
                      </span>
                    </div>
                  </div>

                  <div className="tv-card-diagnostic">
                    <p className="diagnostic-msg">{rt.user_message}</p>
                    <div className="diagnostic-meta">
                      <span>
                        Unidade: <code>{rt.systemd_unit}</code> ({rt.systemd_active_state})
                      </span>
                      <span>
                        Última verificação: {formatDateTimePtBr(rt.last_checked_at)}
                      </span>
                    </div>
                  </div>

                  <footer className="tv-card-footer">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={!canOpenLive}
                      onClick={() => setActiveViewerTv(tv)}
                      title={
                        canOpenLive
                          ? "Abrir espelhamento ao vivo com controle de teclado e mouse"
                          : "Disponível apenas quando a sessão XFCE está ativa e o Shadow está ouvindo em 127.0.0.1"
                      }
                    >
                      Abrir Tela ao Vivo
                    </button>

                    <div className="card-secondary-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleStartEdit(tv)}
                      >
                        Editar
                      </button>
                      {tv.enabled && rt.shadow_service_state !== "available" && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => triggerServiceAction(tv, "start")}
                        >
                          Iniciar Shadow
                        </button>
                      )}
                      {tv.enabled && rt.shadow_service_state === "available" && (
                        <button
                          type="button"
                          className="btn btn-warning btn-sm"
                          onClick={() => triggerServiceAction(tv, "restart")}
                        >
                          Reiniciar Shadow
                        </button>
                      )}
                    </div>
                  </footer>
                </article>
              );
            })}
          </section>
        )}

        {activeTab === "admin" && (
          <div className="admin-grid">
            <section className="admin-panel">
              <div className="panel-header">
                <h2>
                  {editingTvId === null
                    ? "Cadastrar Nova TV"
                    : `Editando TV #${editingTvId} (${formData.slug})`}
                </h2>
                {editingTvId !== null && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={handleResetForm}
                  >
                    + Nova TV
                  </button>
                )}
              </div>

              <form onSubmit={handleFormSubmit} className="tv-form">
                <div className="form-row-2">
                  <div className="form-group">
                    <label htmlFor="f-slug">Identificador (Slug)</label>
                    <input
                      id="f-slug"
                      type="text"
                      required
                      pattern="^[a-z0-9][a-z0-9_-]{1,30}$"
                      placeholder="Ex: tv04"
                      value={formData.slug}
                      onChange={(e) =>
                        setFormData({ ...formData, slug: e.target.value.toLowerCase() })
                      }
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="f-name">Nome da TV</label>
                    <input
                      id="f-name"
                      type="text"
                      required
                      placeholder="Ex: TV 04 - Sala de Reunião"
                      value={formData.name}
                      onChange={(e) =>
                        setFormData({ ...formData, name: e.target.value })
                      }
                    />
                  </div>
                </div>

                <div className="form-row-3">
                  <div className="form-group">
                    <label htmlFor="f-user">Usuário Unix Dedicado</label>
                    <input
                      id="f-user"
                      type="text"
                      required
                      pattern="^[a-z_][a-z0-9_-]{1,30}$"
                      placeholder="Ex: tv04 (proibido root)"
                      value={formData.unix_user}
                      onChange={(e) =>
                        setFormData({ ...formData, unix_user: e.target.value })
                      }
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="f-port">Porta Local Shadow (3391–3499)</label>
                    <input
                      id="f-port"
                      type="number"
                      required
                      min={3391}
                      max={3499}
                      value={formData.local_port}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          local_port: Number(e.target.value),
                        })
                      }
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="f-location">Localização Física</label>
                    <input
                      id="f-location"
                      type="text"
                      placeholder="Ex: Bloco B / Recepção"
                      value={formData.location}
                      onChange={(e) =>
                        setFormData({ ...formData, location: e.target.value })
                      }
                    />
                  </div>
                </div>

                <div className="form-row-2">
                  <div className="form-group">
                    <label htmlFor="f-sec">Camada de Segurança RDP</label>
                    <select
                      id="f-sec"
                      value={formData.sec_mode}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          sec_mode: e.target.value as "rdp" | "tls" | "nla",
                        })
                      }
                    >
                      <option value="rdp">/sec:rdp (Compatível com perfil testado tv03)</option>
                      <option value="tls">/sec:tls (Requer certificado TLS local)</option>
                      <option value="nla">/sec:nla (Requer arquivo SAM NTLM configurado)</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label htmlFor="f-display">Display X11 Esperado (Opcional)</label>
                    <input
                      id="f-display"
                      type="number"
                      min={0}
                      max={99}
                      placeholder="Auto-detectar da sessão XFCE"
                      value={formData.display_number ?? ""}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          display_number:
                            e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                </div>

                <fieldset className="checkbox-fieldset">
                  <legend>Parâmetros de Captura e Codec (`freerdp-shadow-cli3`)</legend>

                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={formData.gfx_enabled}
                      onChange={(e) =>
                        setFormData({ ...formData, gfx_enabled: e.target.checked })
                      }
                    />
                    <span>
                      Usar <code>-gfx</code> (desativa pipeline H.264/GFX problemático,
                      padrão validado em <code>tv03</code>)
                    </span>
                  </label>

                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={formData.server_side_cursor}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          server_side_cursor: e.target.checked,
                        })
                      }
                    />
                    <span>
                      Usar <code>+server-side-cursor</code> (renderiza ponteiro do mouse
                      com precisão)
                    </span>
                  </label>

                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={formData.shadow_auth_enabled}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          shadow_auth_enabled: e.target.checked,
                        })
                      }
                    />
                    <span>
                      Exigir <code>+auth</code> no próprio FreeRDP Shadow (somente ative
                      após validar PAM/SAM com o script de diagnóstico; se desmarcado,
                      opera com <code>-auth</code> estritamente isolado em{" "}
                      <code>127.0.0.1</code>)
                    </span>
                  </label>

                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={formData.enabled}
                      onChange={(e) =>
                        setFormData({ ...formData, enabled: e.target.checked })
                      }
                    />
                    <span>TV Habilitada para operação no painel</span>
                  </label>
                </fieldset>

                <div className="form-group">
                  <label htmlFor="f-notes">Observações Operacionais</label>
                  <textarea
                    id="f-notes"
                    rows={2}
                    value={formData.notes}
                    onChange={(e) =>
                      setFormData({ ...formData, notes: e.target.value })
                    }
                  />
                </div>

                <div className="flags-preview-box">
                  <small>Argumentos fixos gerados pelo servidor (sem shell arbitrário):</small>
                  <code>
                    freerdp-shadow-cli3 /port:{formData.local_port}{" "}
                    /bind-address:127.0.0.1{" "}
                    {formData.shadow_auth_enabled ? "+auth" : "-auth"} /sec:
                    {formData.sec_mode} {formData.gfx_enabled ? "-gfx" : "+gfx"}{" "}
                    {formData.server_side_cursor
                      ? "+server-side-cursor"
                      : "-server-side-cursor"}
                  </code>
                </div>

                <div className="form-actions">
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={formSubmitting}
                  >
                    {formSubmitting
                      ? "Salvando..."
                      : editingTvId === null
                      ? "Cadastrar TV"
                      : "Salvar Alterações"}
                  </button>
                  {editingTvId !== null && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handleResetForm}
                    >
                      Cancelar Edição
                    </button>
                  )}
                </div>
              </form>
            </section>

            <section className="admin-panel">
              <h2>Inventário e Controle de Serviços Systemd</h2>
              <p className="panel-subtitle">
                Gerencie o estado das unidades <code>tv-shadow@&lt;usuario&gt;.service</code>.
                Ações de parada ou reinício exigem confirmação explícita e nunca afetam o
                XRDP na porta 3389.
              </p>

              <div className="table-responsive">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>TV / Usuário</th>
                      <th>Endpoint Local</th>
                      <th>Sessão XFCE</th>
                      <th>Serviço Shadow</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tvs.map((tv) => (
                      <tr key={tv.id}>
                        <td>
                          <strong>{tv.name}</strong>
                          <div className="sub-cell">
                            <code>{tv.slug}</code> • user: <code>{tv.unix_user}</code>
                          </div>
                        </td>
                        <td>
                          <code>127.0.0.1:{tv.local_port}</code>
                          <div className="sub-cell">
                            <code>{tv.effective_shadow_flags_preview}</code>
                          </div>
                        </td>
                        <td>
                          <span
                            className={`indicator-badge xfce-${tv.runtime.xfce_session_state}`}
                          >
                            {labelXfceState(
                              tv.runtime.xfce_session_state,
                              tv.runtime.detected_display
                            )}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`indicator-badge shadow-${tv.runtime.shadow_service_state}`}
                          >
                            {labelShadowState(
                              tv.runtime.shadow_service_state,
                              tv.local_port
                            )}
                          </span>
                        </td>
                        <td className="actions-cell">
                          <button
                            type="button"
                            className="btn btn-secondary btn-xs"
                            onClick={() => handleStartEdit(tv)}
                          >
                            Editar
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-xs"
                            onClick={() => triggerServiceAction(tv, "start")}
                            disabled={!tv.enabled}
                          >
                            Iniciar
                          </button>
                          <button
                            type="button"
                            className="btn btn-warning btn-xs"
                            onClick={() => triggerServiceAction(tv, "restart")}
                            disabled={!tv.enabled}
                          >
                            Reiniciar
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger btn-xs"
                            onClick={() => triggerServiceAction(tv, "stop")}
                          >
                            Parar
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        {activeTab === "audit" && (
          <section className="admin-panel">
            <div className="panel-header">
              <div>
                <h2>Trilha de Auditoria e Limites de Segurança</h2>
                <p className="panel-subtitle">
                  Registro de autenticações, conexões ao vivo e alterações administrativas
                  (sem armazenamento de senhas, chaves ou tokens).
                </p>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void loadAuditLogs()}
              >
                Atualizar Logs
              </button>
            </div>

            <div className="security-notice-box">
              <h3>Aviso Técnico sobre Autenticação do FreeRDP Shadow (`-auth` vs `+auth`)</h3>
              <p>
                No binário <code>freerdp-shadow-cli3</code> (pacote{" "}
                <code>freerdp3-shadow-x11</code> do Debian 13), o parâmetro{" "}
                <code>-auth</code> <strong>desativa</strong> a autenticação RDP no
                listener Shadow, enquanto <code>+auth</code> a ativa (exigindo arquivo
                SAM NTLM para NLA ou configuração PAM funcional com{" "}
                <code>-sec-nla +auth</code>). Como a autenticação nativa do Shadow pode
                falhar sem privilégios de leitura de shadow/SAM, este painel isola todos
                os processos Shadow estritamente em <code>127.0.0.1</code> (com bloqueio
                de rede via systemd <code>IPAddressAllow=127.0.0.1/32</code> e firewall)
                e aplica autenticação administrativa forte, proteção CSRF e auditoria no
                gateway web HTTPS.
              </p>
            </div>

            <div className="table-responsive">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Data/Hora</th>
                    <th>Administrador</th>
                    <th>IP</th>
                    <th>Ação</th>
                    <th>Alvo</th>
                    <th>Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.map((log) => (
                    <tr key={log.id}>
                      <td>{formatDateTimePtBr(log.timestamp)}</td>
                      <td>{log.actor_username || "—"}</td>
                      <td>
                        <code>{log.ip_address || "—"}</code>
                      </td>
                      <td>
                        <code>{log.action}</code>
                      </td>
                      <td>
                        {log.target_type}: <strong>{log.target_id || "—"}</strong>
                      </td>
                      <td>
                        <span className={`outcome-badge outcome-${log.outcome}`}>
                          {log.outcome}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>

      {/* Modal de Confirmação Explícita */}
      {pendingConfirmation && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-modal-title"
        >
          <div className="modal-box">
            <h3 id="confirm-modal-title">{pendingConfirmation.title}</h3>
            <p>{pendingConfirmation.description}</p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setPendingConfirmation(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void pendingConfirmation.onConfirm()}
              >
                {pendingConfirmation.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Visão ao Vivo Guacamole Shadow RDP */}
      {activeViewerTv && (
        <LiveShadowViewer
          tv={activeViewerTv}
          csrfToken={session.csrf_token}
          onClose={() => setActiveViewerTv(null)}
          onStateUpdated={() => void loadTVs()}
        />
      )}
    </div>
  );
};

