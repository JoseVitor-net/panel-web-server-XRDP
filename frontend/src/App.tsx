import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api";
import { LiveShadowViewer } from "./components/LiveShadowViewer";
import { MiniTvPreview } from "./components/MiniTvPreview";
import { NetworkPortLed, StateIcon, StatusBadge } from "./components/StatusIcons";
import {
  AuditLogItem,
  AuthSession,
  OverallStatus,
  SystemOverviewTelemetry,
  TVFormPayload,
  TVItem,
  UserItem,
} from "./types";

const INITIAL_FORM: TVFormPayload = {
  slug: "",
  name: "",
  location: "",
  unix_user: "",
  local_port: 3394,
  display_number: null,
  sec_mode: "rdp",
  gfx_enabled: true,
  server_side_cursor: true,
  shadow_auth_enabled: false,
  enabled: true,
  notes: "",
  unix_password: "",
};

function formatDate(val: string | null | undefined): string {
  if (!val) return "Nunca";
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return val;
    return d.toLocaleString("pt-BR");
  } catch {
    return val;
  }
}

function statusLabel(
  status: OverallStatus,
  shadowState?: TVItem["runtime"]["shadow_service_state"]
): string {
  switch (status) {
    case "online":
      return "Sinal Ativo";
    case "offline":
      return "Sem Sessão XFCE";
    case "degraded":
      return shadowState === "starting"
        ? "Sincronizando Shadow"
        : "Shadow Indisponível";
    case "disabled":
      return "Desabilitada";
    case "unknown":
    default:
      return "Não Verificado";
  }
}

function xfceStateText(state: TVItem["runtime"]["xfce_session_state"]): string {
  switch (state) {
    case "active":
      return "Ativa";
    case "inactive":
      return "Inativa";
    default:
      return "Indefinida";
  }
}

function shadowStateText(
  state: TVItem["runtime"]["shadow_service_state"]
): string {
  switch (state) {
    case "available":
      return "Escutando";
    case "starting":
      return "Iniciando";
    case "unavailable":
      return "Indisponível";
    case "conflict":
      return "Conflito Porta";
    case "error":
      return "Erro Serviço";
    default:
      return "Indefinido";
  }
}

function viewerStateText(
  state: TVItem["runtime"]["viewer_connection_state"],
  count: number
): string {
  switch (state) {
    case "connected":
      return `${count} Operador${count > 1 ? "es" : ""} ao Vivo`;
    case "idle":
      return "Aguardando Visão";
    default:
      return "Indefinido";
  }
}

interface PendingConfirmation {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
}

type StatusFilter = "all" | "online" | "attention" | "offline";

export const App: React.FC = () => {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authChecking, setAuthChecking] = useState<boolean>(true);

  const [loginUser, setLoginUser] = useState<string>("");
  const [loginPass, setLoginPass] = useState<string>("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState<boolean>(false);

  const [tvs, setTvs] = useState<TVItem[]>([]);
  const [tvsLoading, setTvsLoading] = useState<boolean>(false);
  const [apiFetchFailed, setApiFetchFailed] = useState<string | null>(null);
  const [bannerNotice, setBannerNotice] = useState<{
    type: "success" | "error" | "info";
    text: string;
  } | null>(null);

  const [activeTab, setActiveTab] = useState<
    "dashboard" | "resources" | "admin" | "users" | "audit"
  >("dashboard");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [activeViewerTv, setActiveViewerTv] = useState<TVItem | null>(null);
  const [sysTelemetry, setSysTelemetry] =
    useState<SystemOverviewTelemetry | null>(null);

  const [isFormModalOpen, setIsFormModalOpen] = useState<boolean>(false);
  const [editingTvId, setEditingTvId] = useState<number | null>(null);
  const [formData, setFormData] = useState<TVFormPayload>(INITIAL_FORM);
  const [formSubmitting, setFormSubmitting] = useState<boolean>(false);
  const [busyTvId, setBusyTvId] = useState<number | null>(null);

  const [pendingConfirmation, setPendingConfirmation] =
    useState<PendingConfirmation | null>(null);

  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);

  // Gestão de Usuários do Painel
  const [users, setUsers] = useState<UserItem[]>([]);
  const [usersLoading, setUsersLoading] = useState<boolean>(false);
  const [isUserModalOpen, setIsUserModalOpen] = useState<boolean>(false);
  const [userFormData, setUserFormData] = useState({
    username: "",
    password: "",
    confirmPassword: "",
    is_active: true,
  });
  const [userFormSubmitting, setUserFormSubmitting] = useState<boolean>(false);
  const [userResetModal, setUserResetModal] = useState<{
    userId: number;
    username: string;
  } | null>(null);
  const [userResetPassword, setUserResetPassword] = useState<string>("");
  const [userResetConfirm, setUserResetConfirm] = useState<string>("");
  const [userResetSubmitting, setUserResetSubmitting] =
    useState<boolean>(false);

  // Exclusão de Perfil de TV
  const [tvToDelete, setTvToDelete] = useState<TVItem | null>(null);
  const [tvDeleteSubmitting, setTvDeleteSubmitting] = useState<boolean>(false);

  // Exclusão de Usuário
  const [userToDelete, setUserToDelete] = useState<UserItem | null>(null);
  const [userDeleteSubmitting, setUserDeleteSubmitting] =
    useState<boolean>(false);

  const loadTVs = useCallback(async (silent = false) => {
    if (!silent) {
      setTvsLoading(true);
    }
    try {
      const [list, sys] = await Promise.all([
        api.listTVs(),
        api.getSystemTelemetry().catch(() => null),
      ]);
      setTvs(list);
      if (sys) {
        setSysTelemetry(sys);
      }
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

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const list = await api.listUsers();
      setUsers(list);
    } catch (err) {
      setBannerNotice({
        type: "error",
        text:
          err instanceof Error
            ? err.message
            : "Falha ao carregar lista de usuários do painel.",
      });
    } finally {
      setUsersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session && activeTab === "users") {
      void loadUsers();
    }
  }, [session, activeTab, loadUsers]);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) return;
    if (userFormData.password !== userFormData.confirmPassword) {
      setBannerNotice({
        type: "error",
        text: "As senhas digitadas não coincidem.",
      });
      return;
    }
    if (userFormData.password.length < 10) {
      setBannerNotice({
        type: "error",
        text: "A senha deve conter no mínimo 10 caracteres.",
      });
      return;
    }
    setUserFormSubmitting(true);
    try {
      await api.createUser(
        {
          username: userFormData.username.trim(),
          password: userFormData.password,
          is_active: userFormData.is_active,
        },
        session.csrf_token
      );
      setBannerNotice({
        type: "success",
        text: `Usuário '${userFormData.username}' cadastrado com sucesso.`,
      });
      setIsUserModalOpen(false);
      setUserFormData({
        username: "",
        password: "",
        confirmPassword: "",
        is_active: true,
      });
      void loadUsers();
    } catch (err) {
      setBannerNotice({
        type: "error",
        text:
          err instanceof Error
            ? err.message
            : "Falha ao cadastrar novo usuário.",
      });
    } finally {
      setUserFormSubmitting(false);
    }
  };

  const handleResetUserPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session || !userResetModal) return;
    if (userResetPassword !== userResetConfirm) {
      setBannerNotice({
        type: "error",
        text: "As senhas digitadas não coincidem.",
      });
      return;
    }
    if (userResetPassword.length < 10) {
      setBannerNotice({
        type: "error",
        text: "A nova senha deve conter no mínimo 10 caracteres.",
      });
      return;
    }
    setUserResetSubmitting(true);
    try {
      const res = await api.resetUserPassword(
        userResetModal.userId,
        userResetPassword,
        session.csrf_token
      );
      setBannerNotice({
        type: "success",
        text: res.message || "Senha redefinida com sucesso.",
      });
      setUserResetModal(null);
      setUserResetPassword("");
      setUserResetConfirm("");
      void loadUsers();
    } catch (err) {
      setBannerNotice({
        type: "error",
        text:
          err instanceof Error ? err.message : "Falha ao redefinir senha.",
      });
    } finally {
      setUserResetSubmitting(false);
    }
  };

  const handleToggleUserStatus = async (user: UserItem) => {
    if (!session) return;
    try {
      const updated = await api.toggleUserStatus(
        user.id,
        !user.is_active,
        session.csrf_token
      );
      setBannerNotice({
        type: "success",
        text: `Usuário '${updated.username}' agora está ${
          updated.is_active ? "ATIVO" : "BLOQUEADO"
        }.`,
      });
      void loadUsers();
    } catch (err) {
      setBannerNotice({
        type: "error",
        text:
          err instanceof Error
            ? err.message
            : "Falha ao alterar status do usuário.",
      });
    }
  };

  const handleDeleteUser = async () => {
    if (!session || !userToDelete) return;
    setUserDeleteSubmitting(true);
    try {
      const res = await api.deleteUser(userToDelete.id, session.csrf_token);
      setBannerNotice({
        type: "success",
        text: res.message || "Usuário excluído com sucesso.",
      });
      setUserToDelete(null);
      void loadUsers();
    } catch (err) {
      setBannerNotice({
        type: "error",
        text:
          err instanceof Error ? err.message : "Falha ao excluir usuário.",
      });
    } finally {
      setUserDeleteSubmitting(false);
    }
  };

  const handleConfirmDeleteTv = async () => {
    if (!session || !tvToDelete) return;
    setTvDeleteSubmitting(true);
    try {
      const res = await api.deleteTV(tvToDelete.id, session.csrf_token);
      setBannerNotice({
        type: "success",
        text: res.message || "Perfil da TV excluído com sucesso.",
      });
      if (editingTvId === tvToDelete.id) {
        setIsFormModalOpen(false);
        setEditingTvId(null);
      }
      if (activeViewerTv?.id === tvToDelete.id) {
        setActiveViewerTv(null);
      }
      setTvToDelete(null);
      void loadTVs(false);
    } catch (err) {
      setBannerNotice({
        type: "error",
        text:
          err instanceof Error ? err.message : "Falha ao excluir perfil da TV.",
      });
    } finally {
      setTvDeleteSubmitting(false);
    }
  };


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
      // limpa estado local
    }
    setSession(null);
    setActiveViewerTv(null);
  };

  const handleOpenCreateModal = () => {
    setEditingTvId(null);
    const maxPort = tvs.reduce(
      (acc, item) => Math.max(acc, item.local_port),
      3390
    );
    const nextNum = tvs.length + 1;
    const padded = String(nextNum).padStart(2, "0");
    setFormData({
      ...INITIAL_FORM,
      slug: `tv${padded}`,
      name: `TV ${padded}`,
      unix_user: `tv${padded}`,
      local_port: Math.min(3499, maxPort + 1),
    });
    setIsFormModalOpen(true);
  };

  const handleOpenEditModal = (tv: TVItem) => {
    setEditingTvId(tv.id);
    setFormData({
      slug: tv.slug,
      name: tv.name,
      location: tv.location || "",
      unix_user: tv.unix_user,
      local_port: tv.local_port,
      display_number: tv.display_number ?? null,
      sec_mode: tv.sec_mode,
      gfx_enabled: tv.gfx_enabled,
      server_side_cursor: tv.server_side_cursor,
      shadow_auth_enabled: tv.shadow_auth_enabled,
      enabled: tv.enabled,
      notes: tv.notes,
      unix_password: "",
    });
    setIsFormModalOpen(true);
  };

  const executeSaveForm = async (confirmDisruption: boolean) => {
    if (!session) return;
    setFormSubmitting(true);
    setBannerNotice(null);
    try {
      if (editingTvId === null) {
        await api.createTV(formData, session.csrf_token);
        setBannerNotice({
          type: "success",
          text: `TV '${formData.name}' e usuário Linux '${formData.unix_user}' criados com sucesso.`,
        });
      } else {
        await api.updateTV(
          editingTvId,
          { ...formData, confirm_disruption: confirmDisruption },
          session.csrf_token
        );
        setBannerNotice({
          type: "success",
          text: formData.unix_password?.trim()
            ? `Configurações e nova senha XRDP do usuário '${formData.unix_user}' aplicadas com sucesso.`
            : `Configurações da '${formData.name}' salvas com sucesso.`,
        });
      }
      setIsFormModalOpen(false);
      await loadTVs(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && editingTvId !== null) {
        setPendingConfirmation({
          title: "Confirmar alteração com sessão ativa",
          description:
            "Esta alteração modifica parâmetros de porta ou usuário em uma TV com espelhamento ou serviço ativo. Deseja prosseguir?",
          confirmLabel: "Confirmar e Aplicar",
          onConfirm: async () => {
            setPendingConfirmation(null);
            await executeSaveForm(true);
          },
        });
      } else {
        setBannerNotice({
          type: "error",
          text:
            err instanceof Error
              ? err.message
              : "Erro ao salvar configurações da TV.",
        });
      }
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await executeSaveForm(false);
  };

  const executeServiceAction = async (
    tv: TVItem,
    action: "start" | "stop" | "restart",
    confirmDisruption: boolean
  ) => {
    if (!session) return;
    setBusyTvId(tv.id);
    setBannerNotice(null);
    try {
      const updated = await api.controlService(
        tv.id,
        action,
        confirmDisruption,
        session.csrf_token
      );
      setTvs((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item))
      );
      setBannerNotice({
        type: "info",
        text: `Comando '${action.toUpperCase()}' aplicado em ${updated.runtime.systemd_unit}.`,
      });
    } catch (err) {
      setBannerNotice({
        type: "error",
        text:
          err instanceof Error
            ? err.message
            : `Erro ao executar ${action} no serviço Shadow.`,
      });
    } finally {
      setBusyTvId(null);
    }
  };

  const triggerServiceAction = (
    tv: TVItem,
    action: "start" | "stop" | "restart"
  ) => {
    if (
      action === "stop" ||
      action === "restart" ||
      tv.runtime.viewer_connection_state === "connected"
    ) {
      const actionVerb =
        action === "stop"
          ? "Parar"
          : action === "restart"
          ? "Reiniciar"
          : "Iniciar";
      setPendingConfirmation({
        title: `${actionVerb} ${tv.runtime.systemd_unit}?`,
        description: `Esta ação afeta apenas o servidor de espelhamento FreeRDP Shadow (${tv.runtime.systemd_unit} na porta 127.0.0.1:${tv.local_port}). A sessão gráfica XFCE na TV (${tv.unix_user}) e o serviço XRDP principal (porta 3389) permanecerão intactos.`,
        confirmLabel: `Sim, ${actionVerb} Serviço Shadow`,
        onConfirm: async () => {
          setPendingConfirmation(null);
          await executeServiceAction(tv, action, true);
        },
      });
    } else {
      void executeServiceAction(tv, action, false);
    }
  };

  const stats = useMemo(() => {
    const total = tvs.length;
    const online = tvs.filter(
      (t) => t.runtime.overall_status === "online"
    ).length;
    const xfceActive = tvs.filter(
      (t) => t.runtime.xfce_session_state === "active"
    ).length;
    const shadowReady = tvs.filter(
      (t) => t.runtime.shadow_service_state === "available"
    ).length;
    const activeViewers = tvs.reduce(
      (acc, t) => acc + (t.runtime.active_viewers_count || 0),
      0
    );
    return { total, online, xfceActive, shadowReady, activeViewers };
  }, [tvs]);

  const filteredTvs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return tvs.filter((tv) => {
      if (statusFilter === "online" && tv.runtime.overall_status !== "online") {
        return false;
      }
      if (
        statusFilter === "attention" &&
        tv.runtime.overall_status !== "degraded" &&
        tv.runtime.overall_status !== "unknown"
      ) {
        return false;
      }
      if (
        statusFilter === "offline" &&
        tv.runtime.overall_status !== "offline" &&
        tv.runtime.overall_status !== "disabled"
      ) {
        return false;
      }
      if (!q) return true;
      return (
        tv.name.toLowerCase().includes(q) ||
        tv.slug.toLowerCase().includes(q) ||
        tv.unix_user.toLowerCase().includes(q) ||
        String(tv.local_port).includes(q) ||
        (tv.notes && tv.notes.toLowerCase().includes(q))
      );
    });
  }, [tvs, searchQuery, statusFilter]);

  const handleCloseViewer = useCallback(() => {
    setActiveViewerTv(null);
  }, []);

  const handleViewerStateUpdated = useCallback(() => {
    void loadTVs(true);
  }, [loadTVs]);

  if (authChecking) {
    return (
      <div className="centered-screen">
        <div className="spinner" />
        <p className="muted-caption">Inicializando console NOC Display Ops...</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="login-page">
        <div className="login-ambient-grid" />
        <div className="login-glow" />
        <div className="login-card">
          <div className="login-header">
            <div className="login-brand-row">
              <div className="brand-logo-box">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <path d="M8 21h8M12 17v4" />
                  <path d="M7 10h2l2-3 2 6 2-3h2" />
                </svg>
              </div>
              <span className="security-tag">
                XRDP SHADOW NOC • CONSOLE DE OPERAÇÕES
              </span>
            </div>
            <h1>NOC Display Operations</h1>
            <p>
              Console central de monitoramento, telemetria de recursos e espelhamento em tempo real de
              sessões XFCE via FreeRDP Shadow &amp; Apache Guacamole.
            </p>
          </div>

          {loginError && (
            <div className="alert alert-error" role="alert">
              {loginError}
            </div>
          )}

          <form onSubmit={handleLoginSubmit} className="login-form">
            <label className="form-field">
              <span>Operador / Administrador</span>
              <input
                type="text"
                required
                autoComplete="username"
                value={loginUser}
                onChange={(e) => setLoginUser(e.target.value)}
                placeholder="Ex: operador_noc"
              />
            </label>

            <label className="form-field">
              <span>Credencial de Acesso</span>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={loginPass}
                onChange={(e) => setLoginPass(e.target.value)}
                placeholder="••••••••••••••••"
              />
            </label>

            <button
              type="submit"
              className="btn btn-primary btn-block btn-lg"
              disabled={loginLoading}
            >
              {loginLoading ? "Autenticando..." : "Acessar Console NOC"}
            </button>
          </form>

          <footer className="login-footer">
            <div className="login-arch-pills">
              <span>XRDP :3389 Isolado</span>
              <span>Bind 127.0.0.1</span>
              <span>Sessão Argon2id</span>
            </div>
          </footer>
        </div>
      </div>
    );
  }

  return (
    <div className="noc-layout">
      {/* Sidebar Esquerda de Comando */}
      <aside className="noc-sidebar">
        <div className="sidebar-brand">
          <div className="brand-logo-box">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8M12 17v4" />
              <path d="M7 10h2l2-3 2 6 2-3h2" />
            </svg>
          </div>
          <div>
            <div className="sidebar-title">NOC Display Ops</div>
            <div className="sidebar-subtitle">XRDP / XFCE Shadow Control</div>
          </div>
        </div>

        <div className="sidebar-section-label">MÓDULOS DE OPERAÇÃO</div>
        <nav className="sidebar-nav" aria-label="Navegação principal">
          <button
            type="button"
            className={`sidebar-link ${activeTab === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.85">
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
            </svg>
            <span>Video Wall ao Vivo</span>
            <span className="sidebar-badge">
              {stats.online}/{stats.total}
            </span>
          </button>

          <button
            type="button"
            className={`sidebar-link ${activeTab === "resources" ? "active" : ""}`}
            onClick={() => setActiveTab("resources")}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.85">
              <line x1="18" y1="20" x2="18" y2="10" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="6" y1="20" x2="6" y2="14" />
            </svg>
            <span>Recursos &amp; Comparativo</span>
            {sysTelemetry && (
              <span className="sidebar-badge sidebar-badge-neutral">
                {sysTelemetry.cpu_percent.toFixed(0)}%
              </span>
            )}
          </button>

          <button
            type="button"
            className={`sidebar-link ${activeTab === "admin" ? "active" : ""}`}
            onClick={() => setActiveTab("admin")}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.85">
              <rect x="2" y="4" width="20" height="6" rx="1.5" />
              <rect x="2" y="14" width="20" height="6" rx="1.5" />
              <line x1="6" y1="7" x2="6.01" y2="7" />
              <line x1="6" y1="17" x2="6.01" y2="17" />
            </svg>
            <span>Inventário &amp; Systemd</span>
            <span className="sidebar-badge sidebar-badge-neutral">
              {stats.total}
            </span>
          </button>

          <button
            type="button"
            className={`sidebar-link ${activeTab === "users" ? "active" : ""}`}
            onClick={() => setActiveTab("users")}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.85">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span>Gestão de Usuários</span>
            {users.length > 0 && (
              <span className="sidebar-badge sidebar-badge-neutral">
                {users.length}
              </span>
            )}
          </button>

          <button
            type="button"
            className={`sidebar-link ${activeTab === "audit" ? "active" : ""}`}
            onClick={() => setActiveTab("audit")}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.85">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
            <span>Trilha de Auditoria</span>
          </button>
        </nav>

        <div className="sidebar-QuickAction">
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={handleOpenCreateModal}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>Cadastrar Nova TV</span>
          </button>
        </div>

        <div className="sidebar-isolation-card">
          <div className="isolation-header">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span>ISOLAMENTO DE ARQUITETURA</span>
          </div>
          <ul className="isolation-list">
            <li>
              <span className="iso-dot iso-green" />
              <div>
                <strong>XRDP Principal (:3389)</strong>
                <small>Intocado para login das TVs</small>
              </div>
            </li>
            <li>
              <span className="iso-dot iso-cyan" />
              <div>
                <strong>Loopback 127.0.0.1</strong>
                <small>Portas 3391–3399 isoladas</small>
              </div>
            </li>
            <li>
              <span className="iso-dot iso-blue" />
              <div>
                <strong>Sessão X11 Existente</strong>
                <small>Anexa sem criar novo desktop</small>
              </div>
            </li>
          </ul>
        </div>

        <div className="sidebar-footer">
          <div className="operator-profile">
            <div className="operator-avatar">
              {session.username.slice(0, 2).toUpperCase()}
            </div>
            <div className="operator-meta">
              <strong>{session.username}</strong>
              <span>Operador Autenticado</span>
            </div>
          </div>
          <button
            type="button"
            className="btn-icon-only"
            onClick={handleLogout}
            title="Encerrar sessão do painel"
          >
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </aside>

      {/* Área Principal */}
      <div className="noc-workspace">
        <header className="workspace-topbar">
          <div className="topbar-left">
            <div className="topbar-breadcrumb">
              <strong>
                {activeTab === "dashboard"
                  ? "Video Wall & Monitoramento"
                  : activeTab === "resources"
                  ? "Monitoramento de Recursos & Comparativo de Sessões"
                  : activeTab === "admin"
                  ? "Inventário & Controle Systemd"
                  : activeTab === "users"
                  ? "Gestão de Usuários & Controle de Acesso"
                  : "Auditoria & Eventos de Segurança"}
              </strong>
            </div>
            <span className="telemetry-pill">
              <span className="pulse-dot" />
              Telemetria em Tempo Real
            </span>
          </div>

          <div className="topbar-right">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void loadTVs(false)}
              disabled={tvsLoading}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              <span>{tvsLoading ? "Sincronizando..." : "Sincronizar"}</span>
            </button>

            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleOpenCreateModal}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>Nova TV</span>
            </button>
          </div>
        </header>

        <main className="main-content">
          {apiFetchFailed && (
            <div className="alert alert-warning" role="alert">
              <strong>Verificação de Estado Incompleta:</strong> {apiFetchFailed}{" "}
              Por segurança, nenhuma TV é exibida como <code>online</code> sem
              confirmação ativa do backend.
            </div>
          )}

          {bannerNotice && (
            <div
              className={`alert alert-${bannerNotice.type}`}
              role="status"
              onClick={() => setBannerNotice(null)}
            >
              <span>{bannerNotice.text}</span>
              <button
                type="button"
                className="alert-dismiss"
                aria-label="Fechar aviso"
              >
                ✕
              </button>
            </div>
          )}

          {/* Faixa de KPIs Executivos */}
          <section className="kpi-grid" aria-label="Resumo operacional">
            <div className="kpi-card kpi-card-emerald">
              <div className="kpi-top">
                <span className="kpi-label">SINAL PRONTO (ONLINE)</span>
                <div className="kpi-svg-box kpi-svg-emerald">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                  </svg>
                </div>
              </div>
              <div className="kpi-value">
                {stats.online}
                <span className="kpi-fraction">/{stats.total}</span>
              </div>
              <div className="kpi-sub">
                TVs prontas para espelhamento imediato
              </div>
            </div>

            <div className="kpi-card kpi-card-blue">
              <div className="kpi-top">
                <span className="kpi-label">SESSÕES GRÁFICAS XFCE</span>
                <div className="kpi-svg-box kpi-svg-blue">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="2" y="3" width="20" height="14" rx="2" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                    <line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                </div>
              </div>
              <div className="kpi-value">
                {stats.xfceActive}
                <span className="kpi-fraction">/{stats.total}</span>
              </div>
              <div className="kpi-sub">
                Desktops X11 ativos no servidor XRDP
              </div>
            </div>

            <div className="kpi-card kpi-card-cyan">
              <div className="kpi-top">
                <span className="kpi-label">LISTENERS SHADOW</span>
                <div className="kpi-svg-box kpi-svg-cyan">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                </div>
              </div>
              <div className="kpi-value">
                {stats.shadowReady}
                <span className="kpi-fraction">/{stats.total}</span>
              </div>
              <div className="kpi-sub">
                Sockets ativos em <code>127.0.0.1:339x</code>
              </div>
            </div>

            <div className="kpi-card kpi-card-purple">
              <div className="kpi-top">
                <span className="kpi-label">TRANSMISSÕES AO VIVO</span>
                <div className="kpi-svg-box kpi-svg-purple">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </div>
              </div>
              <div className="kpi-value">{stats.activeViewers}</div>
              <div className="kpi-sub">
                Operadores assistindo via WebSocket
              </div>
            </div>
          </section>

          {/* Faixa de Telemetria de Recursos do Sistema vs Sessões das TVs */}
          {sysTelemetry && (
            <section
              className="system-resource-banner"
              aria-label="Consumo de recursos do sistema e sessões"
            >
              <div className="sys-res-col">
                <div className="sys-res-top">
                  <span className="sys-res-title">
                    CPU DO SERVIDOR ({sysTelemetry.cpu_cores} NÚCLEOS)
                  </span>
                  <strong className="sys-res-val">
                    {sysTelemetry.cpu_percent.toFixed(1)}%{" "}
                    <small>
                      Load {sysTelemetry.load_avg_1m.toFixed(2)} /{" "}
                      {sysTelemetry.load_avg_5m.toFixed(2)}
                    </small>
                  </strong>
                </div>
                <div className="stacked-bar" title="Azul: Sessões das TVs | Roxo: Sistema/Outros">
                  <div
                    className="stacked-seg seg-tvs"
                    style={{
                      width: `${Math.min(100, sysTelemetry.tvs_total_cpu_percent)}%`,
                    }}
                  />
                  <div
                    className="stacked-seg seg-sys"
                    style={{
                      width: `${Math.min(
                        100 - Math.min(100, sysTelemetry.tvs_total_cpu_percent),
                        sysTelemetry.other_system_cpu_percent
                      )}%`,
                    }}
                  />
                </div>
                <div className="sys-res-legend">
                  <span>
                    <i className="leg-dot leg-tvs" /> TVs em Conjunto:{" "}
                    <strong>{sysTelemetry.tvs_total_cpu_percent.toFixed(1)}%</strong>
                  </span>
                  <span>
                    <i className="leg-dot leg-sys" /> Sistema/Base:{" "}
                    <strong>{sysTelemetry.other_system_cpu_percent.toFixed(1)}%</strong>
                  </span>
                </div>
              </div>

              <div className="sys-res-col">
                <div className="sys-res-top">
                  <span className="sys-res-title">MEMÓRIA RAM GLOBAL</span>
                  <strong className="sys-res-val">
                    {sysTelemetry.mem_used_mb.toFixed(0)} /{" "}
                    {sysTelemetry.mem_total_mb.toFixed(0)} MB{" "}
                    <small>({sysTelemetry.mem_percent.toFixed(1)}%)</small>
                  </strong>
                </div>
                <div className="stacked-bar" title="Azul: Sessões das TVs | Roxo: Sistema/Outros">
                  <div
                    className="stacked-seg seg-tvs"
                    style={{
                      width: `${Math.min(100, sysTelemetry.tvs_total_memory_percent)}%`,
                    }}
                  />
                  <div
                    className="stacked-seg seg-sys"
                    style={{
                      width: `${Math.min(
                        100 - Math.min(100, sysTelemetry.tvs_total_memory_percent),
                        sysTelemetry.other_system_memory_percent
                      )}%`,
                    }}
                  />
                </div>
                <div className="sys-res-legend">
                  <span>
                    <i className="leg-dot leg-tvs" /> TVs em Conjunto:{" "}
                    <strong>
                      {sysTelemetry.tvs_total_memory_mb.toFixed(0)} MB (
                      {sysTelemetry.tvs_total_memory_percent.toFixed(1)}%)
                    </strong>
                  </span>
                  <span>
                    <i className="leg-dot leg-sys" /> Sistema/Base:{" "}
                    <strong>
                      {sysTelemetry.other_system_memory_mb.toFixed(0)} MB (
                      {sysTelemetry.other_system_memory_percent.toFixed(1)}%)
                    </strong>
                  </span>
                </div>
              </div>

              <div className="sys-res-col sys-res-col-summary">
                <div className="sys-res-top">
                  <span className="sys-res-title">MÉDIA POR TV &amp; CAPACIDADE</span>
                  <strong className="sys-res-val">
                    +{sysTelemetry.estimated_extra_tvs_capacity} TVs{" "}
                    <small>folga estimada</small>
                  </strong>
                </div>
                <div className="sys-res-legend sys-res-meta-row">
                  <span>
                    Média/TV ativa:{" "}
                    <strong>
                      {sysTelemetry.avg_tv_cpu_percent.toFixed(1)}% CPU •{" "}
                      {sysTelemetry.avg_tv_memory_mb.toFixed(0)} MB RAM
                    </strong>
                  </span>
                  <span>
                    Disco (/):{" "}
                    <strong>
                      {sysTelemetry.disk_used_gb.toFixed(1)}/
                      {sysTelemetry.disk_total_gb.toFixed(1)} GB (
                      {sysTelemetry.disk_percent.toFixed(0)}%)
                    </strong>
                  </span>
                </div>
                {activeTab !== "resources" && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-xs sys-compare-btn"
                    onClick={() => setActiveTab("resources")}
                  >
                    Ver Comparativo Entre Sessões →
                  </button>
                )}
              </div>
            </section>
          )}

          {activeTab === "dashboard" && (
            <>
              <section className="filter-toolbar" aria-label="Filtros de TVs">
                <div className="search-input-wrap">
                  <svg
                    className="search-svg"
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filtrar monitor por nome, usuário Unix (tv01, tv02, tv03) ou porta..."
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      className="search-clear"
                      onClick={() => setSearchQuery("")}
                    >
                      ✕
                    </button>
                  )}
                </div>

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
                    Sinal Ativo ({stats.online})
                  </button>
                  <button
                    type="button"
                    className={`filter-pill ${
                      statusFilter === "attention" ? "active" : ""
                    }`}
                    onClick={() => setStatusFilter("attention")}
                  >
                    Atenção
                  </button>
                  <button
                    type="button"
                    className={`filter-pill ${
                      statusFilter === "offline" ? "active" : ""
                    }`}
                    onClick={() => setStatusFilter("offline")}
                  >
                    Sem Sessão
                  </button>
                </div>
              </section>

              <section className="tv-grid" aria-label="Video Wall de TVs">
                {filteredTvs.map((tv) => {
                  const rt = tv.runtime;
                  const canWatch = tv.enabled && rt.overall_status === "online";
                  const isBusy = busyTvId === tv.id;

                  return (
                    <article
                      key={tv.id}
                      className={`tv-card status-border-${rt.overall_status}`}
                    >
                      {/* Cabeçalho do Monitor */}
                      <div className="tv-card-header">
                        <div className="tv-title-group">
                          <div className="tv-title-row">
                            <h2>{tv.name}</h2>
                            <span className="mono-badge">
                              {tv.slug.toUpperCase()}
                            </span>
                          </div>
                          <span className="tv-notes">
                            {tv.notes ||
                              `Terminal corporativo (${tv.unix_user})`}
                          </span>
                        </div>

                        <StatusBadge
                          status={rt.overall_status}
                          label={statusLabel(
                            rt.overall_status,
                            rt.shadow_service_state
                          )}
                        />
                      </div>

                      {/* Moldura 16:9 de Preview de Monitor */}
                      <div
                        className={`monitor-screen monitor-${rt.overall_status}`}
                        onClick={() => {
                          if (canWatch) setActiveViewerTv(tv);
                        }}
                        role={canWatch ? "button" : undefined}
                        tabIndex={canWatch ? 0 : undefined}
                        onKeyDown={(e) => {
                          if (
                            canWatch &&
                            (e.key === "Enter" || e.key === " ")
                          ) {
                            e.preventDefault();
                            setActiveViewerTv(tv);
                          }
                        }}
                      >
                        <div className="monitor-scanlines" />

                        <div className="monitor-top-hud">
                          <span className="monitor-chip">
                            {rt.detected_display
                              ? `X11 ${rt.detected_display}`
                              : "X11 OFF"}
                          </span>
                          <NetworkPortLed
                            status={rt.overall_status}
                            port={tv.local_port}
                          />
                          {rt.viewer_connection_state === "connected" && (
                            <span className="monitor-live-tally">
                              ● EM EXIBIÇÃO ({rt.active_viewers_count})
                            </span>
                          )}
                        </div>

                        {canWatch && activeViewerTv?.id !== tv.id ? (
                          <MiniTvPreview
                            tv={tv}
                            csrfToken={session.csrf_token}
                          />
                        ) : rt.xfce_session_state === "active" ? (
                          <div className="vbox-synthetic-desktop">
                            <div className="vbox-top-panel">
                              <span className="vbox-panel-pill">
                                XFCE4 Desktop
                              </span>
                              <span className="vbox-panel-clock">
                                {rt.detected_display || ":10.0"} •{" "}
                                {tv.unix_user}
                              </span>
                            </div>
                            <div className="vbox-window-mock">
                              <div className="vbox-win-titlebar">
                                <span className="vbox-win-dots">
                                  <i />
                                  <i />
                                  <i />
                                </span>
                                <span>
                                  {statusLabel(
                                    rt.overall_status,
                                    rt.shadow_service_state
                                  )}
                                </span>
                              </div>
                              <div className="vbox-win-body">
                                <div className="vbox-win-stat">
                                  <span>CPU</span>
                                  <strong>
                                    {(rt.cpu_percent ?? 0).toFixed(1)}%
                                  </strong>
                                </div>
                                <div className="vbox-win-stat">
                                  <span>RAM</span>
                                  <strong>
                                    {(rt.memory_mb ?? 0).toFixed(0)} MB
                                  </strong>
                                </div>
                                <div className="vbox-win-stat">
                                  <span>Proc</span>
                                  <strong>{rt.process_count ?? 0}</strong>
                                </div>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="monitor-center">
                            <div className="monitor-offline-state">
                              <svg
                                viewBox="0 0 24 24"
                                width="28"
                                height="28"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.6"
                              >
                                <rect
                                  x="2"
                                  y="3"
                                  width="20"
                                  height="14"
                                  rx="2"
                                />
                                <line x1="2" y1="3" x2="22" y2="17" />
                                <line x1="8" y1="21" x2="16" y2="21" />
                              </svg>
                              <strong>
                                {statusLabel(
                                  rt.overall_status,
                                  rt.shadow_service_state
                                )}
                              </strong>
                              <small>{rt.user_message}</small>
                            </div>
                          </div>
                        )}

                        <div className="monitor-bottom-hud">
                          <span>USER: {tv.unix_user}</span>
                          <span>UNIT: {rt.systemd_unit}</span>
                        </div>
                      </div>

                      {/* Grade Técnica de 3 Estados Independentes */}
                      <div className="telemetry-strip">
                        <div className="telemetry-cell">
                          <span className="t-label">1. Sessão XFCE</span>
                          <span className="t-val">
                            <StateIcon
                              size={20}
                              tone={
                                rt.xfce_session_state === "active"
                                  ? "ok"
                                  : rt.xfce_session_state === "inactive"
                                  ? "idle"
                                  : "warn"
                              }
                            />
                            {xfceStateText(rt.xfce_session_state)}
                          </span>
                        </div>

                        <div className="telemetry-cell">
                          <span className="t-label">2. Listener Shadow</span>
                          <span className="t-val">
                            <StateIcon
                              size={20}
                              tone={
                                rt.shadow_service_state === "available"
                                  ? "ok"
                                  : rt.shadow_service_state === "conflict" ||
                                    rt.shadow_service_state === "error"
                                  ? "bad"
                                  : "warn"
                              }
                            />
                            {shadowStateText(rt.shadow_service_state)}
                          </span>
                        </div>

                        <div className="telemetry-cell">
                          <span className="t-label">3. Visualizador</span>
                          <span className="t-val">
                            <StateIcon
                              size={20}
                              tone={
                                rt.viewer_connection_state === "connected"
                                  ? "live"
                                  : "idle"
                              }
                            />
                            {viewerStateText(
                              rt.viewer_connection_state,
                              rt.active_viewers_count
                            )}
                          </span>
                        </div>
                      </div>

                      {/* Consumo de Recursos da Sessão da TV + Comparação com a Média */}
                      <div className="tv-resource-strip">
                        <div className="tv-res-metric">
                          <div className="tv-res-label-row">
                            <span>CPU Sessão ({tv.unix_user})</span>
                            <strong>{(rt.cpu_percent ?? 0).toFixed(1)}%</strong>
                          </div>
                          <div className="tv-mini-bar">
                            <div
                              className="tv-mini-fill fill-cpu"
                              style={{
                                width: `${Math.min(100, Math.max(2, rt.cpu_percent || 0))}%`,
                              }}
                            />
                          </div>
                        </div>

                        <div className="tv-res-metric">
                          <div className="tv-res-label-row">
                            <span>RAM Sessão</span>
                            <strong>
                              {(rt.memory_mb ?? 0).toFixed(0)} MB{" "}
                              <small>({(rt.memory_percent ?? 0).toFixed(1)}%)</small>
                            </strong>
                          </div>
                          <div className="tv-mini-bar">
                            <div
                              className="tv-mini-fill fill-ram"
                              style={{
                                width: `${Math.min(
                                  100,
                                  Math.max(2, (rt.memory_percent || 0) * 3)
                                )}%`,
                              }}
                            />
                          </div>
                        </div>

                        <div className="tv-res-meta">
                          <span>{rt.process_count ?? 0} proc</span>
                          <span>
                            Shadow: {(rt.shadow_memory_mb ?? 0).toFixed(0)} MB
                          </span>
                        </div>
                      </div>

                      {/* Barra de Ações do Cartão */}
                      <div className="tv-card-footer">
                        <button
                          type="button"
                          className="btn btn-primary tv-watch-btn"
                          disabled={!canWatch}
                          onClick={() => setActiveViewerTv(tv)}
                        >
                          <svg
                            viewBox="0 0 24 24"
                            width="15"
                            height="15"
                            fill="currentColor"
                          >
                            <polygon points="5 3 19 12 5 21 5 3" />
                          </svg>
                          <span>
                            {canWatch
                              ? "Assistir Tela ao Vivo"
                              : "Indisponível"}
                          </span>
                        </button>

                        <div className="service-btn-group">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={isBusy}
                            onClick={() => triggerServiceAction(tv, "restart")}
                            title="Ressincronizar listener Shadow da sessão da TV"
                          >
                            Ressincronizar
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleOpenEditModal(tv)}
                            title="Editar parâmetros e senha da TV"
                          >
                            <svg
                              viewBox="0 0 24 24"
                              width="14"
                              height="14"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <circle cx="12" cy="12" r="3" />
                              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </section>
            </>
          )}

          {activeTab === "resources" && (
            <section className="admin-panel" aria-label="Comparativo de Recursos">
              <div className="panel-header">
                <div>
                  <h2>
                    Comparativo de Recursos: Sessões das TVs vs. Sistema Global
                  </h2>
                  <p className="panel-subtitle">
                    Análise em tempo real do consumo individual de cada sessão
                    gráfica (XFCE + FreeRDP Shadow) e comparação proporcional
                    com a capacidade total do servidor.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void loadTVs(false)}
                >
                  Atualizar Telemetria
                </button>
              </div>

              {sysTelemetry && (
                <div className="comparison-summary-grid">
                  <div className="comp-box">
                    <span className="comp-label">SOMA DAS SESSÕES DE TV</span>
                    <strong className="comp-val">
                      {sysTelemetry.tvs_total_memory_mb.toFixed(0)} MB RAM •{" "}
                      {sysTelemetry.tvs_total_cpu_percent.toFixed(1)}% CPU
                    </strong>
                    <small>
                      {sysTelemetry.active_tv_sessions_count} sessões ativas (
                      {sysTelemetry.tvs_total_memory_percent.toFixed(1)}% da RAM
                      do servidor)
                    </small>
                  </div>

                  <div className="comp-box">
                    <span className="comp-label">SISTEMA OPERACIONAL &amp; BASE</span>
                    <strong className="comp-val">
                      {sysTelemetry.other_system_memory_mb.toFixed(0)} MB RAM •{" "}
                      {sysTelemetry.other_system_cpu_percent.toFixed(1)}% CPU
                    </strong>
                    <small>
                      Kernel, XRDP (:3389), Guacd (:4822), Caddy e serviços base (
                      {sysTelemetry.other_system_memory_percent.toFixed(1)}% da
                      RAM)
                    </small>
                  </div>

                  <div className="comp-box">
                    <span className="comp-label">RECURSOS LIVRES / HEADROOM</span>
                    <strong className="comp-val">
                      {sysTelemetry.mem_available_mb.toFixed(0)} MB RAM Livre •{" "}
                      {Math.max(0, 100 - sysTelemetry.cpu_percent).toFixed(1)}%
                      CPU Livre
                    </strong>
                    <small>
                      Suporta aprox.{" "}
                      <strong>+{sysTelemetry.estimated_extra_tvs_capacity} TVs</strong>{" "}
                      adicionais com o perfil atual
                    </small>
                  </div>
                </div>
              )}

              <div className="table-responsive">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>TV / Sessão</th>
                      <th>Estado</th>
                      <th>CPU da Sessão</th>
                      <th>RAM Total da Sessão</th>
                      <th>Desktop XFCE vs. Shadow</th>
                      <th>Processos</th>
                      <th>Comparativo vs. Média</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tvs.map((tv) => {
                      const rt = tv.runtime;
                      const cpu = rt.cpu_percent || 0;
                      const memMb = rt.memory_mb || 0;
                      const memPct = rt.memory_percent || 0;
                      const shMem = rt.shadow_memory_mb || 0;
                      const xfceMem = Math.max(0, memMb - shMem);
                      const avgMem = sysTelemetry?.avg_tv_memory_mb || 0;
                      const diffPct =
                        avgMem > 0 && memMb > 0
                          ? ((memMb - avgMem) / avgMem) * 100
                          : 0;

                      return (
                        <tr key={tv.id}>
                          <td>
                            <strong>{tv.name}</strong>{" "}
                            <span className="mono-badge">{tv.unix_user}</span>
                          </td>
                          <td>
                            <StatusBadge
                              size="sm"
                              status={rt.overall_status}
                              label={statusLabel(
                                rt.overall_status,
                                rt.shadow_service_state
                              )}
                            />
                          </td>
                          <td style={{ minWidth: 160 }}>
                            <div className="table-bar-wrap">
                              <div className="table-bar-top">
                                <strong>{cpu.toFixed(1)}%</strong>
                                <small>
                                  Shadow: {(rt.shadow_cpu_percent || 0).toFixed(1)}%
                                </small>
                              </div>
                              <div className="tv-mini-bar">
                                <div
                                  className="tv-mini-fill fill-cpu"
                                  style={{
                                    width: `${Math.min(100, Math.max(2, cpu * 2))}%`,
                                  }}
                                />
                              </div>
                            </div>
                          </td>
                          <td style={{ minWidth: 180 }}>
                            <div className="table-bar-wrap">
                              <div className="table-bar-top">
                                <strong>{memMb.toFixed(0)} MB</strong>
                                <small>{memPct.toFixed(1)}% do servidor</small>
                              </div>
                              <div className="tv-mini-bar">
                                <div
                                  className="tv-mini-fill fill-ram"
                                  style={{
                                    width: `${Math.min(
                                      100,
                                      Math.max(2, memPct * 3)
                                    )}%`,
                                  }}
                                />
                              </div>
                            </div>
                          </td>
                          <td>
                            <code>
                              XFCE: {xfceMem.toFixed(0)} MB | Shadow:{" "}
                              {shMem.toFixed(0)} MB
                            </code>
                          </td>
                          <td>
                            <strong>{rt.process_count || 0}</strong> proc
                          </td>
                          <td>
                            {memMb === 0 ? (
                              <span className="comp-tag comp-tag-neutral">
                                Sem consumo (Offline)
                              </span>
                            ) : Math.abs(diffPct) <= 10 ? (
                              <span className="comp-tag comp-tag-ok">
                                Na média ({diffPct >= 0 ? "+" : ""}
                                {diffPct.toFixed(0)}%)
                              </span>
                            ) : diffPct > 10 ? (
                              <span className="comp-tag comp-tag-high">
                                +{diffPct.toFixed(0)}% acima da média
                              </span>
                            ) : (
                              <span className="comp-tag comp-tag-low">
                                {diffPct.toFixed(0)}% abaixo da média (Mais leve)
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {activeTab === "admin" && (
            <section className="admin-panel">
              <div className="panel-header">
                <div>
                  <h2>Inventário de Terminais &amp; Unidades Systemd</h2>
                  <p className="panel-subtitle">
                    Gerenciamento de portas locais (loopback{" "}
                    <code>127.0.0.1</code>) e serviços{" "}
                    <code>tv-shadow@&lt;usuario&gt;.service</code>.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={handleOpenCreateModal}
                >
                  + Adicionar TV
                </button>
              </div>

              <div className="table-responsive">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>TV / Identificador</th>
                      <th>Usuário Unix</th>
                      <th>Endpoint Shadow</th>
                      <th>Sessão XFCE</th>
                      <th>Unidade Systemd</th>
                      <th>Parâmetros FreeRDP 3</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tvs.map((tv) => (
                      <tr key={tv.id}>
                        <td>
                          <strong>{tv.name}</strong>{" "}
                          <span className="mono-badge">{tv.slug}</span>
                          {!tv.enabled && (
                            <span className="tag-disabled">Desabilitada</span>
                          )}
                        </td>
                        <td>
                          <code>{tv.unix_user}</code>
                        </td>
                        <td>
                          <code>127.0.0.1:{tv.local_port}</code>
                        </td>
                        <td>
                          <span className="state-inline">
                            <StateIcon
                              size={20}
                              tone={
                                tv.runtime.xfce_session_state === "active"
                                  ? "ok"
                                  : tv.runtime.xfce_session_state === "inactive"
                                  ? "idle"
                                  : "warn"
                              }
                            />
                            {xfceStateText(tv.runtime.xfce_session_state)}
                            {tv.runtime.detected_display
                              ? ` (${tv.runtime.detected_display})`
                              : ""}
                          </span>
                        </td>
                        <td>
                          <code>{tv.runtime.systemd_unit}</code> (
                          {tv.runtime.systemd_active_state})
                        </td>
                        <td>
                          <code>
                            /sec:tls {tv.gfx_enabled ? "-gfx" : "+gfx"}{" "}
                            {tv.server_side_cursor
                              ? "+server-side-cursor"
                              : "-server-side-cursor"}
                          </code>
                        </td>
                        <td className="table-actions">
                          <button
                            type="button"
                            className="btn btn-secondary btn-xs"
                            onClick={() => handleOpenEditModal(tv)}
                          >
                            Editar
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-xs"
                            onClick={() => triggerServiceAction(tv, "restart")}
                          >
                            Restart
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger btn-xs"
                            onClick={() => triggerServiceAction(tv, "stop")}
                          >
                            Stop
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger btn-xs"
                            onClick={() => setTvToDelete(tv)}
                            title="Excluir perfil desta TV"
                          >
                            Excluir
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {activeTab === "users" && (
            <section className="admin-panel">
              <div className="panel-header">
                <div>
                  <h2>Usuários do Painel &amp; Controle de Acesso</h2>
                  <p className="panel-subtitle">
                    Gerencie os operadores e administradores com acesso ao console NOC. Você pode criar novas credenciais, resetar senhas ou bloquear contas.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    setUserFormData({
                      username: "",
                      password: "",
                      confirmPassword: "",
                      is_active: true,
                    });
                    setIsUserModalOpen(true);
                  }}
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  <span>Novo Usuário</span>
                </button>
              </div>

              {usersLoading && users.length === 0 ? (
                <div className="loading-state">
                  <div className="spinner" />
                  <span>Carregando usuários do sistema...</span>
                </div>
              ) : (
                <div className="table-responsive">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Usuário / Operador</th>
                        <th>Status da Conta</th>
                        <th>Falhas de Login</th>
                        <th>Criado em</th>
                        <th>Último Acesso</th>
                        <th>Ações Administrativas</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((u) => {
                        const isSelf = session?.username === u.username;
                        return (
                          <tr key={u.id}>
                            <td>
                              <code>#{u.id}</code>
                            </td>
                            <td>
                              <strong>{u.username}</strong>
                              {isSelf && (
                                <span className="mono-badge" style={{ marginLeft: "0.5rem" }}>
                                  Você
                                </span>
                              )}
                            </td>
                            <td>
                              {u.is_active ? (
                                <span className="tag-active">● ATIVO</span>
                              ) : (
                                <span className="tag-blocked">✕ BLOQUEADO</span>
                              )}
                            </td>
                            <td>
                              {u.failed_attempts > 0 ? (
                                <span style={{ color: "var(--warn)" }}>
                                  {u.failed_attempts} tentativa(s)
                                </span>
                              ) : (
                                <span style={{ color: "var(--text-3)" }}>0</span>
                              )}
                            </td>
                            <td>{formatDate(u.created_at)}</td>
                            <td>{formatDate(u.last_login_at)}</td>
                            <td className="table-actions">
                              <button
                                type="button"
                                className="btn btn-secondary btn-xs"
                                onClick={() => {
                                  setUserResetPassword("");
                                  setUserResetConfirm("");
                                  setUserResetModal({ userId: u.id, username: u.username });
                                }}
                                title="Redefinir senha de acesso deste usuário"
                              >
                                Redefinir Senha
                              </button>

                              <button
                                type="button"
                                className={`btn ${u.is_active ? "btn-secondary" : "btn-primary"} btn-xs`}
                                disabled={isSelf}
                                onClick={() => handleToggleUserStatus(u)}
                                title={
                                  isSelf
                                    ? "Você não pode bloquear o seu próprio usuário logado"
                                    : u.is_active
                                    ? "Bloquear acesso deste operador ao painel"
                                    : "Desbloquear acesso deste operador"
                                }
                              >
                                {u.is_active ? "Bloquear" : "Desbloquear"}
                              </button>

                              <button
                                type="button"
                                className="btn btn-danger btn-xs"
                                disabled={isSelf || users.length <= 1}
                                onClick={() => setUserToDelete(u)}
                                title={
                                  isSelf
                                    ? "Você não pode excluir o seu próprio usuário logado"
                                    : users.length <= 1
                                    ? "O sistema deve possuir pelo menos 1 usuário ativo"
                                    : "Excluir operador do painel"
                                }
                              >
                                Excluir
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                      {users.length === 0 && (
                        <tr>
                          <td colSpan={7} className="empty-row">
                            Nenhum usuário cadastrado além do administrador padrão.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {activeTab === "audit" && (
            <section className="admin-panel">
              <div className="panel-header">
                <div>
                  <h2>Trilha de Auditoria e Eventos Operacionais</h2>
                  <p className="panel-subtitle">
                    Registro imutável de autenticações, sessões de vídeo ao vivo
                    e comandos administrativos no host.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void loadAuditLogs()}
                >
                  Atualizar Registros
                </button>
              </div>

              <div className="table-responsive">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Data / Hora</th>
                      <th>Operador</th>
                      <th>IP Origem</th>
                      <th>Evento</th>
                      <th>Alvo</th>
                      <th>Resultado</th>
                      <th>Metadados</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLogs.map((log) => (
                      <tr key={log.id}>
                        <td>
                          {new Date(log.timestamp).toLocaleString("pt-BR")}
                        </td>
                        <td>
                          <strong>{log.actor_username}</strong>
                        </td>
                        <td>
                          <code>{log.ip_address}</code>
                        </td>
                        <td>
                          <code>{log.action}</code>
                        </td>
                        <td>
                          {log.target_type}: <strong>{log.target_id}</strong>
                        </td>
                        <td>
                          <span
                            className={`audit-outcome outcome-${log.outcome}`}
                          >
                            {log.outcome}
                          </span>
                        </td>
                        <td>
                          <code className="audit-details">
                            {JSON.stringify(log.details)}
                          </code>
                        </td>
                      </tr>
                    ))}
                    {auditLogs.length === 0 && (
                      <tr>
                        <td colSpan={7} className="empty-row">
                          Nenhum evento registrado.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </main>
      </div>

      {/* Modal de Criação / Edição de TV */}
      {isFormModalOpen && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="tv-form-modal-title"
        >
          <div className="modal-box modal-box-lg">
            <div className="modal-header-row">
              <div>
                <h3 id="tv-form-modal-title">
                  {editingTvId === null
                    ? "Cadastrar Nova TV no Inventário"
                    : `Configurar ${formData.name} (${formData.slug})`}
                </h3>
                <p className="panel-subtitle">
                  As portas Shadow são vinculadas exclusivamente ao loopback{" "}
                  <code>127.0.0.1</code> (faixa permitida: <code>3391</code> a{" "}
                  <code>3499</code>).
                </p>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setIsFormModalOpen(false)}
                aria-label="Fechar janela"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleFormSubmit} className="tv-form">
              <div className="form-grid">
                <label className="form-field">
                  <span>Identificador Curto (Slug)</span>
                  <input
                    type="text"
                    required
                    pattern="^[a-z0-9_-]{2,30}$"
                    value={formData.slug}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        slug: e.target.value.toLowerCase(),
                      })
                    }
                    placeholder="Ex: tv04"
                  />
                  <small>Ex: tv01, tv02, tv04, recepcao...</small>
                </label>

                <label className="form-field">
                  <span>Nome de Exibição</span>
                  <input
                    type="text"
                    required
                    value={formData.name}
                    onChange={(e) =>
                      setFormData({ ...formData, name: e.target.value })
                    }
                    placeholder="Ex: TV 04 — Recepção"
                  />
                </label>

                <label className="form-field">
                  <span>Usuário Unix da Sessão XFCE</span>
                  <input
                    type="text"
                    required
                    pattern="^[a-z_][a-z0-9_-]{1,30}$"
                    value={formData.unix_user}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        unix_user: e.target.value.toLowerCase(),
                      })
                    }
                    placeholder="Ex: tv04"
                  />
                </label>

                <label className="form-field">
                  <span>Porta Local Shadow (127.0.0.1)</span>
                  <input
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
                  <small>Padronização: tv01=3391, tv02=3392, tv03=3393</small>
                </label>

                <label className="form-field">
                  <span>Camada de Segurança RDP</span>
                  <select
                    value={formData.sec_mode}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        sec_mode: e.target.value as "rdp" | "tls" | "nla",
                      })
                    }
                  >
                    <option value="tls">
                      TLS (/sec:tls — Recomendado FreeRDP 3)
                    </option>
                    <option value="rdp">Standard RDP (/sec:rdp)</option>
                    <option value="nla">NLA (/sec:nla)</option>
                  </select>
                </label>

                <label className="form-field">
                  <span>Localização / Observações</span>
                  <input
                    type="text"
                    value={formData.notes}
                    onChange={(e) =>
                      setFormData({ ...formData, notes: e.target.value })
                    }
                    placeholder="Ex: Painel de Produção / NOC"
                  />
                </label>

                <label className="form-field">
                  <span>
                    {editingTvId === null
                      ? "Senha do Usuário Unix (Login XRDP da TV)"
                      : "Redefinir Senha XRDP da TV (opcional)"}
                  </span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={formData.unix_password || ""}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        unix_password: e.target.value,
                      })
                    }
                    placeholder={
                      editingTvId === null
                        ? "Ex: Tv@2026!"
                        : "Deixe em branco para manter a senha atual"
                    }
                  />
                  <small>
                    Cria o usuário Linux + <code>~/.xsession</code> (XFCE) e
                    aplica a senha para o login XRDP na porta 3389.
                  </small>
                </label>
              </div>

              <fieldset className="checkbox-group">
                <legend>Flags de Estabilidade do FreeRDP 3 Shadow</legend>
                <label className="checkbox-item">
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
                    Forçar <code>-gfx</code> (Desativa pipeline H264/GFX para
                    compatibilidade com <code>guacd</code>)
                  </span>
                </label>

                <label className="checkbox-item">
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
                    Habilitar <code>+server-side-cursor</code> (Renderiza cursor
                    do mouse da sessão XFCE)
                  </span>
                </label>

                <label className="checkbox-item">
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
                    Usar <code>-auth</code> no loopback local (Autenticação já
                    imposta pelo painel web)
                  </span>
                </label>

                <label className="checkbox-item">
                  <input
                    type="checkbox"
                    checked={formData.enabled}
                    onChange={(e) =>
                      setFormData({ ...formData, enabled: e.target.checked })
                    }
                  />
                  <span>TV habilitada para operação no painel</span>
                </label>
              </fieldset>

              <div className="flags-preview-box">
                <small>Comando efetivo supervisionado pelo systemd:</small>
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

              <div className="modal-actions modal-actions-split">
                {editingTvId !== null ? (
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => {
                      const target = tvs.find((t) => t.id === editingTvId);
                      if (target) {
                        setIsFormModalOpen(false);
                        setTvToDelete(target);
                      }
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                    <span>Excluir TV</span>
                  </button>
                ) : (
                  <span />
                )}
                <div className="modal-actions-right">
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
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal de Exclusão de TV */}
      {tvToDelete && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-tv-title"
        >
          <div className="modal-box">
            <div className="modal-header-row">
              <h3 id="delete-tv-title" style={{ color: "var(--bad)" }}>
                Excluir Perfil de TV
              </h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setTvToDelete(null)}
                aria-label="Fechar"
              >
                ✕
              </button>
            </div>
            <p>
              Tem certeza que deseja excluir o perfil da TV{" "}
              <strong>{tvToDelete.name}</strong> (identificador <code>{tvToDelete.slug}</code> — porta <code>{tvToDelete.local_port}</code>)?
            </p>
            <div className="alert alert-warning" role="alert">
              <span>
                O serviço local FreeRDP Shadow em loopback será finalizado e o registro será permanentemente removido do painel.
              </span>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setTvToDelete(null)}
                disabled={tvDeleteSubmitting}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={tvDeleteSubmitting}
                onClick={handleConfirmDeleteTv}
              >
                {tvDeleteSubmitting ? "Excluindo..." : "Confirmar Exclusão"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Cadastro de Novo Usuário */}
      {isUserModalOpen && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-user-title"
        >
          <div className="modal-box">
            <div className="modal-header-row">
              <h3 id="create-user-title">Novo Operador / Administrador</h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setIsUserModalOpen(false)}
                aria-label="Fechar modal"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateUser}>
              <label className="form-field">
                <span>Nome de Usuário (Login)</span>
                <input
                  type="text"
                  required
                  autoFocus
                  pattern="^[a-zA-Z0-9_\-\.]{3,64}$"
                  value={userFormData.username}
                  onChange={(e) =>
                    setUserFormData({
                      ...userFormData,
                      username: e.target.value.toLowerCase(),
                    })
                  }
                  placeholder="Ex: operador_noite"
                />
                <small>Mínimo 3 caracteres alfanuméricos.</small>
              </label>

              <label className="form-field">
                <span>Senha de Acesso</span>
                <input
                  type="password"
                  required
                  minLength={10}
                  value={userFormData.password}
                  onChange={(e) =>
                    setUserFormData({
                      ...userFormData,
                      password: e.target.value,
                    })
                  }
                  placeholder="Mínimo 10 caracteres"
                />
              </label>

              <label className="form-field">
                <span>Confirmar Senha</span>
                <input
                  type="password"
                  required
                  minLength={10}
                  value={userFormData.confirmPassword}
                  onChange={(e) =>
                    setUserFormData({
                      ...userFormData,
                      confirmPassword: e.target.value,
                    })
                  }
                  placeholder="Digite a mesma senha novamente"
                />
              </label>

              <label className="checkbox-item" style={{ marginTop: "1rem" }}>
                <input
                  type="checkbox"
                  checked={userFormData.is_active}
                  onChange={(e) =>
                    setUserFormData({
                      ...userFormData,
                      is_active: e.target.checked,
                    })
                  }
                />
                <span>Habilitar conta como ativa imediatamente</span>
              </label>

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsUserModalOpen(false)}
                  disabled={userFormSubmitting}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={userFormSubmitting}
                >
                  {userFormSubmitting ? "Criando..." : "Cadastrar Usuário"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal de Redefinição de Senha do Usuário */}
      {userResetModal && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reset-user-pwd-title"
        >
          <div className="modal-box">
            <div className="modal-header-row">
              <h3 id="reset-user-pwd-title">Redefinir Senha do Usuário</h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setUserResetModal(null)}
                aria-label="Fechar modal"
              >
                ✕
              </button>
            </div>

            <p>
              Definir uma nova senha para o operador:{" "}
              <strong>{userResetModal.username}</strong>
            </p>

            <form onSubmit={handleResetUserPassword}>
              <label className="form-field">
                <span>Nova Senha</span>
                <input
                  type="password"
                  required
                  autoFocus
                  minLength={10}
                  value={userResetPassword}
                  onChange={(e) => setUserResetPassword(e.target.value)}
                  placeholder="Mínimo 10 caracteres"
                />
              </label>

              <label className="form-field">
                <span>Confirmar Nova Senha</span>
                <input
                  type="password"
                  required
                  minLength={10}
                  value={userResetConfirm}
                  onChange={(e) => setUserResetConfirm(e.target.value)}
                  placeholder="Digite a mesma senha novamente"
                />
              </label>

              <div className="alert alert-warning" role="alert">
                <span>
                  Por segurança, qualquer sessão ativa deste usuário no painel será revogada imediatamente.
                </span>
              </div>

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setUserResetModal(null)}
                  disabled={userResetSubmitting}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={userResetSubmitting}
                >
                  {userResetSubmitting ? "Salvando..." : "Salvar Nova Senha"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal de Exclusão de Usuário */}
      {userToDelete && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-user-title"
        >
          <div className="modal-box">
            <div className="modal-header-row">
              <h3 id="delete-user-title" style={{ color: "var(--bad)" }}>
                Excluir Usuário do Painel
              </h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setUserToDelete(null)}
                aria-label="Fechar"
              >
                ✕
              </button>
            </div>
            <p>
              Tem certeza que deseja excluir o operador{" "}
              <strong>{userToDelete.username}</strong>?
            </p>
            <div className="alert alert-error" role="alert">
              <span>
                Esta conta perderá imediatamente todo o acesso ao painel web e suas sessões serão revogadas.
              </span>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setUserToDelete(null)}
                disabled={userDeleteSubmitting}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={userDeleteSubmitting}
                onClick={handleDeleteUser}
              >
                {userDeleteSubmitting ? "Excluindo..." : "Confirmar Exclusão"}
              </button>
            </div>
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
          onClose={handleCloseViewer}
          onStateUpdated={handleViewerStateUpdated}
        />
      )}
    </div>
  );
};
