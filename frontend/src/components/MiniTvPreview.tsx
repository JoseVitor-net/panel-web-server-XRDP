import React, { useCallback, useEffect, useRef, useState } from "react";
import Guacamole, { Client } from "guacamole-common-js";
import { TVItem } from "../types";

interface MiniTvPreviewProps {
  tv: TVItem;
  csrfToken: string;
}

export const MiniTvPreview: React.FC<MiniTvPreviewProps> = ({
  tv,
  csrfToken,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<Client | null>(null);
  const [liveFrameReady, setLiveFrameReady] = useState<boolean>(false);

  const fitPreviewScale = useCallback((explicitW?: number, explicitH?: number) => {
    const client = clientRef.current;
    const container = containerRef.current;
    if (!client || !container) return;
    const display = client.getDisplay();
    const w = explicitW ?? display.getWidth();
    const h = explicitH ?? display.getHeight();
    if (w <= 0 || h <= 0) return;
    const rect = container.getBoundingClientRect();
    const cw = rect.width || container.clientWidth;
    const ch = rect.height || container.clientHeight;
    if (cw <= 0 || ch <= 0) return;

    const scale = Math.min(cw / w, ch / h);
    if (scale > 0) {
      display.scale(scale);
      const displayEl = display.getElement();
      const scaledW = w * scale;
      const scaledH = h * scale;
      const stretchX = scaledW > 0 ? cw / scaledW : 1;
      const stretchY = scaledH > 0 ? ch / scaledH : 1;
      displayEl.style.transformOrigin = "center center";
      displayEl.style.transform =
        Math.abs(stretchX - 1) > 0.02 || Math.abs(stretchY - 1) > 0.02
          ? `scale(${stretchX.toFixed(4)}, ${stretchY.toFixed(4)})`
          : "none";
    }
  }, []);

  useEffect(() => {
    setLiveFrameReady(false);
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/ws/tv/${tv.id}`;
    const tunnel = new Guacamole.WebSocketTunnel(wsUrl);
    const client = new Guacamole.Client(tunnel);
    clientRef.current = client;

    const display = client.getDisplay();
    display.showCursor(false);
    const displayEl = display.getElement();
    if (hostRef.current) {
      hostRef.current.innerHTML = "";
      hostRef.current.appendChild(displayEl);
    }

    display.onresize = (w: number, h: number) => {
      if (w > 0 && h > 0) {
        setLiveFrameReady(true);
        fitPreviewScale(w, h);
        window.requestAnimationFrame(() => fitPreviewScale(w, h));
      }
    };

    client.onstatechange = (state: number) => {
      if (state === 3) {
        const w = display.getWidth();
        const h = display.getHeight();
        if (w > 0 && h > 0) {
          setLiveFrameReady(true);
          fitPreviewScale(w, h);
          window.requestAnimationFrame(() => fitPreviewScale(w, h));
        }
      }
    };

    try {
      const connectQuery = new URLSearchParams({
        csrf_token: csrfToken,
        width: "1280",
        height: "720",
        preview: "1",
      }).toString();
      client.connect(connectQuery);
    } catch {
      // fallback visual permanece ativo se o preview não conectar imediatamente
    }

    const ro = new ResizeObserver(() => {
      fitPreviewScale();
    });
    if (containerRef.current) {
      ro.observe(containerRef.current);
    }

    return () => {
      ro.disconnect();
      try {
        client.disconnect();
      } catch {
        // ignora erro ao desmontar preview
      }
      clientRef.current = null;
      if (hostRef.current) {
        hostRef.current.innerHTML = "";
      }
    };
  }, [tv.id, csrfToken, fitPreviewScale]);

  return (
    <div ref={containerRef} className="vbox-preview-stage">
      {/* Canvas ao vivo do Guacamole (estilo miniatura VirtualBox) */}
      <div
        ref={hostRef}
        className={`vbox-guac-canvas ${liveFrameReady ? "is-ready" : ""}`}
      />

      {/* Wireframe estilo VirtualBox enquanto o primeiro frame carrega */}
      {!liveFrameReady && (
        <div className="vbox-synthetic-desktop">
          <div className="vbox-top-panel">
            <span className="vbox-panel-pill">XFCE4 Desktop</span>
            <span className="vbox-panel-clock">
              {tv.runtime.detected_display || ":10.0"} • {tv.unix_user}
            </span>
          </div>
          <div className="vbox-window-mock">
            <div className="vbox-win-titlebar">
              <span className="vbox-win-dots">
                <i />
                <i />
                <i />
              </span>
              <span>Sessão Ativa — {tv.name}</span>
            </div>
            <div className="vbox-win-body">
              <div className="vbox-win-stat">
                <span>CPU</span>
                <strong>{(tv.runtime.cpu_percent ?? 0).toFixed(1)}%</strong>
              </div>
              <div className="vbox-win-stat">
                <span>RAM</span>
                <strong>{(tv.runtime.memory_mb ?? 0).toFixed(0)} MB</strong>
              </div>
              <div className="vbox-win-stat">
                <span>Proc</span>
                <strong>{tv.runtime.process_count ?? 0}</strong>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Overlay no Hover para abrir em Tela Cheia */}
      <div className="vbox-hover-cta">
        <div className="play-circle">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
            <polygon points="6 3 20 12 6 21 6 3" />
          </svg>
        </div>
        <strong>Expandir Espelhamento ao Vivo</strong>
        <small>Clique para abrir e interagir em tela cheia</small>
      </div>
    </div>
  );
};

