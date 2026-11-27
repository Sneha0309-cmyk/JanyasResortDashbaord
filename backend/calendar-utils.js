// Shared calendar helpers for iCal parsing, normalization, and safe classification.
// iCal DATE values are calendar dates, not timestamps.

const crypto = require("crypto");

function pad2(value) {
  return String(value).padStart(2, "0");
}

function toMySQLDate(value) {
  if (!value) {
    throw new Error("Calendar event date is missing");
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid calendar event date");
  }

  // All-day iCal DATE values carry dateOnly=true in node-ical. Use local parts
  // directly so the calendar date never shifts across server timezones.
  if (value.dateOnly === true) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  // Timed events are instants; convert to the property/dashboard calendar date.
  // The existing project used Asia/Kolkata for timed values.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const year = parts.find(part => part.type === "year").value;
  const month = parts.find(part => part.type === "month").value;
  const day = parts.find(part => part.type === "day").value;

  return `${year}-${month}-${day}`;
}

function toDateKey(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// DTEND is exclusive for iCal all-day events. start=2026-11-25, end=2026-11-26 => [2026-11-25]
function buildUnavailableDates(startDate, endDate) {
  const startKey = toDateKey(startDate);
  const endKey = toDateKey(endDate);
  if (!startKey || !endKey) return [];

  const current = new Date(`${startKey}T00:00:00Z`);
  const end = new Date(`${endKey}T00:00:00Z`);
  if (Number.isNaN(current.getTime()) || Number.isNaN(end.getTime())) return [];

  const dates = [];
  while (current < end && dates.length < 3660) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function normalizePlatform(platform) {
  const p = String(platform || "").trim().toLowerCase();
  if (p === "airbnb") return "airbnb";
  if (p === "ingoibibo" || p === "goibibo" || p === "makemytrip" || p === "mmt") return "ingoibibo";
  return p || "unknown";
}

function platformDisplayName(platform) {
  const p = normalizePlatform(platform);
  if (p === "airbnb") return "Airbnb";
  if (p === "ingoibibo") return "Goibibo / MakeMyTrip";
  return platform || "Unknown";
}

function safeText(value, max = 500) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function hashPayload(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function hasExplicitUnavailableSignal(text) {
  const s = String(text || "").toLowerCase();
  return (
    s.includes("not available") ||
    s.includes("unavailable") ||
    s.includes("blocked") ||
    s.includes("block") ||
    s.includes("closed")
  );
}

function hasExplicitAvailableSignal(text) {
  const s = String(text || "").toLowerCase();
  return s.includes("available") && !s.includes("not available") && !s.includes("unavailable");
}

function hasConfirmedBookingSignal(event) {
  const summary = safeText(event.summary, 500).toLowerCase();
  const description = safeText(event.description, 1000).toLowerCase();
  const status = safeText(event.status, 100).toUpperCase();
  const text = `${summary} ${description}`;

  // Never infer confirmed booking from opaque/generic summaries.
  if (/(not available|unavailable|blocked|opaque)/.test(text)) return false;

  // Airbnb iCal reservations commonly have summary "Reserved" and are from Airbnb feed.
  if (/\breserved\b/.test(text)) return true;
  if (/\bbooked\b/.test(text) || /\bbooking\b/.test(text) || /\breservation\b/.test(text)) return true;
  if (status === "CONFIRMED" && !hasExplicitUnavailableSignal(text)) return true;
  return false;
}

/**
 * Classify an iCal VEVENT into booking/availability status.
 *
 * Rules:
 * - Never treat OPAQUE events as confirmed bookings unless an explicit booking signal exists.
 * - Do not invent booking status from null STATUS or generic summaries.
 * - If feed/event only indicates unavailable/blocked dates, store as unavailable dates,
 *   not confirmed bookings.
 * - Airbnb feed is treated as a verified reservation/block source by platform policy,
 *   but event-level signals are still recorded.
 */
function classifyCalendarEvent(event, { platform, sourceVerified = false } = {}) {
  const p = normalizePlatform(platform);
  const summary = safeText(event.summary, 500);
  const description = safeText(event.description, 1000);
  const status = safeText(event.status, 100);
  const transparency = safeText(event.transparency || event.transp, 100).toUpperCase();
  const text = `${summary} ${description}`.trim();
  const lower = text.toLowerCase();

  const explicitUnavailable = hasExplicitUnavailableSignal(text);
  const explicitAvailable = hasExplicitAvailableSignal(text);
  const confirmedSignal = hasConfirmedBookingSignal(event);
  const opaque = transparency === "OPAQUE";

  let bookingStatus = "unknown";
  let availabilityStatus = "unknown";
  let verified = Boolean(sourceVerified);
  let confidence = sourceVerified ? "medium" : "low";
  let reason = "Insufficient data to determine booking status.";

  if (p === "airbnb" && sourceVerified) {
    // Airbnb export feed represents reservations/blocks. Preserve as unavailable.
    bookingStatus = confirmedSignal ? "confirmed" : "blocked";
    availabilityStatus = "unavailable";
    verified = true;
    confidence = "high";
    reason = "Airbnb iCal feed item treated as verified reservation/block.";
  } else if (explicitAvailable && !explicitUnavailable) {
    bookingStatus = "not_booked";
    availabilityStatus = "available";
    confidence = sourceVerified ? "medium" : "low";
    reason = "Event explicitly indicates availability.";
  } else if (explicitUnavailable) {
    // Important: unavailable does NOT mean confirmed booking.
    bookingStatus = confirmedSignal ? "confirmed" : "unknown";
    availabilityStatus = "unavailable";
    confidence = "medium";
    reason = "Event indicates unavailable/blocked dates; booking status is not confirmed.";
  } else if (confirmedSignal && !opaque) {
    bookingStatus = "confirmed";
    availabilityStatus = "unavailable";
    confidence = sourceVerified ? "high" : "medium";
    reason = "Event contains explicit booking/reservation signal.";
  } else if (opaque) {
    // OPAQUE means busy time in iCal, but it is not proof of a confirmed OTA booking.
    bookingStatus = "unknown";
    availabilityStatus = "unknown";
    verified = false;
    confidence = "low";
    reason = "OPAQUE/unverified event without explicit booking signal; not treated as confirmed booking.";
  } else {
    bookingStatus = "unknown";
    availabilityStatus = "unknown";
    confidence = "low";
    reason = "No reliable booking/availability signal found.";
  }

  // Safety override: never mark OPAQUE-only unknown signals as confirmed.
  if (opaque && !confirmedSignal) {
    if (bookingStatus === "confirmed") bookingStatus = "unknown";
  }

  return {
    platform: p,
    bookingStatus,
    availabilityStatus,
    verified,
    confidence,
    reason,
    raw: {
      summary,
      description,
      status,
      transparency
    }
  };
}

function eventExternalId(event) {
  const uid = safeText(event.uid, 255);
  if (uid) return uid;
  const fallback = [event.start, event.end, event.summary, event.description, event.status]
    .map(v => safeText(v, 255))
    .join("|");
  return `generated-${hashPayload(fallback).slice(0, 40)}`;
}

function buildDateRangeKeys(startKey, endKeyExclusive) {
  return buildUnavailableDates(startKey, endKeyExclusive);
}

module.exports = {
  toMySQLDate,
  toDateKey,
  buildUnavailableDates,
  buildDateRangeKeys,
  normalizePlatform,
  platformDisplayName,
  classifyCalendarEvent,
  eventExternalId,
  safeText,
  hashPayload
};
