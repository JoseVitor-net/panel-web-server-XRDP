import {
  AuditLogItem,
  AuthSession,
  SystemOverviewTelemetry,
  TVFormPayload,
  TVItem,
  UserItem,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function requestJson<T>(
  url: string,
  options: RequestInit = {},
  csrfToken?: string
): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (csrfToken) {
    headers.set("X-CSRF-Token", csrfToken);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(
      0,
      "Não foi possível comunicar com a API do painel. Verifique a conexão de rede."
    );
  }

  if (!response.ok) {
    let detail = "Erro inesperado ao processar a solicitação.";
    try {
      const errBody = (await response.json()) as { detail?: string };
      if (errBody && typeof errBody.detail === "string") {
        detail = errBody.detail;
      }
    } catch {
      // ignora erro de parse JSON
    }
    throw new ApiError(response.status, detail);
  }

  return (await response.json()) as T;
}

export const api = {
  getMe(): Promise<AuthSession> {
    return requestJson<AuthSession>("/api/auth/me");
  },

  login(username: string, password: string): Promise<AuthSession> {
    return requestJson<AuthSession>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  },

  logout(csrfToken: string): Promise<{ detail: string }> {
    return requestJson<{ detail: string }>(
      "/api/auth/logout",
      { method: "POST" },
      csrfToken
    );
  },

  listTVs(): Promise<TVItem[]> {
    return requestJson<TVItem[]>("/api/tvs");
  },

  getSystemTelemetry(): Promise<SystemOverviewTelemetry> {
    return requestJson<SystemOverviewTelemetry>("/api/system/telemetry");
  },

  getTV(id: number): Promise<TVItem> {
    return requestJson<TVItem>(`/api/tvs/${id}`);
  },

  createTV(payload: TVFormPayload, csrfToken: string): Promise<TVItem> {
    return requestJson<TVItem>(
      "/api/tvs",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      csrfToken
    );
  },

  updateTV(id: number, payload: TVFormPayload, csrfToken: string): Promise<TVItem> {
    return requestJson<TVItem>(
      `/api/tvs/${id}`,
      {
        method: "PUT",
        body: JSON.stringify(payload),
      },
      csrfToken
    );
  },

  controlService(
    id: number,
    action: "start" | "stop" | "restart",
    confirmDisruption: boolean,
    csrfToken: string
  ): Promise<TVItem> {
    return requestJson<TVItem>(
      `/api/tvs/${id}/service`,
      {
        method: "POST",
        body: JSON.stringify({
          action,
          confirm_disruption: confirmDisruption,
        }),
      },
      csrfToken
    );
  },

  listAuditLogs(limit = 60): Promise<AuditLogItem[]> {
    return requestJson<AuditLogItem[]>(`/api/audit-logs?limit=${limit}`);
  },

  deleteTV(id: number, csrfToken: string): Promise<{ ok: boolean; message: string }> {
    return requestJson<{ ok: boolean; message: string }>(
      `/api/tvs/${id}`,
      { method: "DELETE" },
      csrfToken
    );
  },

  listUsers(): Promise<UserItem[]> {
    return requestJson<UserItem[]>("/api/users");
  },

  createUser(
    payload: { username: string; password: string; is_active?: boolean },
    csrfToken: string
  ): Promise<UserItem> {
    return requestJson<UserItem>(
      "/api/users",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      csrfToken
    );
  },

  resetUserPassword(
    userId: number,
    newPassword: string,
    csrfToken: string
  ): Promise<{ ok: boolean; message: string }> {
    return requestJson<{ ok: boolean; message: string }>(
      `/api/users/${userId}/reset-password`,
      {
        method: "POST",
        body: JSON.stringify({ new_password: newPassword }),
      },
      csrfToken
    );
  },

  toggleUserStatus(
    userId: number,
    isActive: boolean,
    csrfToken: string
  ): Promise<UserItem> {
    return requestJson<UserItem>(
      `/api/users/${userId}/toggle-status`,
      {
        method: "POST",
        body: JSON.stringify({ is_active: isActive }),
      },
      csrfToken
    );
  },

  deleteUser(userId: number, csrfToken: string): Promise<{ ok: boolean; message: string }> {
    return requestJson<{ ok: boolean; message: string }>(
      `/api/users/${userId}`,
      { method: "DELETE" },
      csrfToken
    );
  },
};


