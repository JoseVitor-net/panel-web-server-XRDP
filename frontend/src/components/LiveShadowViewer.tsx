import React, { useCallback, useEffect, useRef, useState } from "react";
import Guacamole, { Client, Keyboard, MouseState } from "guacamole-common-js";
import { TVItem } from "../types";

interface LiveShadowViewerProps {
  tv: TVItem;
  csrfToken: string;
  onClose: () => void;
  onStateUpdated: () => void;
}

type TunnelPhase = "connecting" | "connected" | "disconnected" | "error";

function formatGuacStatusMessage(code: number, rawMessage?: string): string {
  if (rawMessage && rawMessage.trim().length > 0) {
    const msg = rawMessage.trim();
    if (msg.toLowerCase().includes("upstream")) {
      return `O daemon guacd não conseguiu negociar a sessão RDP com o FreeRDP Shadow em 127.0.0.1 (código ${code}). Verifique se o serviço Shadow da TV está ativo.`;
    }
    return msg;
  }
  switch (code) {
    case 514:
      return "Gateway local guacd (porta 4822) indisponível. Verifique se o container tv-panel-guacd está em execução.";
    case 519:
    case 520:
      return "O serviço FreeRDP Shadow local não respondeu na porta de loopback configurada ou recusou o handshake.";
    case 523:
      return "Conflito de sessão: outra conexão impediu o acesso ao listener Shadow.";
    default:
      return `Não foi possível estabelecer ou manter o túnel de vídeo Guacamole (código ${code}).`;
  }
}

const LiveShadowViewerComponent: React.FC<LiveShadowViewerProps> = ({
  tv,
  csrfToken,
  onClose,
  onStateUpdated,
}) => {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const displayHostRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<Client | null>(null);
  const keyboardRef = useRef<Keyboard | null>(null);
  const onStateUpdatedRef = useRef(onStateUpdated);
  onStateUpdatedRef.current = onStateUpdated;

  const [phase, setPhase] = useState<TunnelPhase>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [keyboardEnabled, setKeyboardEnabled] = useState<boolean>(true);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [fitToScreen, setFitToScreen] = useState<boolean>(true);
  const [compactToolbar, setCompactToolbar] = useState<boolean>(false);
  const [connectionAttempt, setConnectionAttempt] = useState<number>(1);
  const [resolutionLabel, setResolutionLabel] = useState<string>("1920×1080");

  const scaleRef = useRef<number>(1);
  const fitToScreenRef = useRef<boolean>(fitToScreen);
  fitToScreenRef.current = fitToScreen;
  const rafMouseRef = useRef<number | null>(null);
  const pendingMouseStateRef = useRef<MouseState | null>(null);
  const hasSpecificErrorRef = useRef<boolean>(false);

  const updateScale = useCallback(
    (explicitW?: number, explicitH?: number) => {
      const client = clientRef.current;
      const viewport = viewportRef.current;
      if (!client || !viewport) return;
      const display = client.getDisplay();
      const w = explicitW ?? display.getWidth();
      const h = explicitH ?? display.getHeight();
      if (w <= 0 || h <= 0) return;
      setResolutionLabel(`${w}×${h}`);

      if (!fitToScreenRef.current) {
        display.scale(1);
        scaleRef.current = 1;
        return;
      }

      if (viewport.clientWidth <= 0 || viewport.clientHeight <= 0) return;
      const padW = Math.max(320, viewport.clientWidth - 24);
      const padH = Math.max(240, viewport.clientHeight - 24);
      const scaleX = padW / w;
      const scaleY = padH / h;
      const nextScale = Math.min(scaleX, scaleY, 1.35);
      if (nextScale > 0) {
        display.scale(nextScale);
        scaleRef.current = nextScale;
      }
    },
    []
  );

  const cleanupClient = useCallback(() => {
    if (rafMouseRef.current !== null) {
      window.cancelAnimationFrame(rafMouseRef.current);
      rafMouseRef.current = null;
    }
    if (keyboardRef.current) {
      keyboardRef.current.onkeydown = undefined;
      keyboardRef.current.onkeyup = undefined;
      keyboardRef.current.reset();
      keyboardRef.current = null;
    }
    if (clientRef.current) {
      try {
        clientRef.current.disconnect();
      } catch {
        // ignora erro ao desconectar
      }
      clientRef.current = null;
    }
    if (displayHostRef.current) {
      displayHostRef.current.innerHTML = "";
    }
  }, []);

  useEffect(() => {
    hasSpecificErrorRef.current = false;
    setPhase("connecting");
    setErrorMessage(null);

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/ws/tv/${tv.id}`;
    const tunnel = new Guacamole.WebSocketTunnel(wsUrl);
    const client = new Guacamole.Client(tunnel);
    clientRef.current = client;

    const display = client.getDisplay();
    const displayEl = display.getElement();
    if (displayHostRef.current) {
      displayHostRef.current.innerHTML = "";
      displayHostRef.current.appendChild(displayEl);
    }

    display.onresize = (w: number, h: number) => {
      setPhase("connected");
      updateScale(w, h);
    };

    client.onstatechange = (state: number) => {
      // 0=IDLE, 1=CONNECTING, 2=WAITING, 3=CONNECTED, 4=DISCONNECTING, 5=DISCONNECTED
      if (state === 3) {
        setPhase("connected");
        updateScale();
        onStateUpdatedRef.current();
      } else if (state === 5) {
        setPhase((prev) => (prev === "error" ? "error" : "disconnected"));
        onStateUpdatedRef.current();
      }
    };

    client.onerror = (statusObj: { code: number; message?: string }) => {
      hasSpecificErrorRef.current = true;
      setPhase("error");
      setErrorMessage(formatGuacStatusMessage(statusObj.code, statusObj.message));
    };

    tunnel.onstatechange = (state: number) => {
      // 0=CONNECTING, 1=OPEN, 2=CLOSED
      if (state === 2) {
        setPhase((prev) => (prev === "error" ? "error" : "disconnected"));
        onStateUpdatedRef.current();
      }
    };

    tunnel.onerror = (statusObj: { code: number; message?: string }) => {
      if (hasSpecificErrorRef.current) {
        return;
      }
      setPhase("error");
      setErrorMessage(formatGuacStatusMessage(statusObj.code, statusObj.message));
    };

    const mouse = new Guacamole.Mouse(displayEl);
    const scaleMouseState = (mouseState: MouseState): MouseState => {
      const s = scaleRef.current || 1;
      return {
        ...mouseState,
        x: Math.max(0, Math.round(mouseState.x / s)),
        y: Math.max(0, Math.round(mouseState.y / s)),
      };
    };

    const sendImmediateMouse = (mouseState: MouseState) => {
      if (rafMouseRef.current !== null) {
        window.cancelAnimationFrame(rafMouseRef.current);
        rafMouseRef.current = null;
      }
      pendingMouseStateRef.current = null;
      client.sendMouseState(scaleMouseState(mouseState));
    };

    const sendThrottledMove = (mouseState: MouseState) => {
      pendingMouseStateRef.current = scaleMouseState(mouseState);
      if (rafMouseRef.current === null) {
        rafMouseRef.current = window.requestAnimationFrame(() => {
          rafMouseRef.current = null;
          if (pendingMouseStateRef.current && clientRef.current) {
            clientRef.current.sendMouseState(pendingMouseStateRef.current);
            pendingMouseStateRef.current = null;
          }
        });
      }
    };

    mouse.onmousedown = sendImmediateMouse;
    mouse.onmouseup = sendImmediateMouse;
    mouse.onmousemove = sendThrottledMove;

    const keyboard = new Guacamole.Keyboard(window.document);
    keyboardRef.current = keyboard;
    keyboard.onkeydown = (keysym: number) => {
      if (!keyboardEnabled) return true;
      client.sendKeyEvent(1, keysym);
      return false;
    };
    keyboard.onkeyup = (keysym: number) => {
      if (!keyboardEnabled) return;
      client.sendKeyEvent(0, keysym);
    };

    const query = `csrf_token=${encodeURIComponent(csrfToken)}&width=1920&height=1080`;
    client.connect(query);

    const handleResize = () => updateScale();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      cleanupClient();
    };
  }, [tv.id, csrfToken, connectionAttempt, cleanupClient, updateScale]);

  useEffect(() => {
    updateScale();
  }, [fitToScreen, compactToolbar, updateScale]);

  useEffect(() => {
    if (keyboardRef.current) {
      keyboardRef.current.onkeydown = (keysym: number) => {
        if (!keyboardEnabled) return true;
        clientRef.current?.sendKeyEvent(1, keysym);
        return false;
      };
      keyboardRef.current.onkeyup = (keysym: number) => {
        if (!keyboardEnabled) return;
        clientRef.current?.sendKeyEvent(0, keysym);
      };
    }
  }, [keyboardEnabled]);

  const handleToggleFullscreen = async () => {
    const container = viewportRef.current?.parentElement;
    if (!container) return;
    if (!document.fullscreenElement) {
      try {
        await container.requestFullscreen();
        setIsFullscreen(true);
      } catch {
        // bloqueado pelo navegador
      }
    } else {
      await document.exitFullscreen();
      setIsFullscreen(false);
    }
    setTimeout(() => updateScale(), 150);
  };

  const handleReconnect = () => {
    cleanupClient();
    setConnectionAttempt((n) => n + 1);
  };

  const handleDisconnectAndClose = () => {
    cleanupClient();
    onStateUpdatedRef.current();
    onClose();
  };

  return (
    <div
      className="viewer-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Espelhamento ao vivo ${tv.name}`}
    >
      <div className="viewer-container">
        {!compactToolbar ? (
          <header className="viewer-toolbar">
            <div className="viewer-title-group">
              <div className={`studio-tally studio-tally-${phase}`}>
                <span className="studio-tally-dot" />
                <span>
                  {phase === "connected"
                    ? "AO VIVO"
                    : phase === "connecting"
                    ? "SINCRONIZANDO"
                    : phase === "error"
                    ? "FALHA DE SINAL"
                    : "PAUSADO"}
                </span>
              </div>

              <div className="viewer-meta-block">
                <div className="viewer-title-line">
                  <h2>{tv.name}</h2>
                  <span className="mono-badge">{tv.slug.toUpperCase()}</span>
                  <span className="viewer-res-chip">{resolutionLabel}</span>
                </div>
                <p className="viewer-subtitle">
                  <span>
                    Sessão XFCE: <strong>{tv.unix_user}</strong> (
                    {tv.runtime.detected_display || ":10.0"})
                  </span>
                  <span className="meta-sep">•</span>
                  <span>
                    Loopback: <code>127.0.0.1:{tv.local_port}</code>
                  </span>
                  <span className="meta-sep">•</span>
                  <span className="safe-disconnect-hint">
                    Fechar a visão preserva a TV ligada
                  </span>
                </p>
              </div>
            </div>

            <div className="viewer-actions">
              <button
                type="button"
                className={`hud-btn ${
                  keyboardEnabled ? "hud-btn-active" : ""
                }`}
                onClick={() => setKeyboardEnabled((v) => !v)}
                title="Ativar ou bloquear o envio de teclas para a TV"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10" />
                </svg>
                <span>{keyboardEnabled ? "Teclado Ativo" : "Teclado Bloqueado"}</span>
              </button>

              <button
                type="button"
                className="hud-btn"
                onClick={() => setFitToScreen((v) => !v)}
                title="Alternar entre ajustar automaticamente à janela ou escala real 1:1"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                </svg>
                <span>{fitToScreen ? "Ajustado à Tela" : "Escala 1:1"}</span>
              </button>

              <button
                type="button"
                className="hud-btn"
                onClick={handleToggleFullscreen}
                title="Alternar modo Tela Cheia"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                </svg>
                <span>{isFullscreen ? "Sair Tela Cheia" : "Tela Cheia"}</span>
              </button>

              <button
                type="button"
                className="hud-btn"
                onClick={() => setCompactToolbar(true)}
                title="Modo Cinema (recolher barra superior)"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m18 15-6-6-6 6" />
                </svg>
                <span>Modo Cinema</span>
              </button>

              <button
                type="button"
                className="hud-btn"
                onClick={handleReconnect}
                title="Reiniciar apenas o túnel de vídeo no navegador"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
                <span>Reconectar</span>
              </button>

              <button
                type="button"
                className="hud-btn hud-btn-danger"
                onClick={handleDisconnectAndClose}
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
                <span>Fechar Visão</span>
              </button>
            </div>
          </header>
        ) : (
          <div className="viewer-floating-pill">
            <span className={`phase-dot phase-${phase}`} />
            <strong>{tv.name}</strong>
            <span className="mono-badge">{resolutionLabel}</span>
            <button
              type="button"
              className="hud-btn hud-btn-xs"
              onClick={() => setCompactToolbar(false)}
            >
              Expandir Barra
            </button>
            <button
              type="button"
              className="hud-btn hud-btn-danger hud-btn-xs"
              onClick={handleDisconnectAndClose}
            >
              Fechar
            </button>
          </div>
        )}

        <div className="viewer-viewport" ref={viewportRef}>
          {phase === "connecting" && (
            <div className="viewer-status-banner">
              <div className="spinner" />
              <h3>Sincronizando sinal de vídeo da {tv.name}</h3>
              <p>
                Negociando stream Guacamole com o FreeRDP Shadow em{" "}
                <code>127.0.0.1:{tv.local_port}</code> ({tv.unix_user})...
              </p>
            </div>
          )}

          {phase === "error" && (
            <div className="viewer-status-banner viewer-error-banner">
              <div className="banner-icon-circle banner-icon-danger">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <h3>Sinal de espelhamento indisponível</h3>
              <p>{errorMessage}</p>
              <div className="banner-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleReconnect}
                >
                  Tentar Novamente
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleDisconnectAndClose}
                >
                  Voltar ao Painel
                </button>
              </div>
            </div>
          )}

          {phase === "disconnected" && (
            <div className="viewer-status-banner">
              <div className="banner-icon-circle">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
              </div>
              <h3>Transmissão encerrada</h3>
              <p>
                A conexão do navegador foi fechada. A sessão gráfica XFCE na TV
                permanece ligada e operando normalmente.
              </p>
              <div className="banner-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleReconnect}
                >
                  Reconectar Agora
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleDisconnectAndClose}
                >
                  Voltar ao Painel
                </button>
              </div>
            </div>
          )}

          <div
            ref={displayHostRef}
            className="guac-display-host"
            tabIndex={0}
          />
        </div>
      </div>
    </div>
  );
};

export const LiveShadowViewer = React.memo(LiveShadowViewerComponent);
