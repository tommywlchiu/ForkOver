import { contrastRatio, WCAG_AA_NORMAL } from './contrast';
import { themes, contrastPairs } from './tokens';

describe('contrastRatio', () => {
  it('returns 21 for black on white', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
  });

  it('returns 1 for identical colors', () => {
    expect(contrastRatio('#808080', '#808080')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#123456', '#FEDCBA')).toBeCloseTo(contrastRatio('#FEDCBA', '#123456'), 10);
  });
});

describe('theme token contrast (WCAG AA, NFR-10)', () => {
  (['light', 'dark'] as const).forEach((themeName) => {
    describe(`${themeName} theme`, () => {
      for (const [foreground, background, label] of contrastPairs(themes[themeName])) {
        it(`${label} meets 4.5:1`, () => {
          expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
        });
      }
    });
  });
});
