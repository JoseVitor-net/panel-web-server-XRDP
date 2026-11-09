import React from "react";
import { OverallStatus } from "../types";

export type Tone = "ok" | "warn" | "bad" | "idle" | "live";

const GLYPHS: Record<Tone | "disabled" | "unknown", React.ReactNode> = {
  ok: <path d="M7.5 12.5l3 3 6-7" />,
  warn: (
    <>
      <path d="M12 8v5" />
      <path d="M12 16.2v.1" />
    </>
  ),
  bad: <path d="M9 9l6 6M15 9l-6 6" />,
  idle: <path d="M8.5 12h7" />,
  live: <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />,
  disabled: <path d="M7 17L17 7" />,
  unknown: (
    <>
      <path d="M9.6 9.7a2.5 2.5 0 114 2c-.9.6-1.6 1-1.6 2" />
      <path d="M12 16.6v.1" />
    </>
  ),
};

/** Ícone de estado: a forma (não só a cor) distingue cada situação. */
export const StateIcon: React.FC<{
  tone: Tone | "disabled" | "unknown";
  size?: number;
}> = ({ tone, size = 22 }) => {
  const shape =
    tone === "warn" ? (
      <path d="M12 3.2l9.2 16.2H2.8z" />
    ) : tone === "unknown" ? (
      <path d="M12 2.8l9.2 9.2-9.2 9.2L2.8 12z" />
    ) : (
      <circle cx="12" cy="12" r="9.2" />
    );
  return (
    <svg
      className={`state-icon tone-${tone}`}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shape}
      {GLYPHS[tone]}
    </svg>
  );
};

const STATUS_TONE: Record<OverallStatus, Tone | "disabled" | "unknown"> = {
  online: "ok",
  degraded: "warn",
  offline: "idle",
  disabled: "disabled",
  unknown: "unknown",
};

/** Selo de status geral da TV: ícone + cor, com rótulo acessível. */
export const StatusBadge: React.FC<{
  status: OverallStatus;
  label: string;
  size?: "md" | "sm";
}> = ({ status, label, size = "md" }) => (
  <span
    className={`status-badge status-${status} status-badge-${size}`}
    role="img"
    aria-label={label}
    title={label}
  >
    <StateIcon tone={STATUS_TONE[status]} size={size === "md" ? 30 : 22} />
  </span>
);

