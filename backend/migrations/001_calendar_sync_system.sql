-- Calendar sync system upgrade (idempotent where possible).
-- Preserves existing data. Run against the configured database.

USE airbnb_dashboard;

-- calendar_events: extend for multi-OTA sync, classification, and conflict detection.
ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS property_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD COLUMN IF NOT EXISTS external_event_id VARCHAR(255) NULL AFTER uid,
  ADD COLUMN IF NOT EXISTS check_in DATE NULL AFTER event_title,
  ADD COLUMN IF NOT EXISTS check_out DATE NULL AFTER check_in,
  ADD COLUMN IF NOT EXISTS booking_status VARCHAR(50) NOT NULL DEFAULT 'unknown' AFTER end_date,
  ADD COLUMN IF NOT EXISTS availability_status VARCHAR(50) NOT NULL DEFAULT 'unknown' AFTER booking_status,
  ADD COLUMN IF NOT EXISTS sync_status VARCHAR(50) NOT NULL DEFAULT 'synced' AFTER availability_status,
  ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP AFTER sync_status,
  ADD COLUMN IF NOT EXISTS source_payload_hash VARCHAR(64) NULL AFTER last_synced_at,
  ADD COLUMN IF NOT EXISTS raw_summary VARCHAR(500) NULL AFTER source_payload_hash,
  ADD COLUMN IF NOT EXISTS raw_status VARCHAR(100) NULL AFTER raw_summary;

-- Backfill new columns from legacy columns.
UPDATE calendar_events
SET external_event_id = uid
WHERE (external_event_id IS NULL OR external_event_id = '') AND uid IS NOT NULL;

UPDATE calendar_events
SET check_in = start_date
WHERE check_in IS NULL AND start_date IS NOT NULL;

UPDATE calendar_events
SET check_out = end_date
WHERE check_out IS NULL AND end_date IS NOT NULL;

UPDATE calendar_events
SET booking_status = CASE
  WHEN LOWER(COALESCE(platform,'')) = 'airbnb' THEN 'confirmed'
  ELSE 'unknown'
END
WHERE booking_status IS NULL OR booking_status = '' OR booking_status = 'unknown';

UPDATE calendar_events
SET availability_status = CASE
  WHEN LOWER(COALESCE(platform,'')) = 'airbnb' THEN 'unavailable'
  ELSE 'unknown'
END
WHERE availability_status IS NULL OR availability_status = '' OR availability_status = 'unknown';

UPDATE calendar_events
SET last_synced_at = COALESCE(last_synced_at, created_at, CURRENT_TIMESTAMP)
WHERE last_synced_at IS NULL;

-- Unique constraint for dedupe. Keep legacy unique(platform, uid) if present; add external_event_id constraint.
SET @idx_exists := (
  SELECT COUNT(1) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'calendar_events' AND index_name = 'uniq_property_platform_external'
);
SET @sql := IF(@idx_exists = 0,
  'ALTER TABLE calendar_events ADD UNIQUE KEY uniq_property_platform_external (property_id, platform, external_event_id)',
  'SELECT "uniq_property_platform_external exists"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(1) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'calendar_events' AND index_name = 'idx_calendar_events_dates'
);
SET @sql := IF(@idx_exists = 0,
  'ALTER TABLE calendar_events ADD INDEX idx_calendar_events_dates (property_id, check_in, check_out)',
  'SELECT "idx_calendar_events_dates exists"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(1) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'calendar_events' AND index_name = 'idx_calendar_events_platform'
);
SET @sql := IF(@idx_exists = 0,
  'ALTER TABLE calendar_events ADD INDEX idx_calendar_events_platform (platform, availability_status, booking_status)',
  'SELECT "idx_calendar_events_platform exists"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- calendar_syncs: extend for dashboard/status reporting.
ALTER TABLE calendar_syncs
  ADD COLUMN IF NOT EXISTS property_id INT NOT NULL DEFAULT 1 AFTER id,
  ADD COLUMN IF NOT EXISTS events_found INT NOT NULL DEFAULT 0 AFTER message,
  ADD COLUMN IF NOT EXISTS events_imported INT NOT NULL DEFAULT 0 AFTER events_found,
  ADD COLUMN IF NOT EXISTS events_updated INT NOT NULL DEFAULT 0 AFTER events_imported,
  ADD COLUMN IF NOT EXISTS events_removed INT NOT NULL DEFAULT 0 AFTER events_updated,
  ADD COLUMN IF NOT EXISTS unavailable_dates INT NOT NULL DEFAULT 0 AFTER events_removed,
  ADD COLUMN IF NOT EXISTS error_message TEXT NULL AFTER unavailable_dates,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMP NULL AFTER error_message,
  ADD COLUMN IF NOT EXISTS finished_at TIMESTAMP NULL AFTER started_at;

SET @idx_exists := (
  SELECT COUNT(1) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'calendar_syncs' AND index_name = 'idx_calendar_syncs_platform_time'
);
SET @sql := IF(@idx_exists = 0,
  'ALTER TABLE calendar_syncs ADD INDEX idx_calendar_syncs_platform_time (platform, synced_at)',
  'SELECT "idx_calendar_syncs_platform_time exists"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
