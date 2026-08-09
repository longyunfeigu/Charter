import { describe, expect, it } from 'vitest';
import {
  calendarMonth,
  isoForDay,
  parseWorkDateInput,
  timeOfIso,
  workDateQuickOptions,
} from './workDates.js';

// Fixed reference: Sunday 2026-08-09 14:30 local time.
const NOW = new Date(2026, 7, 9, 14, 30, 0, 0);

function local(iso: string | null): string {
  expect(iso).not.toBeNull();
  const date = new Date(iso!);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

describe('parseWorkDateInput', () => {
  it('accepts explicit datetime-local style values, including the past', () => {
    expect(local(parseWorkDateInput('2026-08-20T09:00', NOW))).toBe('2026-08-20 09:00');
    expect(local(parseWorkDateInput('2026-08-20 18:45', NOW))).toBe('2026-08-20 18:45');
    // Backdated reminders/deadlines are legitimate and must not be rejected.
    expect(local(parseWorkDateInput('2026-08-09T14:29', NOW))).toBe('2026-08-09 14:29');
  });

  it('defaults a bare explicit date to 09:00', () => {
    expect(local(parseWorkDateInput('2026-09-01', NOW))).toBe('2026-09-01 09:00');
  });

  it('understands today and tomorrow with optional times', () => {
    expect(local(parseWorkDateInput('today 18:00', NOW))).toBe('2026-08-09 18:00');
    expect(local(parseWorkDateInput('tomorrow', NOW))).toBe('2026-08-10 09:00');
    expect(local(parseWorkDateInput('tomorrow 3pm', NOW))).toBe('2026-08-10 15:00');
    expect(local(parseWorkDateInput('tomorrow 12am', NOW))).toBe('2026-08-10 00:00');
  });

  it('understands +Nd offsets at 09:00', () => {
    expect(local(parseWorkDateInput('+3d', NOW))).toBe('2026-08-12 09:00');
  });

  it('resolves month-name dates to the next occurrence', () => {
    expect(local(parseWorkDateInput('aug 20', NOW))).toBe('2026-08-20 09:00');
    expect(local(parseWorkDateInput('Aug 20 3pm', NOW))).toBe('2026-08-20 15:00');
    // Already passed this year → next year.
    expect(local(parseWorkDateInput('aug 1', NOW))).toBe('2027-08-01 09:00');
    expect(local(parseWorkDateInput('september 1', NOW))).toBe('2026-09-01 09:00');
  });

  it('resolves numeric month/day to the next occurrence', () => {
    expect(local(parseWorkDateInput('8/20', NOW))).toBe('2026-08-20 09:00');
    expect(local(parseWorkDateInput('8-20 07:15', NOW))).toBe('2026-08-20 07:15');
    expect(local(parseWorkDateInput('1/5', NOW))).toBe('2027-01-05 09:00');
  });

  it('rejects nonsense instead of guessing', () => {
    expect(parseWorkDateInput('', NOW)).toBeNull();
    expect(parseWorkDateInput('soonish', NOW)).toBeNull();
    expect(parseWorkDateInput('2026-02-30', NOW)).toBeNull();
    expect(parseWorkDateInput('13/40', NOW)).toBeNull();
    expect(parseWorkDateInput('aug 20 25:99', NOW)).toBeNull();
  });
});

describe('workDateQuickOptions', () => {
  it('only offers future options and always includes tomorrow morning', () => {
    const options = workDateQuickOptions(NOW);
    expect(options[0]!.label).toBe('Later today · 18:00');
    for (const option of options) {
      expect(Date.parse(option.iso)).toBeGreaterThan(NOW.getTime());
    }
    expect(options.map((option) => option.label)).toContain('Tomorrow · 09:00');
  });

  it('drops "later today" once 18:00 has passed and points Monday across the week', () => {
    const evening = new Date(2026, 7, 9, 19, 0, 0, 0);
    const options = workDateQuickOptions(evening);
    expect(options[0]!.label).toBe('Tomorrow · 09:00');
    const monday = options.find((option) => option.label.startsWith('Next Monday'));
    expect(local(monday!.iso)).toBe('2026-08-10 09:00');
  });
});

describe('calendarMonth', () => {
  it('lays out August 2026 Monday-first (Aug 1 is a Saturday)', () => {
    const weeks = calendarMonth(2026, 7);
    expect(weeks[0]).toEqual([null, null, null, null, null, 1, 2]);
    expect(weeks.at(-1)).toEqual([31, null, null, null, null, null, null]);
    expect(weeks.flat().filter(Boolean)).toHaveLength(31);
    for (const week of weeks) expect(week).toHaveLength(7);
  });

  it('produces exactly four full weeks for February 2027 (starts on a Monday)', () => {
    const weeks = calendarMonth(2027, 1);
    expect(weeks).toHaveLength(4);
    expect(weeks[0]![0]).toBe(1);
    expect(weeks.at(-1)!.at(-1)).toBe(28);
  });
});

describe('timeOfIso / isoForDay', () => {
  it('round-trips a clicked day at the preserved wall-clock time', () => {
    const original = isoForDay(2026, 7, 20, { hours: 15, minutes: 30 });
    expect(local(original)).toBe('2026-08-20 15:30');
    expect(timeOfIso(original)).toEqual({ hours: 15, minutes: 30 });
    expect(local(isoForDay(2026, 8, 1, timeOfIso(original)))).toBe('2026-09-01 15:30');
  });

  it('defaults to 09:00 when there is no prior value', () => {
    expect(timeOfIso(null)).toEqual({ hours: 9, minutes: 0 });
    expect(timeOfIso('not-a-date')).toEqual({ hours: 9, minutes: 0 });
  });
});
