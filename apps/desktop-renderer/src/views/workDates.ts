/* Deterministic date entry for the Work item page. The document page replaces
 * native datetime-local controls with quick options plus a typed input; this
 * module owns the accepted grammar so it can be unit-tested without a DOM. */

import { formatDate } from '../i18n.js';

export interface WorkDateQuickOption {
  label: string;
  iso: string;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

export function formatWorkDate(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const day = formatDate(date, { month: 'short', day: 'numeric' });
  const time = formatDate(date, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${day} · ${time}`;
}

function parseTimeExpression(raw: string | undefined): { hours: number; minutes: number } | null {
  if (!raw) return { hours: 9, minutes: 0 };
  const text = raw.trim().toLowerCase();
  const meridiem = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (meridiem) {
    let hours = Number(meridiem[1]);
    const minutes = Number(meridiem[2] ?? '0');
    if (hours < 1 || hours > 12 || minutes > 59) return null;
    if (meridiem[3] === 'pm' && hours !== 12) hours += 12;
    if (meridiem[3] === 'am' && hours === 12) hours = 0;
    return { hours, minutes };
  }
  const clock = text.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2] ?? '0');
    if (hours > 23 || minutes > 59) return null;
    return { hours, minutes };
  }
  return null;
}

function withTime(base: Date, time: { hours: number; minutes: number }): Date {
  const next = new Date(base);
  next.setHours(time.hours, time.minutes, 0, 0);
  return next;
}

function validCalendarDate(year: number, month: number, day: number): Date | null {
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null;
}

/**
 * Parse a typed date. Explicit full dates (with a year) are accepted verbatim,
 * including the past — reminders and deadlines may legitimately be backdated.
 * Fuzzy inputs without a year ("aug 20", "8/20") resolve to the next future
 * occurrence so "remind me aug 20" never lands eleven months in the past.
 */
export function parseWorkDateInput(raw: string, now: Date = new Date()): string | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  const full = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{1,2}):(\d{2}))?$/);
  if (full) {
    const date = validCalendarDate(Number(full[1]), Number(full[2]), Number(full[3]));
    if (!date) return null;
    const time = full[4] ? parseTimeExpression(`${full[4]}:${full[5]}`) : { hours: 9, minutes: 0 };
    if (!time) return null;
    return withTime(date, time).toISOString();
  }

  const relativeDay = text.match(/^(today|tomorrow)(?:\s+(.+))?$/);
  if (relativeDay) {
    const time = parseTimeExpression(relativeDay[2]);
    if (!time) return null;
    const base = new Date(now);
    if (relativeDay[1] === 'tomorrow') base.setDate(base.getDate() + 1);
    return withTime(base, time).toISOString();
  }

  const plusDays = text.match(/^\+(\d{1,3})d$/);
  if (plusDays) {
    const base = new Date(now);
    base.setDate(base.getDate() + Number(plusDays[1]));
    return withTime(base, { hours: 9, minutes: 0 }).toISOString();
  }

  const monthName = text.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:\s+(.+))?$/);
  if (monthName) {
    const monthIndex = MONTHS.findIndex((name) => name.startsWith(monthName[1]!));
    if (monthIndex === -1) return null;
    const time = parseTimeExpression(monthName[3]);
    if (!time) return null;
    const day = Number(monthName[2]);
    const thisYear = validCalendarDate(now.getFullYear(), monthIndex + 1, day);
    if (!thisYear) return null;
    const candidate = withTime(thisYear, time);
    if (candidate.getTime() >= now.getTime()) return candidate.toISOString();
    const nextYear = validCalendarDate(now.getFullYear() + 1, monthIndex + 1, day);
    return nextYear ? withTime(nextYear, time).toISOString() : null;
  }

  const numeric = text.match(/^(\d{1,2})[/-](\d{1,2})(?:\s+(.+))?$/);
  if (numeric) {
    const time = parseTimeExpression(numeric[3]);
    if (!time) return null;
    const month = Number(numeric[1]);
    const day = Number(numeric[2]);
    const thisYear = validCalendarDate(now.getFullYear(), month, day);
    if (!thisYear) return null;
    const candidate = withTime(thisYear, time);
    if (candidate.getTime() >= now.getTime()) return candidate.toISOString();
    const nextYear = validCalendarDate(now.getFullYear() + 1, month, day);
    return nextYear ? withTime(nextYear, time).toISOString() : null;
  }

  return null;
}

export function workDateQuickOptions(now: Date = new Date()): WorkDateQuickOption[] {
  const options: WorkDateQuickOption[] = [];
  const laterToday = withTime(now, { hours: 18, minutes: 0 });
  if (laterToday.getTime() > now.getTime()) {
    options.push({ label: 'Later today · 18:00', iso: laterToday.toISOString() });
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  options.push({
    label: 'Tomorrow · 09:00',
    iso: withTime(tomorrow, { hours: 9, minutes: 0 }).toISOString(),
  });
  const nextMonday = new Date(now);
  nextMonday.setDate(nextMonday.getDate() + ((8 - nextMonday.getDay()) % 7 || 7));
  options.push({
    label: 'Next Monday · 09:00',
    iso: withTime(nextMonday, { hours: 9, minutes: 0 }).toISOString(),
  });
  return options;
}

/** Monday-first month grid for the calendar picker. `null` cells pad the
 * first and last weeks so every row is exactly seven days wide. */
export function calendarMonth(year: number, month: number): Array<Array<number | null>> {
  const lead = (new Date(year, month, 1).getDay() + 6) % 7;
  const dayCount = new Date(year, month + 1, 0).getDate();
  const cells: Array<number | null> = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= dayCount; day += 1) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<number | null>> = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return weeks;
}

/** Local wall-clock time of an ISO timestamp; the calendar preserves it when
 * you click a different day. */
export function timeOfIso(iso: string | null): { hours: number; minutes: number } {
  if (iso) {
    const date = new Date(iso);
    if (Number.isFinite(date.getTime())) {
      return { hours: date.getHours(), minutes: date.getMinutes() };
    }
  }
  return { hours: 9, minutes: 0 };
}

export function isoForDay(
  year: number,
  month: number,
  day: number,
  time: { hours: number; minutes: number },
): string {
  return new Date(year, month, day, time.hours, time.minutes, 0, 0).toISOString();
}
