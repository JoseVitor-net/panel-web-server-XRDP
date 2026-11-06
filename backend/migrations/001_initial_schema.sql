-- Migração 001: Esquema inicial do painel de administração de TVs (Debian 13 XRDP/XFCE Shadow)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_login_at TEXT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL,
    csrf_token TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    expires_at TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_admin_id ON sessions(admin_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS tvs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    unix_user TEXT NOT NULL UNIQUE,
    local_port INTEGER NOT NULL UNIQUE,
    bind_address TEXT NOT NULL DEFAULT '127.0.0.1',
    display_number INTEGER NULL,
    gfx_enabled INTEGER NOT NULL DEFAULT 1,
    server_side_cursor INTEGER NOT NULL DEFAULT 1,
    sec_mode TEXT NOT NULL DEFAULT 'rdp' CHECK (sec_mode IN ('rdp', 'tls', 'nla')),
    shadow_auth_enabled INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    CHECK (bind_address = '127.0.0.1'),
    CHECK (local_port >= 3391 AND local_port <= 3499 AND local_port != 3389)
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    actor_username TEXT NULL,
    ip_address TEXT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied', 'error')),
    details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);

-- Inventário inicial proposto: tv01 (3391), tv02 (3392), tv03 (3393)
INSERT OR IGNORE INTO tvs (
    slug, name, location, unix_user, local_port, bind_address,
    display_number, gfx_enabled, server_side_cursor, sec_mode,
    shadow_auth_enabled, enabled, notes
) VALUES
    ('tv01', 'TV 01 - Recepção / Painel A', 'Recepção', 'tv01', 3391, '127.0.0.1', NULL, 1, 1, 'rdp', 0, 1, 'Perfil inicial proposto para usuário tv01 na porta local 3391'),
    ('tv02', 'TV 02 - Operações / Painel B', 'Sala de Operações', 'tv02', 3392, '127.0.0.1', NULL, 1, 1, 'rdp', 0, 1, 'Perfil inicial proposto para usuário tv02 na porta local 3392'),
    ('tv03', 'TV 03 - Monitoramento / Painel C', 'NOC / Monitoramento', 'tv03', 3393, '127.0.0.1', NULL, 1, 1, 'rdp', 0, 1, 'Perfil validado com -gfx +server-side-cursor na porta local 3393');
