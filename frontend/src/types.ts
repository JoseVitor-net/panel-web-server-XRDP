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
  cpu_percent: number;
  memory_mb: number;
  memory_percent: number;
  process_count: number;
  shadow_cpu_percent: number;
  shadow_memory_mb: number;
}

export interface SystemOverviewTelemetry {
  hostname: string;
  cpu_cores: number;
  cpu_percent: number;
  load_avg_1m: number;
  load_avg_5m: number;
  load_avg_15m: number;
  mem_total_mb: number;
  mem_used_mb: number;
  mem_available_mb: number;
  mem_percent: number;
  swap_total_mb: number;
  swap_used_mb: number;
  swap_percent: number;
  disk_total_gb: number;
  disk_used_gb: number;
  disk_percent: number;
  uptime_seconds: number;
  tvs_total_cpu_percent: number;
  tvs_total_memory_mb: number;
  tvs_total_memory_percent: number;
  other_system_cpu_percent: number;
  other_system_memory_mb: number;
  other_system_memory_percent: number;
  active_tv_sessions_count: number;
  avg_tv_cpu_percent: number;
  avg_tv_memory_mb: number;
  estimated_extra_tvs_capacity: number;
  timestamp: string;
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

export interface UserItem {
  id: number;
  username: string;
  is_active: boolean;
  failed_attempts: number;
  locked_until: string | null;
  created_at: string;
  last_login_at: string | null;
}


