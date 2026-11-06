import argparse
import getpass
import sys

from app.db import db_session, run_migrations
from app.schemas import FORBIDDEN_UNIX_USERS
from app.security import hash_password, iso_utc, record_audit_log
from app.services.system_inspector import inspect_tv_runtime


def cmd_migrate() -> int:
    applied = run_migrations()
    if applied:
        print(f"Migrações aplicadas com sucesso: {', '.join(applied)}")
    else:
        print("Banco de dados já está atualizado.")
    return 0


def cmd_create_admin(username: str, password_stdin: bool = False) -> int:
    run_migrations()
    cleaned_user = username.strip()
    if len(cleaned_user) < 3:
        print("Erro: O nome de usuário deve ter pelo menos 3 caracteres.", file=sys.stderr)
        return 1
    if cleaned_user.lower() == "root":
        print(
            "Erro: Por política de segurança, não reutilize a conta 'root' como administrador do painel.",
            file=sys.stderr,
        )
        return 1

    if password_stdin:
        password = sys.stdin.readline().rstrip("\r\n")
    else:
        password = getpass.getpass(f"Digite a senha para o administrador '{cleaned_user}' (mín. 10 caracteres): ")
        confirm = getpass.getpass("Confirme a senha: ")
        if password != confirm:
            print("Erro: As senhas não coincidem.", file=sys.stderr)
            return 1

    try:
        pw_hash = hash_password(password)
    except ValueError as exc:
        print(f"Erro: {exc}", file=sys.stderr)
        return 1

    with db_session() as conn:
        existing = conn.execute(
            "SELECT id FROM admins WHERE username = ?", (cleaned_user,)
        ).fetchone()
        if existing:
            conn.execute(
                """
                UPDATE admins
                SET password_hash = ?, is_active = 1, failed_attempts = 0, locked_until = NULL
                WHERE username = ?
                """,
                (pw_hash, cleaned_user),
            )
            action_name = "admin.reset_password"
            print(f"Senha do administrador '{cleaned_user}' atualizada e conta desbloqueada.")
        else:
            conn.execute(
                """
                INSERT INTO admins (username, password_hash, is_active, created_at)
                VALUES (?, ?, 1, ?)
                """,
                (cleaned_user, pw_hash, iso_utc()),
            )
            action_name = "admin.create"
            print(f"Administrador '{cleaned_user}' criado com sucesso.")

        record_audit_log(
            conn,
            actor_username="cli-local",
            ip_address="127.0.0.1",
            action=action_name,
            target_type="admin",
            target_id=cleaned_user,
            outcome="success",
            details={"forbidden_unix_check": cleaned_user not in FORBIDDEN_UNIX_USERS},
        )
    return 0


def cmd_diagnose() -> int:
    run_migrations()
    print("=== Diagnóstico de Inventário e Sessões Shadow ===")
    with db_session() as conn:
        rows = conn.execute("SELECT * FROM tvs ORDER BY local_port ASC").fetchall()
        for r in rows:
            tv_dict = dict(r)
            rt = inspect_tv_runtime(tv_dict)
            print(
                f"- [{tv_dict['slug']}] {tv_dict['name']} | user={tv_dict['unix_user']} "
                f"| bind=127.0.0.1:{tv_dict['local_port']} | geral={rt.overall_status} "
                f"| XFCE={rt.xfce_session_state} ({rt.detected_display or 'N/A'}) "
                f"| Shadow={rt.shadow_service_state} ({rt.systemd_unit}={rt.systemd_active_state}) "
                f"| Espectador={rt.viewer_connection_state} ({rt.active_viewers_count})"
            )
            print(f"  Mensagem: {rt.user_message}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="CLI de Administração do Painel Web TV Shadow RDP"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("migrate", help="Aplica migrações SQLite pendentes")

    p_admin = sub.add_parser(
        "create-admin", help="Cria ou redefine senha de um usuário administrador do painel"
    )
    p_admin.add_argument("--username", required=True, help="Nome de usuário administrador (não usar 'root')")
    p_admin.add_argument(
        "--password-stdin",
        action="store_true",
        help="Lê a senha da entrada padrão (útil para automação segura sem expor na linha de comando)",
    )

    sub.add_parser("diagnose", help="Exibe diagnóstico das TVs e estado atual das sessões")

    args = parser.parse_args()
    if args.command == "migrate":
        return cmd_migrate()
    if args.command == "create-admin":
        return cmd_create_admin(args.username, args.password_stdin)
    if args.command == "diagnose":
        return cmd_diagnose()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

