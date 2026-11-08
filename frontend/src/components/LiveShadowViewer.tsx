import React, { useCallback, useEffect, useRef, useState } from "react";
import Guacamole, { Client, Keyboard, MouseState } from "guacamole-common-js";
import { TVItem } from "../types";

interface LiveShadowViewerProps {
  tv: TVItem;
  csrfToken: string;
  onClose: () => void;
  onStateUpdated: () => void;
}

type TunnelPhase =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

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
      const padW = Math.max(320, viewport.clientWidth - 16);
      const padH = Math.max(240, viewport.clientHeight - 16);
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
      // Estados Guacamole.Client: 0=IDLE, 1=CONNECTING, 2=WAITING, 3=CONNECTED, 4=DISCONNECTING, 5=DISCONNECTED
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
      setPhase("error");
      setErrorMessage(
        statusObj.message ||
          `Falha no túnel RDP Shadow (código ${statusObj.code}). Verifique se o serviço guacd e o Shadow da TV estão ativos.`
      );
    };

    tunnel.onstatechange = (state: number) => {
      // Estados Guacamole.Tunnel: 0=CONNECTING, 1=OPEN, 2=CLOSED
      if (state === 2) {
        setPhase((prev) => (prev === "error" ? "error" : "disconnected"));
        onStateUpdatedRef.current();
      }
    };

    tunnel.onerror = (statusObj: { code: number; message?: string }) => {
      setPhase("error");
      setErrorMessage(
        statusObj.message ||
          `Não foi possível estabelecer o túnel WebSocket com o gateway Guacamole (código ${statusObj.code}).`
      );
    };

    // Controle de mouse com compensação de escala e throttling via requestAnimationFrame
    // para movimentos puros (evita saturar o WebSocket em mouses de 1000Hz)
    const mouse = new Guacamole.Mouse(displayEl);
    const scaleMouseState = (mouseState: MouseState): MouseState => {
      const s = scaleRef.current || 1;
      return {
        ...mouseState,
        x: Math.round(mouseState.x / s),
        y: Math.round(mouseState.y / s),
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

    // Controle de teclado
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
        // navegador bloqueou fullscreen
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
              <span className={`phase-dot phase-${phase}`} />
              <div>
                <div className="viewer-title-line">
                  <h2>{tv.name}</h2>
                  <span className="mono-badge">{tv.slug}</span>
                  <span className="viewer-res-chip">{resolutionLabel}</span>
                </div>
                <p className="viewer-subtitle">
                  Sessão XFCE: <strong>{tv.unix_user}</strong> (
                  {tv.runtime.detected_display || "display ativo"}) • Loopback:{" "}
                  <code>127.0.0.1:{tv.local_port}</code> • Desconectar a visão{" "}
                  <strong>não encerra</strong> o XFCE da TV
                </p>
              </div>
            </div>

            <div className="viewer-actions">
              <button
                type="button"
                className={`btn btn-sm ${
                  keyboardEnabled ? "btn-active-toggle" : "btn-secondary"
                }`}
                onClick={() => setKeyboardEnabled((v) => !v)}
                title="Ativa ou pausa o envio de teclas para a sessão remota"
              >
                {keyboardEnabled ? "⌨ Teclado: Ativo" : "⌨ Teclado: Pausado"}
              </button>

              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setFitToScreen((v) => !v)}
                title="Alterna entre ajustar automaticamente à janela ou escala 100%"
              >
                {fitToScreen ? "⤢ Ajustado à Tela" : "1:1 Escala Real"}
              </button>

              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleToggleFullscreen}
              >
                {isFullscreen ? "Sair da Tela Cheia" : "⛶ Tela Cheia"}
              </button>

              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setCompactToolbar(true)}
                title="Recolher barra superior para ampliar a área útil"
              >
                ▲ Ocultar Barra
              </button>

              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleReconnect}
              >
                ↻ Reconectar
              </button>

              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={handleDisconnectAndClose}
              >
                ✕ Fechar Visão
              </button>
            </div>
          </header>
        ) : (
          <div className="viewer-floating-pill">
            <span className={`phase-dot phase-${phase}`} />
            <strong>{tv.slug.toUpperCase()}</strong>
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              onClick={() => setCompactToolbar(false)}
            >
              ▼ Mostrar Barra
            </button>
            <button
              type="button"
              className="btn btn-danger btn-xs"
              onClick={handleDisconnectAndClose}
            >
              ✕ Sair
            </button>
          </div>
        )}

        <div className="viewer-viewport" ref={viewportRef}>
          {phase === "connecting" && (
            <div className="viewer-status-banner">
              <div className="spinner" />
              <h3>Conectando à sessão gráfica da {tv.name}</h3>
              <p>
                Anexando via <code>guacd</code> ao FreeRDP Shadow em{" "}
                <code>127.0.0.1:{tv.local_port}</code> ({tv.unix_user})...
              </p>
            </div>
          )}

          {phase === "error" && (
            <div className="viewer-status-banner viewer-error-banner">
              <h3>Não foi possível abrir o espelhamento ao vivo</h3>
              <p>{errorMessage}</p>
              <div className="banner-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleReconnect}
                >
                  ↻ Tentar Novamente
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
              <h3>Visualização encerrada</h3>
              <p>
                O túnel do navegador foi desconectado. A sessão gráfica XFCE na
                TV permanece ativa e intacta.
              </p>
              <div className="banner-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleReconnect}
                >
                  ↻ Reconectar Agora
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleDisconnectAndClose}
                >
                  Fechar
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
