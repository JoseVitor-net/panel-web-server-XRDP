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

export const LiveShadowViewer: React.FC<LiveShadowViewerProps> = ({
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
  const [connectionAttempt, setConnectionAttempt] = useState<number>(1);
  const scaleRef = useRef<number>(1);

  const updateScale = useCallback((explicitW?: number, explicitH?: number) => {
    const client = clientRef.current;
    const viewport = viewportRef.current;
    if (!client || !viewport) return;
    const display = client.getDisplay();
    const w = explicitW ?? display.getWidth();
    const h = explicitH ?? display.getHeight();
    if (w <= 0 || h <= 0) return;
    if (viewport.clientWidth <= 0 || viewport.clientHeight <= 0) return;

    const scaleX = viewport.clientWidth / w;
    const scaleY = viewport.clientHeight / h;
    const nextScale = Math.min(scaleX, scaleY, 1.5);
    if (nextScale > 0) {
      display.scale(nextScale);
      scaleRef.current = nextScale;
    }
  }, []);

  const cleanupClient = useCallback(() => {
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

    tunnel.onerror = (statusObj: { code: number; message?: string }) => {
      setPhase("error");
      setErrorMessage(
        statusObj.message ||
          `Não foi possível estabelecer o túnel WebSocket com o gateway Guacamole (código ${statusObj.code}).`
      );
    };

    // Controle de mouse com compensação de escala
    const mouse = new Guacamole.Mouse(displayEl);
    const forwardMouse = (mouseState: MouseState) => {
      const s = scaleRef.current || 1;
      const scaledState: MouseState = {
        ...mouseState,
        x: Math.round(mouseState.x / s),
        y: Math.round(mouseState.y / s),
      };
      client.sendMouseState(scaledState);
    };
    mouse.onmousedown = forwardMouse;
    mouse.onmouseup = forwardMouse;
    mouse.onmousemove = forwardMouse;

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
    const container = viewportRef.current;
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
    <div className="viewer-overlay" role="dialog" aria-modal="true" aria-label={`Espelhamento ao vivo ${tv.name}`}>
      <div className="viewer-container">
        <header className="viewer-toolbar">
          <div className="viewer-title-group">
            <span className={`phase-dot phase-${phase}`} />
            <div>
              <h2>
                {tv.name} <span className="mono-badge">{tv.slug}</span>
              </h2>
              <p className="viewer-subtitle">
                Usuário XFCE: <strong>{tv.unix_user}</strong> ({tv.runtime.detected_display || "display ativo"}) •
                Shadow Loopback: <code>127.0.0.1:{tv.local_port}</code> •
                Desconectar o navegador <strong>não encerra</strong> a sessão XFCE da TV.
              </p>
            </div>
          </div>

          <div className="viewer-actions">
            <button
              type="button"
              className={`btn btn-secondary ${keyboardEnabled ? "btn-active-toggle" : ""}`}
              onClick={() => setKeyboardEnabled((v) => !v)}
              title="Ativa ou pausa o envio de teclas para a sessão remota"
            >
              {keyboardEnabled ? "Teclado: Ativo" : "Teclado: Pausado"}
            </button>

            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleToggleFullscreen}
            >
              {isFullscreen ? "Sair da Tela Cheia" : "Tela Cheia"}
            </button>

            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleReconnect}
            >
              Reconectar
            </button>

            <button
              type="button"
              className="btn btn-danger"
              onClick={handleDisconnectAndClose}
            >
              Desconectar Visão
            </button>
          </div>
        </header>

        <div className="viewer-viewport" ref={viewportRef}>
          {phase === "connecting" && (
            <div className="viewer-status-banner">
              <div className="spinner" />
              <p>Conectando ao FreeRDP Shadow em <code>127.0.0.1:{tv.local_port}</code> via Guacamole (`guacd`)...</p>
            </div>
          )}

          {phase === "error" && (
            <div className="viewer-status-banner viewer-error-banner">
              <h3>Não foi possível abrir o espelhamento ao vivo</h3>
              <p>{errorMessage}</p>
              <div className="banner-actions">
                <button type="button" className="btn btn-primary" onClick={handleReconnect}>
                  Tentar Novamente
                </button>
                <button type="button" className="btn btn-secondary" onClick={handleDisconnectAndClose}>
                  Voltar ao Painel
                </button>
              </div>
            </div>
          )}

          {phase === "disconnected" && (
            <div className="viewer-status-banner">
              <h3>Conexão encerrada</h3>
              <p>A visualização no navegador foi desconectada. A sessão gráfica XFCE na TV permanece intacta.</p>
              <div className="banner-actions">
                <button type="button" className="btn btn-primary" onClick={handleReconnect}>
                  Reconectar
                </button>
                <button type="button" className="btn btn-secondary" onClick={handleDisconnectAndClose}>
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
