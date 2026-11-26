import { describe, expect, it } from 'vitest';
import { sparklinePath } from './Sparkline.tsx';

describe('sparklinePath', () => {
  it('puts the newest point at the right edge and breaks the line at gaps', () => {
    expect(sparklinePath([50, null, 100, 0], 5, 100)).toBe('M25.00 14.00M75.00 1.00L100.00 27.00');
  });
});
