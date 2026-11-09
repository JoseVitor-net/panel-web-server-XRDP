export type OverallStatus = "online" | "degraded" | "offline" | "disabled" | "unknown";
export type XfceSessionState = "active" | "inactive" | "unknown";
export type ShadowServiceState =
  | "available"
  | "unavailable"
  | "conflict"
  | "starting"
  | "error"
  | "unknown";
export type ViewerConnectionState = "connected" | "idle" | "unknown";
export type SecMode = "rdp" | "tls" | "nla";

export interface TVRuntimeState {
  overall_status: OverallStatus;
  xfce_session_state: XfceSessionState;
  shadow_service_state: ShadowServiceState;
  viewer_connection_state: ViewerConnectionState;
  active_viewers_count: number;
  detected_display: string | null;
  xauthority_ready: boolean;
  systemd_unit: string;
  systemd_active_state: string;
  port_conflict_detail: string | null;
  user_message: string;
  last_checked_at: string;
}

export interface TVItem {
  id: number;
  slug: string;
  name: string;
  location: string;
  unix_user: string;
  local_port: number;
  bind_address: string;
  display_number: number | null;
  gfx_enabled: boolean;
  server_side_cursor: boolean;
  sec_mode: SecMode;
  shadow_auth_enabled: boolean;
  enabled: boolean;
  notes: string;
  effective_shadow_flags_preview: string;
  created_at: string;
  updated_at: string;
  runtime: TVRuntimeState;
}

export interface TVFormPayload {
  slug: string;
  name: string;
  location: string;
  unix_user: string;
  local_port: number;
  display_number: number | null;
  gfx_enabled: boolean;
  server_side_cursor: boolean;
  sec_mode: SecMode;
  shadow_auth_enabled: boolean;
  enabled: boolean;
  notes: string;
  unix_password?: string;
  confirm_disruption?: boolean;
}

export interface AuthSession {
  authenticated: boolean;
  username: string;
  csrf_token: string;
  expires_at: string;
  env_mode: string;
}

export interface AuditLogItem {
  id: number;
  timestamp: string;
  actor_username: string | null;
  ip_address: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  outcome: string;
  details: Record<string, unknown>;
}

