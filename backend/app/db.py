import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from app.config import get_settings


def get_connection(db_path: Path | None = None) -> sqlite3.Connection:
    settings = get_settings()
    target_path = db_path or settings.db_path
    target_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(target_path), timeout=10.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    return conn


@contextmanager
def db_session(db_path: Path | None = None) -> Iterator[sqlite3.Connection]:
    conn = get_connection(db_path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def run_migrations(db_path: Path | None = None) -> list[str]:
    settings = get_settings()
    migrations_dir = settings.migrations_dir
    applied_now: list[str] = []

    with db_session(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            );
            """
        )
        rows = conn.execute("SELECT version FROM schema_migrations").fetchall()
        applied_versions = {int(r["version"]) for r in rows}

        sql_files = sorted(migrations_dir.glob("*.sql"))
        for sql_file in sql_files:
            prefix = sql_file.stem.split("_", 1)[0]
            version = int(prefix)
            if version in applied_versions:
                continue
            script = sql_file.read_text(encoding="utf-8")
            conn.executescript(script)
            conn.execute("PRAGMA foreign_keys = ON;")
            conn.execute(
                "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
                (version, sql_file.name),
            )
            applied_now.append(sql_file.name)

    return applied_now
