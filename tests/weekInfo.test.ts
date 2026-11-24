import { describe, expect, it } from 'vitest';
import { currentWeekInfo } from '../src/application/services/WeekInfo';

describe('currentWeekInfo (week starts Saturday, matches App\\Helpers\\WeekHelper)', () => {
  it('names the day the same as PHP Carbon for the same weekday index', () => {
    expect(currentWeekInfo(new Date('2026-09-27T12:00:00Z')).dayOfWeek).toBe('Sunday'); // Sep 27 2026 is a Sunday
    expect(currentWeekInfo(new Date('2026-09-26T12:00:00Z')).dayOfWeek).toBe('Saturday');
  });

  it('starts week 1 on the first Saturday-week of the year', () => {
    expect(currentWeekInfo(new Date('2026-01-01T00:00:00Z'))).toEqual({ dayOfWeek: 'Thursday', year: 2026, week: 1 });
  });

  it('rolls the last days of December into week 53 when the year has one', () => {
    expect(currentWeekInfo(new Date('2026-12-31T00:00:00Z')).week).toBe(53);
  });

  it('is stable across the hour of day (unlike the web\'s fractional-day quirk)', () => {
    const a = currentWeekInfo(new Date('2026-09-27T00:05:00Z'));
    const b = currentWeekInfo(new Date('2026-09-27T23:55:00Z'));
    expect(a).toEqual(b);
  });
});
