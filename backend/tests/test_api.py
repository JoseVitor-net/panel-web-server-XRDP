import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Configura ambiente de simulação isolado para os testes automatizados
_TEMP_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TEMP_DB.close()
os.environ["TV_PANEL_ENV_MODE"] = "simulation"
os.environ["TV_PANEL_DB_PATH"] = _TEMP_DB.name
os.environ["TV_PANEL_COOKIE_SECURE"] = "false"

from app.cli import cmd_create_admin  # noqa: E402
from app.db import run_migrations  # noqa: E402
from app.main import app  # noqa: E402
from app.services.guac_json_auth import create_encrypted_guacamole_json_token  # noqa: E402
from app.services.guacd_tunnel import encode_guac_instruction, parse_guac_instruction  # noqa: E402
from app.services.system_inspector import _SIMULATED_STATE  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def setup_database():
    run_migrations(Path(_TEMP_DB.name))
    # Cria administrador de teste via função interna usando stdin simulado
    import io
    import sys

    old_stdin = sys.stdin
    sys.stdin = io.StringIO("SenhaForte#2026!\n")
    try:
        rc = cmd_create_admin("operador_noc", password_stdin=True)
        assert rc == 0
    finally:
        sys.stdin = old_stdin
    yield


def test_root_admin_creation_is_rejected():
    rc = cmd_create_admin("root", password_stdin=True)
    assert rc == 1


def test_unauthenticated_access_is_blocked():
    client = TestClient(app)
    resp = client.get("/api/tvs")
    assert resp.status_code == 401


def test_login_csrf_and_initial_tvs():
    client = TestClient(app)

    # Login com senha incorreta falha
    bad_resp = client.post(
        "/api/auth/login",
        json={"username": "operador_noc", "password": "wrong-password"},
    )
    assert bad_resp.status_code == 401

    # Login correto retorna CSRF token e define cookie HttpOnly
    login_resp = client.post(
        "/api/auth/login",
        json={"username": "operador_noc", "password": "SenhaForte#2026!"},
    )
    assert login_resp.status_code == 200
    data = login_resp.json()
    assert data["authenticated"] is True
    assert data["username"] == "operador_noc"
    csrf_token = data["csrf_token"]
    assert len(csrf_token) > 20

    # Listagem das TVs iniciais: tv01 (3391), tv02 (3392), tv03 (3393)
    tvs_resp = client.get("/api/tvs")
    assert tvs_resp.status_code == 200
    tvs = tvs_resp.json()
    assert len(tvs) == 3
    assert [t["slug"] for t in tvs] == ["tv01", "tv02", "tv03"]
    assert [t["local_port"] for t in tvs] == [3391, 3392, 3393]

    # Verifica separação explícita dos 3 indicadores: sessão XFCE, listener Shadow e espectador conectado
    tv03 = tvs[2]
    assert tv03["bind_address"] == "127.0.0.1"
    assert "-gfx +server-side-cursor" in tv03["effective_shadow_flags_preview"]
    assert tv03["runtime"]["xfce_session_state"] == "active"
    assert tv03["runtime"]["shadow_service_state"] == "available"
    assert tv03["runtime"]["viewer_connection_state"] == "idle"
    assert tv03["runtime"]["overall_status"] == "online"

    # Mutação sem header X-CSRF-Token deve ser bloqueada com 403
    no_csrf_resp = client.post(
        "/api/tvs",
        json={
            "slug": "tv04",
            "name": "TV 04",
            "location": "Corredor",
            "unix_user": "tv04",
            "local_port": 3394,
        },
    )
    assert no_csrf_resp.status_code == 403


def test_validation_rejects_root_and_xrdp_port_3389():
    client = TestClient(app)
    login_resp = client.post(
        "/api/auth/login",
        json={"username": "operador_noc", "password": "SenhaForte#2026!"},
    )
    csrf = login_resp.json()["csrf_token"]
    headers = {"X-CSRF-Token": csrf}

    # Proíbe usuário root
    r_root = client.post(
        "/api/tvs",
        headers=headers,
        json={
            "slug": "tv_root",
            "name": "TV Root",
            "location": "Teste",
            "unix_user": "root",
            "local_port": 3395,
        },
    )
    assert r_root.status_code == 422

    # Proíbe porta 3389 do XRDP
    r_3389 = client.post(
        "/api/tvs",
        headers=headers,
        json={
            "slug": "tv_xrdp",
            "name": "TV XRDP",
            "location": "Teste",
            "unix_user": "tv05",
            "local_port": 3389,
        },
    )
    assert r_3389.status_code == 422


def test_disruptive_actions_require_explicit_confirmation():
    client = TestClient(app)
    login_resp = client.post(
        "/api/auth/login",
        json={"username": "operador_noc", "password": "SenhaForte#2026!"},
    )
    csrf = login_resp.json()["csrf_token"]
    headers = {"X-CSRF-Token": csrf}

    # Tentar parar ou reiniciar sem confirm_disruption=True retorna 409 Conflict
    stop_no_confirm = client.post(
        "/api/tvs/1/service",
        headers=headers,
        json={"action": "restart", "confirm_disruption": False},
    )
    assert stop_no_confirm.status_code == 409

    # Com confirm_disruption=True, a ação é executada e auditada
    restart_ok = client.post(
        "/api/tvs/1/service",
        headers=headers,
        json={"action": "restart", "confirm_disruption": True},
    )
    assert restart_ok.status_code == 200
    assert restart_ok.json()["runtime"]["shadow_service_state"] == "available"


def test_unknown_state_never_shown_as_online():
    client = TestClient(app)
    login_resp = client.post(
        "/api/auth/login",
        json={"username": "operador_noc", "password": "SenhaForte#2026!"},
    )
    assert login_resp.status_code == 200

    # Simula falha de verificação na tv02
    original = dict(_SIMULATED_STATE["tv02"])
    try:
        _SIMULATED_STATE["tv02"]["xfce_session_state"] = "unknown"
        resp = client.get("/api/tvs/2")
        assert resp.status_code == 200
        rt = resp.json()["runtime"]
        assert rt["overall_status"] == "unknown"
        assert "desconhecido" in rt["user_message"].lower()
    finally:
        _SIMULATED_STATE["tv02"] = original


def test_guacamole_protocol_and_encrypted_json_token():
    encoded = encode_guac_instruction("select", "rdp")
    assert encoded == "6.select,3.rdp;"
    parsed, rest = parse_guac_instruction(encoded + "4.size,4.1920;")
    assert parsed == ["select", "rdp"]
    assert rest == "4.size,4.1920;"

    token = create_encrypted_guacamole_json_token(
        secret_key_hex="00112233445566778899aabbccddeeff",
        username="operador_noc",
        tv_row={
            "slug": "tv03",
            "name": "TV 03",
            "local_port": 3393,
            "sec_mode": "rdp",
            "shadow_auth_enabled": False,
        },
    )
    assert isinstance(token, str) and len(token) > 64

