import React, { useCallback, useEffect, useMemo, useState } from "react";
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
      return "Online • Pronta";
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
      return "Sem Login Gráfico";
    case "unknown":
    default:
      return "Desconhecido";
  }
}

function labelShadowState(state: ShadowServiceState, port: number): string {
  switch (state) {
    case "available":
      return `Ouvindo 127.0.0.1:${port}`;
    case "unavailable":
      return "Parado / Indisponível";
    case "conflict":
      return `Conflito na Porta ${port}`;
    case "starting":
      return "Iniciando Serviço...";
    case "error":
      return "Falha no Systemd";
    case "unknown":
    default:
      return "Desconhecido";
  }
}

function labelViewerState(state: ViewerConnectionState, count: number): string {
  switch (state) {
    case "connected":
      return `Em Uso (${count} conectado${count > 1 ? "s" : ""})`;
    case "idle":
      return "Livre para Acesso";
    case "unknown":
    default:
      return "Desconhecido";
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
  sec_mode: "tls",
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

type StatusFilter = "all" | "online" | "degraded" | "offline";

export const App: React.FC = () => {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authChecking, setAuthChecking] = useState<boolean>(true);
  const [loginUser, setLoginUser] = useState<string>("");
  const [loginPass, setLoginPass] = useState<string>("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState<boolean>(false);

  const [activeTab, setActiveTab] = useState<"dashboard" | "admin" | "audit">(
    "dashboard"
  );
  const [tvs, setTvs] = useState<TVItem[]>([]);
  const [tvsLoading, setTvsLoading] = useState<boolean>(false);
  const [apiFetchFailed, setApiFetchFailed] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const [searchQuery, setSearchQuery] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [activeViewerTv, setActiveViewerTv] = useState<TVItem | null>(null);

  // Modal de criação/edição rápida de TV
  const [isFormModalOpen, setIsFormModalOpen] = useState<boolean>(false);
  const [editingTvId, setEditingTvId] = useState<number | null>(null);
  const [formData, setFormData] = useState<TVFormPayload>(INITIAL_FORM);
  const [formSubmitting, setFormSubmitting] = useState<boolean>(false);
  const [busyTvId, setBusyTvId] = useState<number | null>(null);

  // Modal de confirmação explícita para ações que interrompam sessão/serviço
  const [pendingConfirmation, setPendingConfirmation] =
    useState<PendingConfirmation | null>(null);

  // Logs de auditoria
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);

  const loadTVs = useCallback(async (silent = false) => {
    if (!silent) {
      setTvsLoading(true);
    }
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
      if (!silent) {
        setTvsLoading(false);
      }
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

  // Atualização periódica silenciosa (pausa durante visualização ao vivo para zero lag no vídeo)
  useEffect(() => {
    if (!session) return;
    void loadTVs(false);
  }, [session, loadTVs]);

  useEffect(() => {
    if (!session || activeViewerTv !== null) return;
    const timer = window.setInterval(() => {
      void loadTVs(true);
    }, 6000);
    return () => window.clearInterval(timer);
  }, [session, activeViewerTv, loadTVs]);

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

  const handleOpenCreateModal = () => {
    setEditingTvId(null);
    const maxPort = tvs.reduce(
      (acc, item) => Math.max(acc, item.local_port),
      3393
    );
    setFormData({
      ...INITIAL_FORM,
      local_port: Math.min(3499, maxPort + 1),
    });
    setActionFeedback(null);
    setIsFormModalOpen(true);
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
    setActionFeedback(null);
    setIsFormModalOpen(true);
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
          text: `TV '${formData.name}' (${formData.slug}) cadastrada com sucesso na porta 127.0.0.1:${formData.local_port}.`,
        });
      } else {
        await api.updateTV(
          editingTvId,
          { ...formData, confirm_disruption: confirmDisruption },
          session.csrf_token
        );
        setActionFeedback({
          type: "success",
          text: `Configuração da TV '${formData.name}' salva com sucesso.`,
        });
      }
      setIsFormModalOpen(false);
      await loadTVs(true);
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        !confirmDisruption &&
        editingTvId !== null
      ) {
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
      setBusyTvId(tv.id);
      try {
        const updated = await api.controlService(
          tv.id,
          action,
          confirmed,
          session.csrf_token
        );
        setTvs((prev) =>
          prev.map((item) => (item.id === updated.id ? updated : item))
        );
        setActionFeedback({
          type: "success",
          text: `Ação '${action.toUpperCase()}' concluída para ${tv.name} (${tv.runtime.systemd_unit}).`,
        });
      } catch (err) {
        setActionFeedback({
          type: "error",
          text:
            err instanceof Error
              ? err.message
              : "Falha ao controlar o serviço systemd.",
        });
      } finally {
        setBusyTvId(null);
      }
    };

    if (
      action === "stop" ||
      action === "restart" ||
      tv.runtime.viewer_connection_state === "connected"
    ) {
      const actionLabel =
        action === "stop"
          ? "Parar Serviço Shadow"
          : "Reiniciar Serviço Shadow";
      setPendingConfirmation({
        title: `${actionLabel} — ${tv.name} (${tv.slug})`,
        description:
          tv.runtime.viewer_connection_state === "connected"
            ? `Há um operador conectado à ${tv.name} neste momento. Executar '${action}' interromperá imediatamente o espelhamento no navegador (a sessão gráfica XFCE na TV não será encerrada, e o XRDP na porta 3389 não será afetado). Deseja continuar?`
            : `Você está prestes a executar '${action}' na unidade ${tv.runtime.systemd_unit} (127.0.0.1:${tv.local_port}). A sessão XFCE local e o XRDP na porta 3389 serão preservados. Confirmar?`,
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

  const filteredTvs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return tvs.filter((tv) => {
      if (statusFilter === "online" && tv.runtime.overall_status !== "online") {
        return false;
      }
      if (
        statusFilter === "degraded" &&
        tv.runtime.overall_status !== "degraded"
      ) {
        return false;
      }
      if (
        statusFilter === "offline" &&
        !["offline", "disabled", "unknown"].includes(tv.runtime.overall_status)
      ) {
        return false;
      }
      if (!q) return true;
      return (
        tv.name.toLowerCase().includes(q) ||
        tv.slug.toLowerCase().includes(q) ||
        tv.unix_user.toLowerCase().includes(q) ||
        tv.location.toLowerCase().includes(q) ||
        String(tv.local_port).includes(q)
      );
    });
  }, [tvs, searchQuery, statusFilter]);

  if (authChecking) {
    return (
      <div className="centered-screen">
        <div className="spinner" />
        <p className="muted-label">Carregando Console Operacional...</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="login-page">
        <div className="login-glow" />
        <div className="login-card">
          <div className="login-header">
            <span className="security-tag">
              🔒 HTTPS • Loopback Shadow • Debian 13
            </span>
            <h1>Console Operacional de TVs</h1>
            <p>
              Administração e espelhamento ao vivo de sessões XFCE existentes via
              Apache Guacamole (<code>guacd</code>) e FreeRDP 3 Shadow.
            </p>
          </div>

          {loginError && (
            <div className="alert alert-error" role="alert">
              <span>{loginError}</span>
            </div>
          )}

          <form onSubmit={handleLoginSubmit} className="login-form">
            <div className="form-group">
              <label htmlFor="username">Operador / Administrador</label>
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
              <label htmlFor="password">Senha de Acesso</label>
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
              className="btn btn-primary btn-block btn-lg"
              disabled={loginLoading}
            >
              {loginLoading ? "Autenticando..." : "Acessar Painel de Controle"}
            </button>
          </form>

          <footer className="login-footer">
            <small>
              XRDP principal (porta <code>3389</code>) isolado e preservado.
              Todos os serviços Shadow escutam exclusivamente em{" "}
              <code>127.0.0.1</code>.
            </small>
          </footer>
        </div>
      </div>
    );
  }

  const onlineCount = tvs.filter(
    (t) => t.runtime.overall_status === "online"
  ).length;
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
          <div className="brand-icon">📺</div>
          <div>
            <div className="brand-title-row">
              <h1>NOC • Painel TV Shadow RDP</h1>
              <span className="live-indicator-chip">
                <span className="pulse-dot" /> Tempo Real
              </span>
            </div>
            <span className="env-pill">
              Debian 13 Trixie • XRDP <code>:3389</code> Intacto • Loopback{" "}
              <code>127.0.0.1</code>
            </span>
          </div>
        </div>

        <nav className="nav-tabs" aria-label="Navegação principal">
          <button
            type="button"
            className={`nav-tab ${activeTab === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            Monitoramento ao Vivo ({tvs.length})
          </button>
          <button
            type="button"
            className={`nav-tab ${activeTab === "admin" ? "active" : ""}`}
            onClick={() => setActiveTab("admin")}
          >
            Inventário & Portas
          </button>
          <button
            type="button"
            className={`nav-tab ${activeTab === "audit" ? "active" : ""}`}
            onClick={() => setActiveTab("audit")}
          >
            Auditoria de Segurança
          </button>
        </nav>

        <div className="user-area">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleOpenCreateModal}
          >
            + Nova TV
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void loadTVs(false)}
            disabled={tvsLoading}
            title="Forçar atualização imediata do estado das TVs"
          >
            {tvsLoading ? "Atualizando..." : "↻ Sincronizar"}
          </button>
          <div className="user-pill">
            <span className="user-avatar">
              {session.username.slice(0, 2).toUpperCase()}
            </span>
            <span className="user-name">{session.username}</span>
          </div>
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
            <div>
              <strong>Estado Desconhecido:</strong> {apiFetchFailed} Nenhuma
              sessão é exibida como "Online" enquanto a comunicação com a API
              não for confirmada.
            </div>
          </div>
        )}

        {actionFeedback && (
          <div
            className={`alert ${
              actionFeedback.type === "success"
                ? "alert-success"
                : "alert-error"
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

        {/* KPIs Operacionais Distintos */}
        <section className="metrics-strip" aria-label="Resumo operacional">
          <div className="metric-box metric-box-emerald">
            <div className="metric-top">
              <span className="metric-label">TVs Prontas (Online)</span>
              <span className="metric-icon">●</span>
            </div>
            <strong className="metric-value status-text-online">
              {onlineCount} <small>/ {tvs.length}</small>
            </strong>
            <span className="metric-sub">
              Sessão XFCE + Listener Shadow prontos
            </span>
          </div>

          <div className="metric-box metric-box-blue">
            <div className="metric-top">
              <span className="metric-label">Sessões Gráficas XFCE</span>
              <span className="metric-icon">🖥</span>
            </div>
            <strong className="metric-value">{xfceActiveCount}</strong>
            <span className="metric-sub">
              Desktops X11 autenticados nas TVs
            </span>
          </div>

          <div className="metric-box metric-box-indigo">
            <div className="metric-top">
              <span className="metric-label">Listeners FreeRDP Shadow</span>
              <span className="metric-icon">⚡</span>
            </div>
            <strong className="metric-value">{shadowAvailableCount}</strong>
            <span className="metric-sub">
              Portas ativas em <code>127.0.0.1</code>
            </span>
          </div>

          <div className="metric-box metric-box-cyan">
            <div className="metric-top">
              <span className="metric-label">Operadores Conectados</span>
              <span className="metric-icon">👁</span>
            </div>
            <strong className="metric-value status-text-connected">
              {connectedViewersCount}
            </strong>
            <span className="metric-sub">
              Espelhamentos ativos no navegador
            </span>
          </div>
        </section>

        {activeTab === "dashboard" && (
          <>
            {/* Barra de Busca e Filtros Rápidos */}
            <div className="toolbar-strip">
              <div className="filter-pills">
                <button
                  type="button"
                  className={`filter-pill ${
                    statusFilter === "all" ? "active" : ""
                  }`}
                  onClick={() => setStatusFilter("all")}
                >
                  Todas ({tvs.length})
                </button>
                <button
                  type="button"
                  className={`filter-pill ${
                    statusFilter === "online" ? "active" : ""
                  }`}
                  onClick={() => setStatusFilter("online")}
                >
                  Online ({onlineCount})
                </button>
                <button
                  type="button"
                  className={`filter-pill ${
                    statusFilter === "degraded" ? "active" : ""
                  }`}
                  onClick={() => setStatusFilter("degraded")}
                >
                  Atenção (
                  {
                    tvs.filter((t) => t.runtime.overall_status === "degraded")
                      .length
                  }
                  )
                </button>
                <button
                  type="button"
                  className={`filter-pill ${
                    statusFilter === "offline" ? "active" : ""
                  }`}
                  onClick={() => setStatusFilter("offline")}
                >
                  Offline / Outras (
                  {
                    tvs.filter((t) =>
                      ["offline", "disabled", "unknown"].includes(
                        t.runtime.overall_status
                      )
                    ).length
                  }
                  )
                </button>
              </div>

              <div className="search-box">
                <input
                  type="search"
                  placeholder="Filtrar por nome, usuário (tv03), local ou porta (3393)..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </div>

            {filteredTvs.length === 0 ? (
              <div className="empty-state-card">
                <h3>Nenhuma TV encontrada para o filtro selecionado</h3>
                <p>
                  Limpe o campo de busca ou cadastre uma nova TV no inventário.
                </p>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setSearchQuery("");
                    setStatusFilter("all");
                  }}
                >
                  Mostrar Todas as TVs
                </button>
              </div>
            ) : (
              <section
                className="tv-grid"
                aria-label="Cartões das TVs cadastradas"
              >
                {filteredTvs.map((tv) => {
                  const rt = tv.runtime;
                  const canOpenLive =
                    tv.enabled &&
                    rt.overall_status === "online" &&
                    rt.xfce_session_state === "active" &&
                    rt.shadow_service_state === "available";
                  const isBusy = busyTvId === tv.id;

                  return (
                    <article
                      key={tv.id}
                      className={`tv-card tv-card-${rt.overall_status}`}
                    >
                      <header className="tv-card-header">
                        <div className="tv-header-main">
                          <div className="tv-card-title-row">
                            <h2>{tv.name}</h2>
                            <span className="mono-badge">{tv.slug}</span>
                          </div>
                          <p className="tv-location">
                            📍 {tv.location || "Local não informado"}
                          </p>
                        </div>
                        <span
                          className={`status-pill status-${rt.overall_status}`}
                        >
                          <span className="status-dot" />
                          {labelOverallStatus(rt.overall_status)}
                        </span>
                      </header>

                      {/* Chips Técnicos Rápidos */}
                      <div className="tech-chips-row">
                        <span className="tech-chip">
                          👤 Usuário: <code>{tv.unix_user}</code>
                        </span>
                        <span className="tech-chip">
                          🔌 Loopback: <code>127.0.0.1:{tv.local_port}</code>
                        </span>
                        {rt.detected_display && (
                          <span className="tech-chip">
                            🖥 Display: <code>{rt.detected_display}</code>
                          </span>
                        )}
                      </div>

                      {/* 3 Indicadores Separados de Estado */}
                      <div className="indicators-list">
                        <div className="indicator-row">
                          <span className="indicator-label">
                            1. Sessão Gráfica XFCE
                          </span>
                          <span
                            className={`indicator-badge xfce-${rt.xfce_session_state}`}
                          >
                            {labelXfceState(
                              rt.xfce_session_state,
                              rt.detected_display
                            )}
                          </span>
                        </div>

                        <div className="indicator-row">
                          <span className="indicator-label">
                            2. Listener FreeRDP Shadow
                          </span>
                          <span
                            className={`indicator-badge shadow-${rt.shadow_service_state}`}
                          >
                            {labelShadowState(
                              rt.shadow_service_state,
                              tv.local_port
                            )}
                          </span>
                        </div>

                        <div className="indicator-row">
                          <span className="indicator-label">
                            3. Espectador / Controle
                          </span>
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
                            Unidade: <code>{rt.systemd_unit}</code> (
                            {rt.systemd_active_state})
                          </span>
                          <span>
                            Verificado: {formatDateTimePtBr(rt.last_checked_at)}
                          </span>
                        </div>
                      </div>

                      <footer className="tv-card-footer">
                        <button
                          type="button"
                          className={`btn ${
                            canOpenLive ? "btn-primary btn-glow" : "btn-secondary"
                          } btn-live-open`}
                          disabled={!canOpenLive}
                          onClick={() => setActiveViewerTv(tv)}
                          title={
                            canOpenLive
                              ? "Abrir espelhamento ao vivo com controle de teclado e mouse"
                              : "Disponível quando a sessão XFCE está ativa e o Shadow está ouvindo em 127.0.0.1"
                          }
                        >
                          ▶ Abrir Tela ao Vivo
                        </button>

                        <div className="card-secondary-actions">
                          {tv.enabled &&
                            rt.shadow_service_state !== "available" && (
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                disabled={isBusy}
                                onClick={() =>
                                  triggerServiceAction(tv, "start")
                                }
                              >
                                {isBusy ? "..." : "Iniciar Shadow"}
                              </button>
                            )}
                          {tv.enabled &&
                            rt.shadow_service_state === "available" && (
                              <button
                                type="button"
                                className="btn btn-warning btn-sm"
                                disabled={isBusy}
                                onClick={() =>
                                  triggerServiceAction(tv, "restart")
                                }
                              >
                                {isBusy ? "..." : "Reiniciar"}
                              </button>
                            )}
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleStartEdit(tv)}
                          >
                            ⚙ Configurar
                          </button>
                        </div>
                      </footer>
                    </article>
                  );
                })}
              </section>
            )}
          </>
        )}

        {activeTab === "admin" && (
          <section className="admin-panel">
            <div className="panel-header">
              <div>
                <h2>Inventário de TVs e Alocação de Portas Loopback</h2>
                <p className="panel-subtitle">
                  Cada TV utiliza um usuário Unix exclusivo e uma porta local em{" "}
                  <code>127.0.0.1</code> (faixa <code>3391–3499</code>). A porta{" "}
                  <code>3389</code> do XRDP nunca é alterada.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleOpenCreateModal}
              >
                + Cadastrar Nova TV
              </button>
            </div>

            <div className="table-responsive">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>TV / Identificador</th>
                    <th>Usuário Unix</th>
                    <th>Endpoint Loopback</th>
                    <th>Sessão XFCE</th>
                    <th>Serviço Shadow</th>
                    <th>Flags FreeRDP</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {tvs.map((tv) => (
                    <tr key={tv.id}>
                      <td>
                        <strong>{tv.name}</strong>{" "}
                        <span className="mono-badge">{tv.slug}</span>
                        <div className="sub-cell">{tv.location}</div>
                      </td>
                      <td>
                        <code>{tv.unix_user}</code>
                      </td>
                      <td>
                        <code>127.0.0.1:{tv.local_port}</code>
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
                      <td>
                        <code className="flags-code">
                          {tv.effective_shadow_flags_preview}
                        </code>
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
                        >
                          Start
                        </button>
                        <button
                          type="button"
                          className="btn btn-warning btn-xs"
                          onClick={() => triggerServiceAction(tv, "restart")}
                        >
                          Restart
                        </button>
                        <button
                          type="button"
                          className="btn btn-outline-danger btn-xs"
                          onClick={() => triggerServiceAction(tv, "stop")}
                        >
                          Stop
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {activeTab === "audit" && (
          <section className="admin-panel">
            <div className="panel-header">
              <div>
                <h2>Trilha de Auditoria e Eventos Operacionais</h2>
                <p className="panel-subtitle">
                  Registro de logins, conexões ao vivo, alterações de inventário
                  e controle de unidades systemd (sem exposição de segredos).
                </p>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void loadAuditLogs()}
              >
                ↻ Atualizar Logs
              </button>
            </div>

            <div className="security-notice-box">
              <h3>Arquitetura de Isolamento Ativa</h3>
              <p>
                • <strong>XRDP Principal Preservado:</strong> O serviço{" "}
                <code>xrdp</code> na porta <code>*:3389</code> permanece
                intocado para o login gráfico das TVs.
                <br />• <strong>Loopback Estrito:</strong> Os serviços{" "}
                <code>tv-shadow@&lt;usuario&gt;.service</code> escutam somente
                em <code>127.0.0.1</code> com restrição de cgroup{" "}
                <code>IPAddressAllow=127.0.0.1/32</code>.
              </p>
            </div>

            <div className="table-responsive">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Data/Hora</th>
                    <th>Administrador</th>
                    <th>IP Origem</th>
                    <th>Ação</th>
                    <th>Alvo</th>
                    <th>Resultado</th>
                    <th>Detalhes</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.map((log) => (
                    <tr key={log.id}>
                      <td>{formatDateTimePtBr(log.timestamp)}</td>
                      <td>
                        <code>{log.actor_username || "—"}</code>
                      </td>
                      <td>
                        <code>{log.ip_address || "—"}</code>
                      </td>
                      <td>
                        <strong>{log.action}</strong>
                      </td>
                      <td>
                        {log.target_type}: <code>{log.target_id || "—"}</code>
                      </td>
                      <td>
                        <span
                          className={`status-pill ${
                            log.outcome === "success"
                              ? "status-online"
                              : log.outcome === "denied"
                              ? "status-degraded"
                              : "status-unknown"
                          }`}
                        >
                          {log.outcome}
                        </span>
                      </td>
                      <td>
                        <code>{JSON.stringify(log.details)}</code>
                      </td>
                    </tr>
                  ))}
                  {auditLogs.length === 0 && (
                    <tr>
                      <td colSpan={7}>Nenhum evento registrado até o momento.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>

      {/* Modal de Cadastro / Edição de TV */}
      {isFormModalOpen && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="tv-form-modal-title"
        >
          <div className="modal-box modal-box-lg">
            <div className="panel-header">
              <h3 id="tv-form-modal-title">
                {editingTvId === null
                  ? "Cadastrar Nova TV"
                  : `Configurar ${formData.name} (${formData.slug})`}
              </h3>
              <button
                type="button"
                className="alert-close"
                onClick={() => setIsFormModalOpen(false)}
              >
                ×
              </button>
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
                      setFormData({
                        ...formData,
                        slug: e.target.value.toLowerCase(),
                      })
                    }
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="f-name">Nome de Exibição da TV</label>
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
                  <label htmlFor="f-user">Usuário Unix da Sessão XFCE</label>
                  <input
                    id="f-user"
                    type="text"
                    required
                    pattern="^[a-z_][a-z0-9_-]{1,30}$"
                    placeholder="Ex: tv04"
                    value={formData.unix_user}
                    onChange={(e) =>
                      setFormData({ ...formData, unix_user: e.target.value })
                    }
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="f-port">Porta Loopback (3391–3499)</label>
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
                    placeholder="Ex: Recepção / NOC"
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
                    <option value="tls">
                      TLS Local (/sec:tls — Recomendado p/ FreeRDP 3 + guacd)
                    </option>
                    <option value="rdp">Standard RDP (/sec:rdp)</option>
                    <option value="nla">NLA (/sec:nla)</option>
                  </select>
                </div>

                <div className="form-group">
                  <label htmlFor="f-notes">Observações Operacionais</label>
                  <input
                    id="f-notes"
                    type="text"
                    placeholder="Opcional"
                    value={formData.notes}
                    onChange={(e) =>
                      setFormData({ ...formData, notes: e.target.value })
                    }
                  />
                </div>
              </div>

              <fieldset className="checkbox-fieldset">
                <legend>Parâmetros Fixos do FreeRDP Shadow</legend>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={formData.gfx_enabled}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        gfx_enabled: e.target.checked,
                      })
                    }
                  />
                  <span>
                    Modo de compatibilidade de superfície (<code>-gfx</code>)
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
                    Renderizar ponteiro do mouse no servidor (
                    <code>+server-side-cursor</code>)
                  </span>
                </label>

                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={!formData.shadow_auth_enabled}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        shadow_auth_enabled: !e.target.checked,
                      })
                    }
                  />
                  <span>
                    Autenticação delegada ao painel e loopback (
                    <code>-auth</code> em <code>127.0.0.1</code>)
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
                  <span>
                    <strong>TV Habilitada no Painel</strong>
                  </span>
                </label>
              </fieldset>

              <div className="flags-preview-box">
                <small>Linha de comando efetiva gerada pelo wrapper:</small>
                <code>
                  freerdp-shadow-cli3 /port:{formData.local_port}{" "}
                  /bind-address:127.0.0.1{" "}
                  {formData.shadow_auth_enabled ? "+auth" : "-auth"} /sec:tls{" "}
                  {formData.gfx_enabled ? "-gfx" : "+gfx"}{" "}
                  {formData.server_side_cursor
                    ? "+server-side-cursor"
                    : "-server-side-cursor"}{" "}
                  +may-view +may-interact
                </code>
              </div>

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsFormModalOpen(false)}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={formSubmitting}
                >
                  {formSubmitting
                    ? "Salvando..."
                    : editingTvId === null
                    ? "Cadastrar TV"
                    : "Salvar Configurações"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

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

      {/* Visualizador ao Vivo Guacamole */}
      {activeViewerTv && (
        <LiveShadowViewer
          tv={activeViewerTv}
          csrfToken={session.csrf_token}
          onClose={() => setActiveViewerTv(null)}
          onStateUpdated={() => void loadTVs(true)}
        />
      )}
    </div>
  );
};
