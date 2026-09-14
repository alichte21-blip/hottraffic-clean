CREATE TABLE IF NOT EXISTS hotspots (
 id TEXT PRIMARY KEY,
 lat REAL NOT NULL,
 lng REAL NOT NULL,
 category TEXT NOT NULL,
 people INTEGER NOT NULL DEFAULT 1,
 desired_time TEXT NOT NULL DEFAULT '',
 note TEXT NOT NULL DEFAULT '',
 destination TEXT NOT NULL DEFAULT '',
 time_window INTEGER NOT NULL DEFAULT 30,
 service_preference TEXT NOT NULL DEFAULT 'taxi',
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_hotspots_active ON hotspots(status,expires_at);

CREATE TABLE IF NOT EXISTS vehicles (
 id TEXT PRIMARY KEY,
 lat REAL NOT NULL,
 lng REAL NOT NULL,
 last_seen INTEGER NOT NULL,
 providers TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_vehicles_seen ON vehicles(last_seen);

CREATE TABLE IF NOT EXISTS demand_events (
 id TEXT PRIMARY KEY,
 hotspot_id TEXT,
 service_preference TEXT NOT NULL DEFAULT 'taxi',
 people INTEGER NOT NULL DEFAULT 1,
 category TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ride_outcomes (
 id TEXT PRIMARY KEY,
 hotspot_id TEXT,
 service_preference TEXT NOT NULL DEFAULT 'taxi',
 outcome TEXT NOT NULL DEFAULT 'unknown',
 created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_activity (
 day TEXT NOT NULL,
 role TEXT NOT NULL,
 client_id TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(day,role,client_id)
);
