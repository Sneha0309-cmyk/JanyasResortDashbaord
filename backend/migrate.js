// Safe, idempotent database migration for calendar sync system.
// Preserves existing data and backs up DB before DDL changes.

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { execFileSync } = require("child_process");
const pool = require("./db");

const DEFAULT_MYSQLDUMP_PATH = "D:\\xampp\\mysql\\bin\\mysqldump.exe";

async function columnExists(connection, tableName, columnName) {
  const [rows] = await connection.execute(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function indexExists(connection, tableName, indexName) {
  const [rows] = await connection.execute(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [tableName, indexName]
  );
  return rows.length > 0;
}

function backupDatabase() {
  const database = process.env.DB_NAME || "airbnb_dashboard";
  const user = process.env.DB_USER || "root";
  const password = process.env.DB_PASSWORD || "";
  const host = process.env.DB_HOST || "localhost";
  const mysqldumpPath = process.env.MYSQLDUMP_PATH || DEFAULT_MYSQLDUMP_PATH;

  if (!fs.existsSync(mysqldumpPath)) {
    console.warn(`mysqldump not found at "${mysqldumpPath}". Skipping DB backup; set MYSQLDUMP_PATH to enable.`);
    return null;
  }

  const backupDir = path.join(__dirname, "..", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const backupFile = path.join(backupDir, `${database}_before_migration_${stamp}.sql`);
  const args = [`-h${host}`, `-u${user}`];
  if (password) args.push(`-p${password}`);
  args.push("--single-transaction", "--skip-lock-tables", "--routines", "--events", database);

  console.log("Backing up database to:", backupFile);
  const dump = execFileSync(mysqldumpPath, args, { maxBuffer: 1024 * 1024 * 512 });
  fs.writeFileSync(backupFile, dump);
  if (!fs.statSync(backupFile).size) throw new Error("Database backup is empty. Migration aborted.");
  console.log("Backup completed:", backupFile);
  return backupFile;
}

async function addColumnIfMissing(connection, table, column, definition) {
  if (await columnExists(connection, table, column)) return false;
  console.log(`Adding ${table}.${column}...`);
  await connection.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

async function addIndexIfMissing(connection, table, indexName, definition) {
  if (await indexExists(connection, table, indexName)) return false;
  console.log(`Adding index ${table}.${indexName}...`);
  await connection.execute(`ALTER TABLE ${table} ADD ${definition}`);
  return true;
}

async function migrate() {
  const connection = await pool.getConnection();
  let changed = false;
  try {
    // Detect whether migration is needed before backup.
    const checks = await Promise.all([
      columnExists(connection, "calendar_events", "platform"),
      columnExists(connection, "calendar_events", "property_id"),
      columnExists(connection, "calendar_events", "external_event_id"),
      columnExists(connection, "calendar_events", "check_in"),
      columnExists(connection, "calendar_events", "check_out"),
      columnExists(connection, "calendar_events", "booking_status"),
      columnExists(connection, "calendar_events", "availability_status"),
      columnExists(connection, "calendar_events", "sync_status"),
      columnExists(connection, "calendar_events", "last_synced_at"),
      columnExists(connection, "calendar_syncs", "platform"),
      columnExists(connection, "calendar_syncs", "events_found"),
      indexExists(connection, "calendar_events", "unique_platform_uid"),
      indexExists(connection, "calendar_events", "uniq_property_platform_external"),
    ]);
    const needsMigration = checks.some(v => !v);

    if (!needsMigration) {
      console.log("Database schema is already up to date. Nothing to do.");
      return { changed: false };
    }

    try { backupDatabase(); } catch (e) { console.warn("Backup warning:", e.message); }

    // Legacy -> multi-platform base columns
    changed = await addColumnIfMissing(connection, "calendar_events", "platform", "VARCHAR(50) NOT NULL DEFAULT 'airbnb' AFTER id") || changed;
    changed = await addColumnIfMissing(connection, "calendar_syncs", "platform", "VARCHAR(50) NOT NULL DEFAULT 'airbnb' AFTER id") || changed;

    if (await indexExists(connection, "calendar_events", "uid") && !(await indexExists(connection, "calendar_events", "unique_platform_uid"))) {
      console.log("Removing old unique(uid) index...");
      await connection.execute("ALTER TABLE calendar_events DROP INDEX uid");
      changed = true;
    }
    changed = await addIndexIfMissing(connection, "calendar_events", "unique_platform_uid", "UNIQUE KEY unique_platform_uid (platform, uid)") || changed;

    // New sync system columns
    changed = await addColumnIfMissing(connection, "calendar_events", "property_id", "INT NOT NULL DEFAULT 1 AFTER id") || changed;
    changed = await addColumnIfMissing(connection, "calendar_events", "external_event_id", "VARCHAR(255) NULL AFTER uid") || changed;
    changed = await addColumnIfMissing(connection, "calendar_events", "check_in", "DATE NULL AFTER event_title") || changed;
    changed = await addColumnIfMissing(connection, "calendar_events", "check_out", "DATE NULL AFTER check_in") || changed;
    changed = await addColumnIfMissing(connection, "calendar_events", "booking_status", "VARCHAR(50) NOT NULL DEFAULT 'unknown' AFTER end_date") || changed;
    changed = await addColumnIfMissing(connection, "calendar_events", "availability_status", "VARCHAR(50) NOT NULL DEFAULT 'unknown' AFTER booking_status") || changed;
    changed = await addColumnIfMissing(connection, "calendar_events", "sync_status", "VARCHAR(50) NOT NULL DEFAULT 'synced' AFTER availability_status") || changed;
    changed = await addColumnIfMissing(connection, "calendar_events", "last_synced_at", "TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP AFTER sync_status") || changed;
    changed = await addColumnIfMissing(connection, "calendar_events", "source_payload_hash", "VARCHAR(64) NULL AFTER last_synced_at") || changed;
    changed = await addColumnIfMissing(connection, "calendar_events", "raw_summary", "VARCHAR(500) NULL AFTER source_payload_hash") || changed;
    changed = await addColumnIfMissing(connection, "calendar_events", "raw_status", "VARCHAR(100) NULL AFTER raw_summary") || changed;

    changed = await addColumnIfMissing(connection, "calendar_syncs", "property_id", "INT NOT NULL DEFAULT 1 AFTER id") || changed;
    changed = await addColumnIfMissing(connection, "calendar_syncs", "events_found", "INT NOT NULL DEFAULT 0 AFTER message") || changed;
    changed = await addColumnIfMissing(connection, "calendar_syncs", "events_imported", "INT NOT NULL DEFAULT 0 AFTER events_found") || changed;
    changed = await addColumnIfMissing(connection, "calendar_syncs", "events_updated", "INT NOT NULL DEFAULT 0 AFTER events_imported") || changed;
    changed = await addColumnIfMissing(connection, "calendar_syncs", "events_removed", "INT NOT NULL DEFAULT 0 AFTER events_updated") || changed;
    changed = await addColumnIfMissing(connection, "calendar_syncs", "unavailable_dates", "INT NOT NULL DEFAULT 0 AFTER events_removed") || changed;
    changed = await addColumnIfMissing(connection, "calendar_syncs", "error_message", "TEXT NULL AFTER unavailable_dates") || changed;
    changed = await addColumnIfMissing(connection, "calendar_syncs", "started_at", "TIMESTAMP NULL AFTER error_message") || changed;
    changed = await addColumnIfMissing(connection, "calendar_syncs", "finished_at", "TIMESTAMP NULL AFTER started_at") || changed;

    // Backfill legacy data - never destructive.
    await connection.execute(`UPDATE calendar_events SET external_event_id = uid WHERE (external_event_id IS NULL OR external_event_id = '') AND uid IS NOT NULL`);
    await connection.execute(`UPDATE calendar_events SET check_in = start_date WHERE check_in IS NULL AND start_date IS NOT NULL`);
    await connection.execute(`UPDATE calendar_events SET check_out = end_date WHERE check_out IS NULL AND end_date IS NOT NULL`);
    await connection.execute(`UPDATE calendar_events SET last_synced_at = COALESCE(last_synced_at, created_at, CURRENT_TIMESTAMP) WHERE last_synced_at IS NULL`);
    await connection.execute(`
      UPDATE calendar_events
      SET booking_status = CASE WHEN LOWER(COALESCE(platform,''))='airbnb' THEN 'confirmed' ELSE 'unknown' END
      WHERE booking_status IS NULL OR booking_status = '' OR booking_status = 'unknown'
    `);
    await connection.execute(`
      UPDATE calendar_events
      SET availability_status = CASE WHEN LOWER(COALESCE(platform,''))='airbnb' THEN 'unavailable' ELSE 'unknown' END
      WHERE availability_status IS NULL OR availability_status = '' OR availability_status = 'unknown'
    `);
    await connection.execute(`UPDATE calendar_events SET platform = 'airbnb' WHERE platform IS NULL OR platform = ''`);

    changed = await addIndexIfMissing(connection, "calendar_events", "uniq_property_platform_external", "UNIQUE KEY uniq_property_platform_external (property_id, platform, external_event_id)") || changed;
    changed = await addIndexIfMissing(connection, "calendar_events", "idx_calendar_events_dates", "INDEX idx_calendar_events_dates (property_id, check_in, check_out)") || changed;
    changed = await addIndexIfMissing(connection, "calendar_events", "idx_calendar_events_platform", "INDEX idx_calendar_events_platform (platform, availability_status, booking_status)") || changed;
    changed = await addIndexIfMissing(connection, "calendar_syncs", "idx_calendar_syncs_platform_time", "INDEX idx_calendar_syncs_platform_time (platform, synced_at)") || changed;

    console.log("Migration completed.", { changed });
    return { changed: true };
  } finally {
    connection.release();
  }
}

if (require.main === module) {
  migrate()
    .then(async () => { await pool.end(); process.exit(0); })
    .catch(async (error) => {
      console.error("Migration failed:", error.message);
      try { await pool.end(); } catch (_) {}
      process.exit(1);
    });
}

module.exports = migrate;
