CREATE DATABASE IF NOT EXISTS airbnb_dashboard;
USE airbnb_dashboard;

-- Centralized calendar events from OTA feeds/manual sources.
-- Legacy columns (uid, start_date, end_date) are retained for backward compatibility.
CREATE TABLE IF NOT EXISTS calendar_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    property_id INT NOT NULL DEFAULT 1,
    platform VARCHAR(50) NOT NULL DEFAULT 'airbnb',
    uid VARCHAR(255) NOT NULL,
    external_event_id VARCHAR(255) NULL,
    listing_name VARCHAR(255) DEFAULT 'Listing',
    event_title VARCHAR(255),
    check_in DATE NULL,
    check_out DATE NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    booking_status VARCHAR(50) NOT NULL DEFAULT 'unknown',
    availability_status VARCHAR(50) NOT NULL DEFAULT 'unknown',
    sync_status VARCHAR(50) NOT NULL DEFAULT 'synced',
    last_synced_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    source_payload_hash VARCHAR(64) NULL,
    raw_summary VARCHAR(500) NULL,
    raw_status VARCHAR(100) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_platform_uid (platform, uid),
    UNIQUE KEY uniq_property_platform_external (property_id, platform, external_event_id),
    INDEX idx_calendar_events_dates (property_id, check_in, check_out),
    INDEX idx_calendar_events_platform (platform, availability_status, booking_status)
);

CREATE TABLE IF NOT EXISTS calendar_syncs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    property_id INT NOT NULL DEFAULT 1,
    platform VARCHAR(50) NOT NULL DEFAULT 'airbnb',
    sync_status VARCHAR(50) NOT NULL,
    message TEXT,
    events_found INT NOT NULL DEFAULT 0,
    events_imported INT NOT NULL DEFAULT 0,
    events_updated INT NOT NULL DEFAULT 0,
    events_removed INT NOT NULL DEFAULT 0,
    unavailable_dates INT NOT NULL DEFAULT 0,
    error_message TEXT NULL,
    started_at TIMESTAMP NULL,
    finished_at TIMESTAMP NULL,
    synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_calendar_syncs_platform_time (platform, synced_at)
);
