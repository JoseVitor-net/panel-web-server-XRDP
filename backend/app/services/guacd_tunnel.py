import asyncio
import codecs
import logging
import uuid
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from app.config import get_settings

logger = logging.getLogger("tv_panel.guacd")


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


def split_complete_guac_instructions(buffer: str) -> tuple[str, str]:
    """
    Divide o buffer acumulado em (lote_de_instrucoes_completas, cauda_incompleta).
    O Guacamole.WebSocketTunnel no navegador exige que CADA frame WebSocket contenha
    apenas instruções completas terminadas em ';'. Caso um chunk TCP de 64KB corte
    uma instrução 'blob' no meio, enviar o chunk incompleto faz o WebSocketTunnel
    disparar 'Incomplete instruction' e encerrar o socket imediatamente.
    Esta função avança pelos comprimentos em O(K) saltando o corpo dos blobs em O(1).
    """
    idx = 0
    n = len(buffer)
    last_complete_end = 0

    while idx < n:
        dot_pos = buffer.find(".", idx)
        if dot_pos == -1:
            break
        length_str = buffer[idx:dot_pos]
        if not length_str.isdigit():
            raise ValueError(
                f"Protocolo Guacamole inválido no stream do guacd: '{length_str[:32]}'"
            )
        length = int(length_str)
        val_end = dot_pos + 1 + length
        if val_end >= n:
            break
        terminator = buffer[val_end]
        idx = val_end + 1
        if terminator == ";":
            last_complete_end = idx
        elif terminator != ",":
            raise ValueError(
                f"Terminador inesperado no stream do guacd: '{terminator}'"
            )

    if last_complete_end == 0:
        return "", buffer
    return buffer[:last_complete_end], buffer[last_complete_end:]


def build_rdp_connection_params(tv_row: dict[str, Any], width: int, height: int) -> dict[str, str]:
    """
    Constrói os parâmetros seguros de conexão RDP entre guacd e o FreeRDP Shadow local.
    O navegador nunca fornece host, porta ou argumentos de sistema: todos vêm do registro validado no banco.
    """
    port = str(int(tv_row["local_port"]))
    sec_mode = str(tv_row.get("sec_mode", "rdp"))
    # IMPORTANTE: Usa security="any" com ignore-cert="true" para negociar automaticamente TLS/RDP com o
    # freerdp-shadow-cli3 em 127.0.0.1, e color-depth="32" para coincidir com a superfície X11 (1920x1080@32).
    return {
        "hostname": "127.0.0.1",
        "port": port,
        "security": "nla" if sec_mode == "nla" else "any",
        "ignore-cert": "true",
        "disable-auth": "false" if tv_row.get("shadow_auth_enabled") else "true",
        "width": str(max(640, min(width, 3840))),
        "height": str(max(360, min(height, 2160))),
        "dpi": "96",
        "color-depth": "32",
        "disable-audio": "true",
        "enable-audio-input": "false",
        "disable-bitmap-caching": "true",
        "disable-offscreen-caching": "true",
        "disable-glyph-caching": "true",
    }


async def run_guacd_websocket_tunnel(
    websocket: WebSocket,
    tv_row: dict[str, Any],
    width: int = 1920,
    height: int = 1080,
) -> None:
    """
    Estabelece o handshake do protocolo Guacamole com o daemon local guacd (127.0.0.1:4822)
    e faz o repasse bidirecional de instruções para o cliente guacamole-common-js no navegador,
    tratando também o opcode interno "" (UUID do túnel e heartbeats "ping") exigido pelo WebSocketTunnel.
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
                "Não foi possível conectar ao gateway local guacd (127.0.0.1:4822). Verifique se o container/serviço guacd está ativo.",
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

        connect_values: list[str] = []
        for arg_name in expected_arg_names:
            if arg_name.startswith("VERSION_"):
                connect_values.append(arg_name)
            else:
                connect_values.append(rdp_params.get(arg_name, ""))

        handshake_payload += encode_guac_instruction("connect", *connect_values)
        writer.write(handshake_payload.encode("utf-8"))
        await writer.drain()

        # 4. Envia o UUID interno do túnel (opcode vazio "") esperado pelo Guacamole.WebSocketTunnel
        ws_send_lock = asyncio.Lock()

        async def send_ws_text(payload: str) -> None:
            async with ws_send_lock:
                await websocket.send_text(payload)

        tunnel_uuid = str(uuid.uuid4())
        await send_ws_text(encode_guac_instruction("", tunnel_uuid))

        async def browser_to_guacd() -> None:
            client_buf = ""
            try:
                while True:
                    msg = await websocket.receive_text()
                    if not msg:
                        continue
                    client_buf += msg
                    forward_chunks: list[str] = []
                    while True:
                        try:
                            parsed, client_buf = parse_guac_instruction(client_buf)
                        except ValueError:
                            client_buf = ""
                            break
                        if parsed is None:
                            break
                        # Intercepta instruções internas do WebSocketTunnel (opcode == "")
                        if len(parsed) >= 1 and parsed[0] == "":
                            if len(parsed) >= 3 and parsed[1] == "ping":
                                await send_ws_text(
                                    encode_guac_instruction("", "ping", parsed[2])
                                )
                            continue
                        forward_chunks.append(encode_guac_instruction(*parsed))

                    if forward_chunks:
                        writer.write("".join(forward_chunks).encode("utf-8"))
                        await writer.drain()
            except WebSocketDisconnect:
                pass

        async def guacd_to_browser(initial_buf: str) -> None:
            guac_buf = initial_buf
            if guac_buf:
                complete_batch, guac_buf = split_complete_guac_instructions(guac_buf)
                if complete_batch:
                    await send_ws_text(complete_batch)
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            while True:
                data = await reader.read(65536)
                if not data:
                    tail = decoder.decode(b"", final=True)
                    if tail:
                        guac_buf += tail
                    if guac_buf:
                        complete_batch, _ = split_complete_guac_instructions(guac_buf)
                        if complete_batch:
                            await send_ws_text(complete_batch)
                    break
                text = decoder.decode(data, final=False)
                if text:
                    guac_buf += text
                    complete_batch, guac_buf = split_complete_guac_instructions(guac_buf)
                    if complete_batch:
                        if "5.error," in complete_batch:
                            logger.warning(
                                "guacd reportou erro para TV %s: %s",
                                tv_row.get("slug"),
                                complete_batch[:200],
                            )
                        await send_ws_text(complete_batch)

        done, pending = await asyncio.wait(
            [
                asyncio.create_task(browser_to_guacd(), name="browser_to_guacd"),
                asyncio.create_task(guacd_to_browser(buf), name="guacd_to_browser"),
            ],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in done:
            exc = task.exception()
            if exc is not None:
                logger.warning(
                    "Tarefa '%s' do túnel Guacamole da TV %s encerrou com exceção: %s",
                    task.get_name(),
                    tv_row.get("slug"),
                    exc,
                )
        for task in pending:
            task.cancel()
        try:
            await send_ws_text(encode_guac_instruction("disconnect"))
            await websocket.close()
        except Exception:
            pass
    except Exception as exc:
        logger.exception("Erro no túnel WebSocket Guacamole da TV %s: %s", tv_row.get("slug"), exc)
        try:
            await websocket.send_text(
                encode_guac_instruction(
                    "error",
                    "A sessão de espelhamento RDP foi interrompida ou recusada pelo Shadow local.",
                    "519",
                )
            )
            await websocket.close(code=1011)
        except Exception:
            pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass
