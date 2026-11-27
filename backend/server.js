const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const ical = require("node-ical");
const pool = require("./db");
const migrate = require("./migrate");
const {
  toMySQLDate,
  toDateKey,
  buildUnavailableDates,
  normalizePlatform,
  platformDisplayName,
  classifyCalendarEvent,
  eventExternalId,
  safeText,
  hashPayload
} = require("./calendar-utils");
const {
  authRouter,
  requireAuthPage,
  redirectIfAuthed,
  requireAuthApi,
  serveLoginPage,
  serveDashboardPage
} = require("./auth");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SYNC_INTERVAL = 5 * 60 * 1000;
const DEFAULT_PROPERTY_ID = 1;

const PLATFORMS = {
  airbnb: {
    key: "airbnb",
    name: "Airbnb",
    envUrl: "AIRBNB_ICAL_URL",
    envPlaceholder: "PASTE_YOUR_AIRBNB",
    listingName: "Airbnb Listing",
    // Airbnb export iCal reflects reservations/blocked dates from an official source.
    sourceVerified: true
  },
  ingoibibo: {
    key: "ingoibibo",
    name: "Goibibo / MakeMyTrip",
    envUrl: "INGOIBIBO_ICAL_URL",
    envPlaceholder: "PASTE_THE_ABOVE",
    listingName: "Goibibo / MakeMyTrip",
    // Feed is official/authorized export URL configured by user, but event semantics can be opaque.
    // We classify per-event and never treat opaque events as confirmed bookings.
    sourceVerified: false
  }
};

let syncLocks = { airbnb: false, ingoibibo: false };
let nextSyncTimer = null;
let nextSyncAt = null;
let calendarWriteQueue = Promise.resolve();
let migrationPromise = null;

function acquireCalendarWriteLock() {
  const waitForPrevious = calendarWriteQueue;
  let release;
  calendarWriteQueue = new Promise(resolve => { release = resolve; });
  return waitForPrevious.then(() => release);
}

async function ensureMigrated() {
  if (!migrationPromise) {
    migrationPromise = migrate().catch(err => {
      migrationPromise = null;
      throw err;
    });
  }
  return migrationPromise;
}

function redactSensitive(message, calendarUrl = "") {
  let safeMessage = String(message || "Unknown error");
  if (calendarUrl) safeMessage = safeMessage.split(calendarUrl).join("[hidden iCal URL]");
  safeMessage = safeMessage.replace(/(?:https?|webcal):\/\/[^\s"'<>]+/gi, "[hidden URL]");
  return safeMessage.slice(0, 2000);
}

function getPlatformConfig(platform) {
  const key = normalizePlatform(platform);
  return PLATFORMS[key] || null;
}

function validateCalendar(rawCalendar, platformName) {
  if (!rawCalendar || !rawCalendar.trim()) {
    const err = new Error(`${platformName} returned an empty feed.`);
    err.code = "EMPTY_FEED";
    throw err;
  }
  const hasStart = rawCalendar.includes("BEGIN:VCALENDAR");
  const hasEnd = rawCalendar.includes("END:VCALENDAR");
  if (!hasStart || !hasEnd) {
    const err = new Error(`Invalid ${platformName} iCal feed.`);
    err.code = "INVALID_ICAL";
    throw err;
  }
  const hasEvents = rawCalendar.includes("BEGIN:VEVENT");
  return { hasEvents };
}

async function downloadCalendar(platformKey) {
  const config = getPlatformConfig(platformKey);
  if (!config) throw new Error(`Unsupported platform: ${platformKey}`);
  const calendarUrl = process.env[config.envUrl] || "";
  if (!calendarUrl || (config.envPlaceholder && calendarUrl.includes(config.envPlaceholder))) {
    const err = new Error(`${config.name} iCal URL missing in .env (${config.envUrl}).`);
    err.code = "MISSING_URL";
    throw err;
  }

  console.log(`Downloading ${config.name} calendar...`);
  const response = await fetch(calendarUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 CalendarSync/1.0",
      "Accept": "text/calendar, text/plain, */*"
    },
    signal: AbortSignal.timeout(30000)
  });

  console.log(`${config.name} feed HTTP status:`, response.status);
  if (!response.ok) {
    const err = new Error(`${config.name} feed failed. HTTP ${response.status}`);
    err.code = "HTTP_ERROR";
    err.status = response.status;
    throw err;
  }

  const rawCalendar = await response.text();
  const validation = validateCalendar(rawCalendar, config.name);
  const parsedEvents = ical.sync.parseICS(rawCalendar);
  if (!parsedEvents || typeof parsedEvents !== "object") {
    const err = new Error(`Could not parse ${config.name} calendar.`);
    err.code = "PARSE_ERROR";
    throw err;
  }

  const vevents = Object.values(parsedEvents).filter(e => e && e.type === "VEVENT");
  console.log(`${config.name} VEVENT entries:`, vevents.length);
  if (vevents.length > 0) {
    console.log(`${config.name} sample event:`, {
      summary: vevents[0].summary || null,
      status: vevents[0].status || null,
      transparency: vevents[0].transparency || vevents[0].transp || null,
      start: vevents[0].start || null,
      end: vevents[0].end || null
    });
  }

  return { calendarUrl, rawCalendar, parsedEvents, vevents, hasEvents: validation.hasEvents };
}

function normalizeEvent(item, platformKey) {
  const config = getPlatformConfig(platformKey);
  const platform = normalizePlatform(platformKey);
  const externalId = eventExternalId(item);
  const startDate = toMySQLDate(item.start);
  const endDate = toMySQLDate(item.end);
  if (!startDate || !endDate || endDate <= startDate) return null;

  const classification = classifyCalendarEvent(item, {
    platform,
    sourceVerified: Boolean(config && config.sourceVerified)
  });

  const summary = safeText(item.summary, 500);
  const status = safeText(item.status, 100);
  const transp = safeText(item.transparency || item.transp, 100);
  const payloadHash = hashPayload(JSON.stringify({
    platform, externalId, startDate, endDate, summary, status, transp,
    description: safeText(item.description, 500)
  }));

  return {
    propertyId: DEFAULT_PROPERTY_ID,
    platform,
    externalEventId: externalId,
    uid: externalId, // legacy column
    listingName: (config && config.listingName) || platformDisplayName(platform),
    eventTitle: summary || `${platformDisplayName(platform)} event`,
    checkIn: startDate,
    checkOut: endDate,
    startDate, // legacy
    endDate,   // legacy
    bookingStatus: classification.bookingStatus,
    availabilityStatus: classification.availabilityStatus,
    syncStatus: "synced",
    lastSyncedAt: new Date(),
    sourcePayloadHash: payloadHash,
    rawSummary: summary,
    rawStatus: status,
    classificationReason: classification.reason,
    confidence: classification.confidence,
    verified: classification.verified
  };
}

async function logSync({
  platform, syncStatus, message, eventsFound = 0, eventsImported = 0,
  eventsUpdated = 0, eventsRemoved = 0, unavailableDates = 0, errorMessage = null,
  startedAt = null, finishedAt = null
}) {
  try {
    await pool.execute(
      `INSERT INTO calendar_syncs
        (property_id, platform, sync_status, message, events_found, events_imported, events_updated, events_removed, unavailable_dates, error_message, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [DEFAULT_PROPERTY_ID, platform, syncStatus, String(message || "").slice(0, 2000), eventsFound, eventsImported, eventsUpdated, eventsRemoved, unavailableDates, errorMessage, startedAt, finishedAt]
    );
  } catch (err) {
    console.error("Sync log error:", err.message);
  }
}

async function getExistingEventMap(connection, platform) {
  const [rows] = await connection.execute(
    `SELECT id, external_event_id, uid, source_payload_hash FROM calendar_events WHERE property_id = ? AND platform = ?`,
    [DEFAULT_PROPERTY_ID, platform]
  );
  const map = new Map();
  for (const row of rows) {
    const key = String(row.external_event_id || row.uid || "").trim();
    if (key) map.set(key, row);
  }
  return map;
}

async function savePlatformEvents({ platform, events, hasEvents, rawCalendar }) {
  const config = getPlatformConfig(platform);
  const platformKey = normalizePlatform(platform);
  const startedAt = new Date();
  let connection;
  let transactionStarted = false;
  let releaseLock = null;

  try {
    // Valid feed with zero VEVENTs: preserve existing records, do not fail destructively.
    if (!hasEvents || events.length === 0) {
      const message = `${config.name} feed returned HTTP 200 with no VEVENT entries. Existing records preserved.`;
      console.warn(message);
      await logSync({ platform: platformKey, syncStatus: "success_empty", message, eventsFound: 0, startedAt, finishedAt: new Date() });
      return { success: true, message, eventsProcessed: 0, oldEventsRemoved: 0, preserved: true, emptyFeed: true };
    }

    const deduped = new Map();
    let skippedInvalid = 0;
    for (const item of events) {
      if (!item || !item.uid && !item.start && !item.end) continue;
      if (!item.start || !item.end) { skippedInvalid++; continue; }
      const normalized = normalizeEvent(item, platformKey);
      if (!normalized) { skippedInvalid++; continue; }
      deduped.set(normalized.externalEventId, normalized);
    }

    const validEvents = [...deduped.values()];
    console.log(`${config.name} valid events: ${validEvents.length}, skipped invalid: ${skippedInvalid}`);

    if (validEvents.length === 0) {
      const message = `No valid ${config.name} events after parsing. Existing records preserved.`;
      console.warn(message);
      await logSync({ platform: platformKey, syncStatus: "success_empty", message, eventsFound: events.length, startedAt, finishedAt: new Date(), errorMessage: `Skipped invalid: ${skippedInvalid}` });
      return { success: true, message, eventsProcessed: 0, oldEventsRemoved: 0, preserved: true, emptyFeed: true };
    }

    releaseLock = await acquireCalendarWriteLock();
    connection = await pool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const existingMap = await getExistingEventMap(connection, platformKey);
    let imported = 0;
    let updated = 0;

    for (const ev of validEvents) {
      const existing = existingMap.get(ev.externalEventId);
      await connection.execute(
        `INSERT INTO calendar_events
          (property_id, platform, uid, external_event_id, listing_name, event_title, check_in, check_out, start_date, end_date,
           booking_status, availability_status, sync_status, last_synced_at, source_payload_hash, raw_summary, raw_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           property_id = VALUES(property_id),
           uid = VALUES(uid),
           external_event_id = VALUES(external_event_id),
           listing_name = VALUES(listing_name),
           event_title = VALUES(event_title),
           check_in = VALUES(check_in),
           check_out = VALUES(check_out),
           start_date = VALUES(start_date),
           end_date = VALUES(end_date),
           booking_status = VALUES(booking_status),
           availability_status = VALUES(availability_status),
           sync_status = VALUES(sync_status),
           last_synced_at = VALUES(last_synced_at),
           source_payload_hash = VALUES(source_payload_hash),
           raw_summary = VALUES(raw_summary),
           raw_status = VALUES(raw_status)`,
        [
          ev.propertyId, ev.platform, ev.uid, ev.externalEventId, ev.listingName, ev.eventTitle,
          ev.checkIn, ev.checkOut, ev.startDate, ev.endDate, ev.bookingStatus, ev.availabilityStatus,
          ev.syncStatus, ev.lastSyncedAt, ev.sourcePayloadHash, ev.rawSummary, ev.rawStatus
        ]
      );
      if (existing) updated++; else imported++;
    }

    const currentIds = validEvents.map(e => e.externalEventId);
    const placeholders = currentIds.map(() => "?").join(",");
    const [deleteResult] = await connection.execute(
      `DELETE FROM calendar_events
        WHERE property_id = ? AND platform = ? AND COALESCE(external_event_id, uid) NOT IN (${placeholders})`,
      [DEFAULT_PROPERTY_ID, platformKey, ...currentIds]
    );

    await connection.commit();
    transactionStarted = false;

    const unavailableDates = new Set();
    for (const ev of validEvents) {
      if (ev.availabilityStatus === "unavailable") {
        for (const d of buildUnavailableDates(ev.checkIn, ev.checkOut)) unavailableDates.add(d);
      }
    }

    const message = `${config.name} sync completed. ${validEvents.length} events processed (${imported} imported, ${updated} updated), ${deleteResult.affectedRows} stale events removed.`;
    console.log(message);
    await logSync({
      platform: platformKey, syncStatus: "success", message,
      eventsFound: events.length, eventsImported: imported, eventsUpdated: updated,
      eventsRemoved: deleteResult.affectedRows, unavailableDates: unavailableDates.size,
      startedAt, finishedAt: new Date()
    });

    return {
      success: true, message,
      eventsProcessed: validEvents.length,
      eventsImported: imported,
      eventsUpdated: updated,
      oldEventsRemoved: deleteResult.affectedRows,
      unavailableDates: unavailableDates.size
    };
  } catch (error) {
    if (connection && transactionStarted) {
      try { await connection.rollback(); } catch (rbErr) { console.error("Rollback error:", rbErr.message); }
    }
    throw error;
  } finally {
    if (connection) connection.release();
    if (releaseLock) releaseLock();
  }
}

async function syncPlatform(platformKey) {
  const config = getPlatformConfig(platformKey);
  if (!config) return { success: false, message: `Unsupported platform: ${platformKey}` };
  if (syncLocks[platformKey]) {
    return { success: false, message: `${config.name} sync already running.` };
  }

  syncLocks[platformKey] = true;
  const startedAt = new Date();
  let calendarUrl = "";
  try {
    await ensureMigrated();
    const download = await downloadCalendar(platformKey);
    calendarUrl = download.calendarUrl;
    const result = await savePlatformEvents({
      platform: platformKey,
      events: download.vevents,
      hasEvents: download.hasEvents,
      rawCalendar: download.rawCalendar
    });
    return { ...result, platform: platformKey, platformName: config.name };
  } catch (error) {
    const safeMessage = redactSensitive(error.message, calendarUrl);
    console.error(`${config.name} sync error:`, safeMessage);
    await logSync({
      platform: platformKey,
      syncStatus: "failed",
      message: `${config.name} sync failed. Existing records preserved.`,
      errorMessage: safeMessage,
      startedAt,
      finishedAt: new Date()
    });
    return { success: false, platform: platformKey, platformName: config.name, message: safeMessage, preserved: true };
  } finally {
    syncLocks[platformKey] = false;
  }
}

async function syncAllPlatforms() {
  const results = await Promise.allSettled([syncPlatform("airbnb"), syncPlatform("ingoibibo")]);
  return results.map((r, i) => {
    const platform = i === 0 ? "airbnb" : "ingoibibo";
    if (r.status === "fulfilled") return r.value;
    return { success: false, platform, message: redactSensitive(r.reason?.message || r.reason) };
  });
}

function scheduleNextSync() {
  if (nextSyncTimer) clearTimeout(nextSyncTimer);
  nextSyncAt = new Date(Date.now() + SYNC_INTERVAL);
  console.log("Next automatic sync:", nextSyncAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }));
  nextSyncTimer = setTimeout(async () => {
    console.log("5-minute automatic sync started.");
    try {
      await syncAllPlatforms();
    } catch (err) {
      console.error("Automatic sync error:", err.message);
    } finally {
      scheduleNextSync();
    }
  }, SYNC_INTERVAL);
  if (typeof nextSyncTimer.unref === "function") nextSyncTimer.unref();
}

function isCancelledBookingStatus(status) {
  const s = safeText(status, 50).toLowerCase();
  return s === "cancelled" || s === "canceled";
}

function isActiveUnavailableEvent(eventOrRow) {
  const bookingStatus = safeText(eventOrRow.booking_status || eventOrRow.bookingStatus || "unknown", 50).toLowerCase();
  const availabilityStatus = safeText(eventOrRow.availability_status || eventOrRow.availabilityStatus || "unknown", 50).toLowerCase();
  return availabilityStatus === "unavailable" && !isCancelledBookingStatus(bookingStatus);
}

function normalizeEventRow(row) {
  const platform = normalizePlatform(row.platform || "airbnb");
  const startDate = toDateKey(row.check_in || row.start_date);
  const endDate = toDateKey(row.check_out || row.end_date);
  const bookingStatus = safeText(row.booking_status || "unknown", 50) || "unknown";
  const availabilityStatus = safeText(row.availability_status || "unknown", 50) || "unknown";
  const cancelled = isCancelledBookingStatus(bookingStatus);
  const activeUnavailable = availabilityStatus === "unavailable" && !cancelled;
  const unavailableDates = activeUnavailable ? buildUnavailableDates(startDate, endDate) : [];

  // Backward-compatible status field for existing frontend.
  let legacyStatus = "DISPLAY ONLY";
  if (activeUnavailable) legacyStatus = "NOT AVAILABLE";
  else if (availabilityStatus === "available") legacyStatus = "AVAILABLE";

  const bookingId = row.external_event_id || row.uid || (row.id != null ? String(row.id) : "");

  return {
    id: row.id,
    booking_id: bookingId,
    property_id: row.property_id || DEFAULT_PROPERTY_ID,
    platform,
    platform_name: platformDisplayName(platform),
    external_event_id: row.external_event_id || row.uid,
    uid: row.uid,
    listing_name: row.listing_name,
    event_title: row.event_title,
    check_in: startDate,
    check_out: endDate,
    start_date: startDate, // legacy
    end_date: endDate,     // legacy
    booking_status: bookingStatus,
    availability_status: availabilityStatus,
    sync_status: row.sync_status || "synced",
    last_synced_at: row.last_synced_at,
    status: legacyStatus, // legacy
    is_cancelled: cancelled,
    active_booking: activeUnavailable,
    verified: bookingStatus === "confirmed" || (platform === "airbnb" && activeUnavailable),
    unavailable_dates: unavailableDates,
    raw_summary: row.raw_summary || null,
    raw_status: row.raw_status || null
  };
}

function detectConflicts(events) {
  // Conflict when active unavailable/blocked ranges overlap on same property across any sources.
  // Cancelled bookings are preserved in history but do not count as active blocks.
  const blocking = events.filter(e => isActiveUnavailableEvent(e));
  const conflicts = [];
  for (let i = 0; i < blocking.length; i++) {
    for (let j = i + 1; j < blocking.length; j++) {
      const a = blocking[i];
      const b = blocking[j];
      if ((a.property_id || 1) !== (b.property_id || 1)) continue;
      if (a.platform === b.platform && a.external_event_id === b.external_event_id) continue;
      // overlap for exclusive end: a.check_in < b.check_out && b.check_in < a.check_out
      if (a.check_in < b.check_out && b.check_in < a.check_out) {
        const overlapStart = a.check_in > b.check_in ? a.check_in : b.check_in;
        const overlapEnd = a.check_out < b.check_out ? a.check_out : b.check_out;
        conflicts.push({
          property_id: a.property_id || 1,
          overlap_start: overlapStart,
          overlap_end: overlapEnd,
          overlap_dates: buildUnavailableDates(overlapStart, overlapEnd),
          platforms: [a.platform, b.platform],
          events: [
            { id: a.id, platform: a.platform, platform_name: a.platform_name, external_event_id: a.external_event_id, check_in: a.check_in, check_out: a.check_out, booking_status: a.booking_status },
            { id: b.id, platform: b.platform, platform_name: b.platform_name, external_event_id: b.external_event_id, check_in: b.check_in, check_out: b.check_out, booking_status: b.booking_status }
          ]
        });
      }
    }
  }
  // Deduplicate conflict pairs by key
  const seen = new Set();
  return conflicts.filter(c => {
    const ids = c.events.map(e => `${e.platform}:${e.external_event_id}`).sort().join("|");
    const key = `${c.property_id}|${ids}|${c.overlap_start}|${c.overlap_end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function parseMonthFilter(query = {}) {
  const rawMonth = query.month;
  const rawYear = query.year;
  let year = null;
  let month = null;

  if (rawMonth !== undefined && rawMonth !== null && String(rawMonth).trim() !== "") {
    const m = String(rawMonth).trim();
    const ym = m.match(/^(\d{4})-(\d{1,2})$/);
    if (ym) {
      year = Number(ym[1]);
      month = Number(ym[2]);
    } else if (/^\d{1,2}$/.test(m)) {
      month = Number(m);
    } else {
      return { error: "Invalid month filter. Use month=1-12 or month=YYYY-MM." };
    }
  }

  if (rawYear !== undefined && rawYear !== null && String(rawYear).trim() !== "") {
    if (!/^\d{4}$/.test(String(rawYear).trim())) {
      return { error: "Invalid year filter. Use a 4-digit year." };
    }
    year = Number(String(rawYear).trim());
  }

  if (month === null && year === null) return { filter: null };
  if (month === null || year === null) {
    return { error: "Month and year are required together. Use month=YYYY-MM or month=&year=." };
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return { error: "Invalid month filter. Month must be between 1 and 12." };
  }
  if (!Number.isInteger(year) || year < 1970 || year > 2100) {
    return { error: "Invalid year filter." };
  }

  const monthStart = `${year}-${pad2(month)}-01`;
  const endYear = month === 12 ? year + 1 : year;
  const endMonth = month === 12 ? 1 : month + 1;
  const monthEndExclusive = `${endYear}-${pad2(endMonth)}-01`;
  return {
    filter: {
      month,
      year,
      monthStart,
      monthEndExclusive
    }
  };
}

async function getAllEvents(filters = {}) {
  await ensureMigrated();
  const where = [];
  const params = [];

  if (filters.monthStart && filters.monthEndExclusive) {
    // Overlap with selected month: event starts before month end and ends after month start.
    // Uses COALESCE for legacy start_date/end_date compatibility.
    where.push("COALESCE(check_in, start_date) < ?");
    params.push(filters.monthEndExclusive);
    where.push("COALESCE(check_out, end_date) > ?");
    params.push(filters.monthStart);
  }

  if (filters.platform) {
    where.push("platform = ?");
    params.push(normalizePlatform(filters.platform));
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows] = await pool.execute(
    `SELECT id, property_id, platform, uid, external_event_id, listing_name, event_title,
            check_in, check_out, start_date, end_date, booking_status, availability_status,
            sync_status, last_synced_at, raw_summary, raw_status
       FROM calendar_events
       ${whereSql}
      ORDER BY COALESCE(check_in, start_date) ASC, platform ASC, id ASC`,
    params
  );
  return rows.map(normalizeEventRow);
}

async function getSyncStatus() {
  await ensureMigrated();
  const platforms = ["airbnb", "ingoibibo"];
  const status = {};
  for (const p of platforms) {
    const [lastRows] = await pool.execute(
      `SELECT platform, sync_status, message, error_message, events_found, events_imported, events_updated, events_removed, unavailable_dates, synced_at, started_at, finished_at
         FROM calendar_syncs WHERE platform = ? ORDER BY id DESC LIMIT 1`,
      [p]
    );
    const [lastSuccessRows] = await pool.execute(
      `SELECT synced_at, message FROM calendar_syncs WHERE platform = ? AND sync_status IN ('success','success_empty') ORDER BY id DESC LIMIT 1`,
      [p]
    );
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN availability_status='unavailable' AND LOWER(COALESCE(booking_status,'')) NOT IN ('cancelled','canceled') THEN 1 ELSE 0 END) AS unavailable_events,
              SUM(CASE WHEN booking_status='confirmed' THEN 1 ELSE 0 END) AS confirmed_events
         FROM calendar_events WHERE platform = ?`,
      [p]
    );
    const [unavailableDateRows] = await pool.execute(
      `SELECT check_in, check_out, start_date, end_date, booking_status
         FROM calendar_events
        WHERE platform = ? AND availability_status='unavailable'`,
      [p]
    );
    const unavailableSet = new Set();
    for (const r of unavailableDateRows) {
      if (isCancelledBookingStatus(r.booking_status)) continue;
      for (const d of buildUnavailableDates(toDateKey(r.check_in || r.start_date), toDateKey(r.check_out || r.end_date))) unavailableSet.add(d);
    }
    const last = lastRows[0] || null;
    const lastSuccess = lastSuccessRows[0] || null;
    const counts = countRows[0] || {};
    status[p] = {
      platform: p,
      platform_name: platformDisplayName(p),
      connected: Boolean(lastSuccess),
      last_sync_status: last ? last.sync_status : "never",
      last_sync_message: last ? last.message : null,
      last_sync_error: last ? (last.error_message || (last.sync_status === 'failed' ? last.message : null)) : null,
      last_synced_at: last ? last.synced_at : null,
      last_successful_sync: lastSuccess ? lastSuccess.synced_at : null,
      total_events: Number(counts.total || 0),
      unavailable_events: Number(counts.unavailable_events || 0),
      confirmed_events: Number(counts.confirmed_events || 0),
      unavailable_dates_count: unavailableSet.size
    };
  }
  return status;
}

// --- Routes ---

// Block direct static access to dashboard HTML; serve only through auth.
app.get("/index.html", requireAuthPage, (req, res) => res.redirect("/"));
app.get("/", requireAuthPage, serveDashboardPage);

app.use(express.static(path.join(__dirname, "..", "public"), { index: false }));

app.get("/login", redirectIfAuthed, serveLoginPage);
app.get("/login.html", (req, res) => res.redirect("/login"));
app.use(authRouter);

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ success: true, message: "MySQL connected successfully!" });
  } catch (error) {
    res.status(500).json({ success: false, message: "MySQL connection failed." });
  }
});

app.use("/api", requireAuthApi);

app.post("/api/sync-calendar", async (req, res) => {
  const result = await syncPlatform("airbnb");
  res.status(result.success ? 200 : 500).json(result);
});

app.post("/api/sync-ingoibibo", async (req, res) => {
  const result = await syncPlatform("ingoibibo");
  res.status(result.success ? 200 : 500).json(result);
});

app.post("/api/sync-all", async (req, res) => {
  const results = await syncAllPlatforms();
  const success = results.every(r => r.success);
  res.status(success ? 200 : 207).json({ success, results });
});

app.get("/api/sync-status", async (req, res) => {
  try {
    const platformStatus = await getSyncStatus();
    const events = await getAllEvents();
    const conflicts = detectConflicts(events);
    const allUnavailableDates = new Set();
    for (const e of events) {
      if (e.availability_status === "unavailable") e.unavailable_dates.forEach(d => allUnavailableDates.add(d));
    }
    res.json({
      success: true,
      property_id: DEFAULT_PROPERTY_ID,
      sync_interval_ms: SYNC_INTERVAL,
      next_sync_at: nextSyncAt,
      platforms: platformStatus,
      totals: {
        events: events.length,
        unavailable_dates: allUnavailableDates.size,
        conflicts: conflicts.length
      }
    });
  } catch (error) {
    console.error("Sync status error:", error.message);
    res.status(500).json({ success: false, message: "Could not load sync status." });
  }
});

app.get("/api/conflicts", async (req, res) => {
  try {
    const events = await getAllEvents();
    const conflicts = detectConflicts(events);
    res.json({ success: true, count: conflicts.length, conflicts });
  } catch (error) {
    console.error("Conflicts error:", error.message);
    res.status(500).json({ success: false, message: "Could not load conflicts." });
  }
});

app.get("/api/events", async (req, res) => {
  try {
    const parsed = parseMonthFilter(req.query || {});
    if (parsed.error) {
      return res.status(400).json({ success: false, message: parsed.error });
    }

    const filter = parsed.filter;
    const events = await getAllEvents(filter || {});
    const conflicts = detectConflicts(events);
    const allUnavailableDates = new Set();
    let airbnbCount = 0;
    let ingoCount = 0;
    let confirmedCount = 0;
    let activeUnavailableCount = 0;

    for (const event of events) {
      if (event.platform === "airbnb") airbnbCount++;
      if (event.platform === "ingoibibo") ingoCount++;
      if (event.booking_status === "confirmed" && !event.is_cancelled) confirmedCount++;
      if (event.active_booking) {
        activeUnavailableCount++;
        event.unavailable_dates.forEach(d => allUnavailableDates.add(d));
      }
    }

    // Keep global sync/platform status for dashboard widgets.
    const platformStatus = await getSyncStatus();

    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      filter: filter
        ? { type: "month", month: filter.month, year: filter.year, month_start: filter.monthStart, month_end_exclusive: filter.monthEndExclusive }
        : null,
      count: events.length, // backward-compatible total count
      total_events: events.length,
      all_events: events.length,
      airbnb_events: airbnbCount,
      makemytrip_events: ingoCount,
      confirmed_bookings: confirmedCount,
      active_unavailable_events: activeUnavailableCount,
      unavailable_dates: [...allUnavailableDates].sort(),
      makemytrip_feed_status: platformStatus.ingoibibo?.last_sync_status || "unknown",
      makemytrip_note: "Goibibo/MMT events are classified per event. Opaque events are never treated as confirmed bookings.",
      conflicts,
      sync: {
        next_sync_at: nextSyncAt,
        platforms: platformStatus
      },
      events
    });
  } catch (error) {
    console.error("Events error:", error.message);
    res.status(500).json({ success: false, message: "Could not load calendar events." });
  }
});

// Backward-compatible export for tests/scripts
module.exports = {
  app,
  syncAirbnbCalendar: () => syncPlatform("airbnb"),
  syncInGoCalendar: () => syncPlatform("ingoibibo"),
  syncPlatform,
  syncAllPlatforms,
  detectConflicts,
  normalizeEventRow
};

if (require.main === module) {
  ensureMigrated()
    .catch(err => console.error("Startup migration warning:", err.message))
    .finally(() => {
      app.listen(PORT, async () => {
        console.log(`Server running at http://localhost:${PORT}`);
        console.log(`Automatic sync: every ${SYNC_INTERVAL / 60000} minutes`);
        try {
          await syncAllPlatforms();
        } catch (err) {
          console.error("Initial sync error:", err.message);
        }
        scheduleNextSync();
      });
    });
}
