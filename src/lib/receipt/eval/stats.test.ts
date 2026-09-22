import { mean, median, percentile } from './stats';

describe('percentile', () => {
  it('is null for no values', () => {
    expect(percentile([], 90)).toBeNull();
    expect(median([])).toBeNull();
    expect(mean([])).toBeNull();
  });

  it('returns the only value for one value', () => {
    expect(percentile([7], 90)).toBe(7);
  });

  it('is the middle value for an odd count and the midpoint for an even count', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('interpolates the 90th percentile between ranks', () => {
    // ten values: rank 0.9 * 9 = 8.1, between 9 and 10
    const values = [10, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(percentile(values, 90)).toBeCloseTo(9.1);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 100)).toBe(10);
  });

  it('does not reorder the input', () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });

  it('averages', () => {
    expect(mean([1, 2, 6])).toBe(3);
  });
});
