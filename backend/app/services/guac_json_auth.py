import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


def create_encrypted_guacamole_json_token(
    *,
    secret_key_hex: str,
    username: str,
    tv_row: dict[str, Any],
    ttl_seconds: int = 300,
) -> str:
    """
    Gera token compatível com a extensão oficial `guacamole-auth-json` (HMAC-SHA256 + AES-128-CBC).
    Permite integração direta caso o administrador opte por usar também o webapp oficial Apache Guacamole
    além do cliente guacamole-common-js embutido no painel.
    Nunca expõe a chave secreta ao navegador e define expiração curta (padrão 5 minutos).
    """
    key_bytes = bytes.fromhex(secret_key_hex.strip())
    if len(key_bytes) != 16:
        raise ValueError("A chave hexadecimal do guacamole-auth-json deve ter exatamente 128 bits (32 caracteres hex).")

    expires_ms = int((time.time() + ttl_seconds) * 1000)
    conn_name = f"{tv_row['slug']} ({tv_row['name']})"

    payload = {
        "username": username,
        "expires": expires_ms,
        "connections": {
            conn_name: {
                "protocol": "rdp",
                "parameters": {
                    "hostname": "127.0.0.1",
                    "port": str(int(tv_row["local_port"])),
                    "security": str(tv_row.get("sec_mode", "rdp")),
                    "ignore-cert": "true",
                    "disable-auth": "false" if tv_row.get("shadow_auth_enabled") else "true",
                    "color-depth": "24",
                },
            }
        },
    }

    json_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(key_bytes, json_bytes, hashlib.sha256).digest()
    signed_data = signature + json_bytes

    padder = padding.PKCS7(128).padder()
    padded_data = padder.update(signed_data) + padder.finalize()

    iv = os.urandom(16)
    cipher = Cipher(algorithms.AES(key_bytes), modes.CBC(iv))
    encryptor = cipher.encryptor()
    ciphertext = encryptor.update(padded_data) + encryptor.finalize()

    return base64.b64encode(iv + ciphertext).decode("ascii")

