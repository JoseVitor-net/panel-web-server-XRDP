import asyncio
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from app.config import get_settings


def encode_guac_instruction(*elements: str) -> str:
    """Codifica uma instrução no formato do protocolo Apache Guacamole (ex: '6.select,3.rdp;')."""
    parts = [f"{len(str(el))}.{el}" for el in elements]
    return ",".join(parts) + ";"


def parse_guac_instruction(buffer: str) -> tuple[list[str] | None, str]:
    """
    Lê uma instrução completa do buffer do protocolo Guacamole.
    Retorna (elementos, restante_do_buffer) ou (None, buffer_original) se incompleta.
    """
    idx = 0
    n = len(buffer)
    elements: list[str] = []

    while idx < n:
        dot_pos = buffer.find(".", idx)
        if dot_pos == -1:
            return None, buffer
        length_str = buffer[idx:dot_pos]
        if not length_str.isdigit():
            raise ValueError(f"Protocolo Guacamole inválido: comprimento inválido '{length_str}'")
        length = int(length_str)
        val_start = dot_pos + 1
        val_end = val_start + length
        if val_end >= n:
            return None, buffer
        elements.append(buffer[val_start:val_end])
        terminator = buffer[val_end]
        idx = val_end + 1
        if terminator == ";":
            return elements, buffer[idx:]
        if terminator != ",":
            raise ValueError(f"Terminador inesperado no protocolo Guacamole: '{terminator}'")

    return None, buffer


def build_rdp_connection_params(tv_row: dict[str, Any], width: int, height: int) -> dict[str, str]:
    """
    Constrói os parâmetros seguros de conexão RDP entre guacd e o FreeRDP Shadow local.
    O navegador nunca fornece host, porta ou argumentos de sistema: todos vêm do registro validado no banco.
    """
    port = str(int(tv_row["local_port"]))
    sec_mode = str(tv_row.get("sec_mode", "rdp"))
    # IMPORTANTE: anexar-se ao FreeRDP Shadow em 127.0.0.1 sem criar nova sessão XRDP
    return {
        "hostname": "127.0.0.1",
        "port": port,
        "security": sec_mode,
        "ignore-cert": "true",
        "disable-auth": "false" if tv_row.get("shadow_auth_enabled") else "true",
        "width": str(max(640, min(width, 3840))),
        "height": str(max(360, min(height, 2160))),
        "dpi": "96",
        "color-depth": "24",
        "resize-method": "reconnect",
        "enable-wallpaper": "true",
        "enable-theming": "true",
        "enable-font-smoothing": "true",
    }


async def run_guacd_websocket_tunnel(
    websocket: WebSocket,
    tv_row: dict[str, Any],
    width: int = 1920,
    height: int = 1080,
) -> None:
    """
    Estabelece o handshake do protocolo Guacamole com o daemon local guacd (127.0.0.1:4822)
    e faz o repasse bidirecional de instruções para o cliente guacamole-common-js no navegador.
    """
    settings = get_settings()

    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(settings.guacd_host, settings.guacd_port),
            timeout=5.0,
        )
    except Exception:
        await websocket.send_text(
            encode_guac_instruction(
                "error",
                "Não foi possível conectar ao gateway local guacd (127.0.0.1:4822). Verifique se o serviço guacd está ativo.",
                "514",
            )
        )
        await websocket.close(code=1011)
        return

    try:
        # 1. Envia instrução 'select,rdp;' para o guacd
        writer.write(encode_guac_instruction("select", "rdp").encode("utf-8"))
        await writer.drain()

        # 2. Aguarda 'args,...;' do guacd
        buf = ""
        args_instruction: list[str] | None = None
        while args_instruction is None:
            chunk = await asyncio.wait_for(reader.read(4096), timeout=5.0)
            if not chunk:
                raise RuntimeError("Conexão encerrada pelo guacd durante o handshake.")
            buf += chunk.decode("utf-8", errors="replace")
            args_instruction, buf = parse_guac_instruction(buf)

        if not args_instruction or args_instruction[0] != "args":
            raise RuntimeError("Resposta inesperada do guacd ao iniciar protocolo RDP.")

        expected_arg_names = args_instruction[1:]
        rdp_params = build_rdp_connection_params(tv_row, width=width, height=height)

        # 3. Envia size, audio, video, image e connect na sequência exigida pelo guacd
        handshake_payload = (
            encode_guac_instruction("size", str(width), str(height), "96")
            + encode_guac_instruction("audio")
            + encode_guac_instruction("video")
            + encode_guac_instruction("image", "image/png", "image/jpeg", "image/webp")
        )

        # Em guacd 1.5+/1.6+, o primeiro argumento de args costuma ser VERSION_1_3_0 / VERSION_1_5_0
        connect_values: list[str] = []
        for arg_name in expected_arg_names:
            if arg_name.startswith("VERSION_"):
                connect_values.append(arg_name)
            else:
                connect_values.append(rdp_params.get(arg_name, ""))

        handshake_payload += encode_guac_instruction("connect", *connect_values)
        writer.write(handshake_payload.encode("utf-8"))
        await writer.drain()

        # Se sobrou algum dado no buffer após o 'args', envia ao cliente WebSocket
        if buf:
            await websocket.send_text(buf)

        async def browser_to_guacd() -> None:
            try:
                while True:
                    msg = await websocket.receive_text()
                    if msg:
                        writer.write(msg.encode("utf-8"))
                        await writer.drain()
            except WebSocketDisconnect:
                pass

        async def guacd_to_browser() -> None:
            while True:
                data = await reader.read(16384)
                if not data:
                    break
                await websocket.send_text(data.decode("utf-8", errors="replace"))

        done, pending = await asyncio.wait(
            [
                asyncio.create_task(browser_to_guacd()),
                asyncio.create_task(guacd_to_browser()),
            ],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
    except Exception:
        try:
            await websocket.send_text(
                encode_guac_instruction(
                    "error",
                    "A sessão de espelhamento RDP foi interrompida ou recusada pelo Shadow local.",
                    "519",
                )
            )
        except Exception:
            pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass

