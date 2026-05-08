import { describe, it, expect } from 'vitest';
import approval from '../backend/services/discordApprovalService.js';

describe('rename max_position_pct → max_position_pct_day', () => {
  it('SAFE_KEYS exposes the new key with day-strategy description', () => {
    expect(approval.SAFE_KEYS).toHaveProperty('max_position_pct_day');
    expect(approval.SAFE_KEYS.max_position_pct_day.description).toMatch(/DAY/i);
    expect(approval.SAFE_KEYS).not.toHaveProperty('max_position_pct');
  });
  it('SAFE_KEYS validator enforces 1-5% hard band', () => {
    const v = approval.SAFE_KEYS.max_position_pct_day.validate;
    expect(v(0.04).ok).toBe(true);
    expect(v(0.05).ok).toBe(true);
    expect(v(0.005).ok).toBe(false);
    expect(v(0.06).ok).toBe(false);
    expect(v('not a number').ok).toBe(false);
  });
  it('KEY_ALIASES rewrites legacy "max_position_pct" → "max_position_pct_day"', () => {
    expect(approval.KEY_ALIASES['max_position_pct']).toBe('max_position_pct_day');
    expect(approval.normaliseKey('max_position_pct').key).toBe('max_position_pct_day');
    expect(approval.normaliseKey('max_position_pct_day').key).toBe('max_position_pct_day');
  });
  it('DENIED_KEYS does NOT contain the new name (it is now an allowed SAFE_KEY)', () => {
    expect(approval.DENIED_KEYS.has('max_position_pct_day')).toBe(false);
  });
});
