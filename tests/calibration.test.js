import { describe, it, expect } from 'vitest';
import cal from '../backend/services/calibrationService.js';

describe('assignBucket (5 bins across [0.65, 0.90])', () => {
  it('assigns to the correct 5pp bucket', () => {
    expect(cal.assignBucket(0.66)).toEqual([0.65, 0.70]);
    expect(cal.assignBucket(0.74)).toEqual([0.70, 0.75]);
    expect(cal.assignBucket(0.83)).toEqual([0.80, 0.85]);
    expect(cal.assignBucket(0.90)).toEqual([0.85, 0.90]);
  });
  it('returns null outside the gate band', () => {
    expect(cal.assignBucket(0.50)).toBeNull();
    expect(cal.assignBucket(0.95)).toBeNull();
    expect(cal.assignBucket(NaN)).toBeNull();
    expect(cal.assignBucket(null)).toBeNull();
  });
});

describe('bucketAggregates', () => {
  it('correctly counts signals/trades/wins per bucket', () => {
    const rows = [
      { predicted: 0.66, realized: 1 },
      { predicted: 0.67, realized: 0 },
      { predicted: 0.68, realized: null },
      { predicted: 0.85, realized: 1 },
      { predicted: 0.50, realized: 0 },
    ];
    const agg = cal.bucketAggregates(rows);
    const lo = agg.find(b => b.bucket_low === 0.65);
    expect(lo.n_signals).toBe(3);
    expect(lo.n_trades).toBe(2);
    expect(lo.n_wins).toBe(1);
    expect(lo.realized_wr).toBeCloseTo(0.5, 5);
    const hi = agg.find(b => b.bucket_low === 0.85);
    expect(hi.n_signals).toBe(1);
    expect(hi.n_trades).toBe(1);
    expect(hi.realized_wr).toBe(1);
  });
  it('returns realized_wr=null and gap=null for empty buckets', () => {
    const agg = cal.bucketAggregates([]);
    for (const b of agg) {
      expect(b.realized_wr).toBeNull();
      expect(b.gap).toBeNull();
    }
  });
});

describe('isBucketChronicallyMiscalibrated', () => {
  it('true when the most recent N=5 days all have |gap| > threshold', () => {
    const rows = [
      { gap: -0.20 }, { gap: 0.18 }, { gap: -0.16 }, { gap: 0.20 }, { gap: -0.22 },
    ];
    expect(cal.isBucketChronicallyMiscalibrated(rows)).toBe(true);
  });
  it('false when fewer than required days', () => {
    expect(cal.isBucketChronicallyMiscalibrated([{ gap: -0.20 }])).toBe(false);
  });
  it('false when any of the last N rows is below threshold or missing', () => {
    expect(cal.isBucketChronicallyMiscalibrated([
      { gap: -0.20 }, { gap: -0.20 }, { gap: -0.05 }, { gap: -0.20 }, { gap: -0.20 },
    ])).toBe(false);
    expect(cal.isBucketChronicallyMiscalibrated([
      { gap: null }, { gap: -0.20 }, { gap: -0.20 }, { gap: -0.20 }, { gap: -0.20 },
    ])).toBe(false);
  });
});

describe('renderCalibrationMarkdown', () => {
  it('returns empty string for ok:false / null', () => {
    expect(cal.renderCalibrationMarkdown(null)).toBe('');
    expect(cal.renderCalibrationMarkdown({ ok: false })).toBe('');
  });
  it('renders a table when ok:true with buckets', () => {
    const md = cal.renderCalibrationMarkdown({
      ok: true,
      buckets: cal.bucketAggregates([{ predicted: 0.85, realized: 1 }]),
      flagged_buckets: [],
      gap_threshold: cal.GAP_THRESHOLD,
      flag_required_days: cal.FLAG_REQUIRED_DAYS,
    });
    expect(md).toMatch(/Calibration Audit/);
    expect(md).toMatch(/85-90%/);
  });
});
