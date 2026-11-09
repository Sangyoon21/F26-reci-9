import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mergeIntervals, type Interval } from '../src/intervals';

// Read the spec in src/intervals/mergeIntervals.ts, then check your progress
// with `npm run mutants:intervals`.
//
// Label every property with its pattern, on the line above its `it(`:
//   // Pattern: invariant. The output is sorted.
// (invariant, algebraic, metamorphic, differential, or conditional)

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// Valid by construction: a start plus a non-negative length, so start <= end
// always holds. A small coordinate range makes overlaps, shared endpoints
// ([1, 3] and [3, 5]), unit gaps ([1, 2] and [3, 4]), duplicates and
// zero-length intervals ([2, 2]) common rather than astronomically rare.
const smallInterval: fc.Arbitrary<Interval> = fc
  .tuple(fc.integer({ min: -10, max: 10 }), fc.integer({ min: 0, max: 6 }))
  .map(([start, len]): Interval => [start, start + len]);

// Occasionally use the full integer range too, so large / negative values
// (e.g. overflow-ish or sign-sensitive bugs) are exercised.
const wideInterval: fc.Arbitrary<Interval> = fc
  .tuple(fc.integer({ min: -1_000_000, max: 1_000_000 }), fc.nat({ max: 1_000_000 }))
  .map(([start, len]): Interval => [start, start + len]);

const interval: fc.Arbitrary<Interval> = fc.oneof(
  { arbitrary: smallInterval, weight: 4 },
  { arbitrary: wideInterval, weight: 1 },
);

// Lists from a single "regime" so that wide lists still overlap sometimes.
const intervalList: fc.Arbitrary<Interval[]> = fc.oneof(
  { arbitrary: fc.array(smallInterval, { maxLength: 12 }), weight: 4 },
  { arbitrary: fc.array(interval, { maxLength: 12 }), weight: 1 },
);

// Targeted generator for the conditional property: intervals that are already
// pairwise disjoint AND non-touching. Built left-to-right with a gap of at
// least 1 between one interval's end and the next one's start, then shuffled
// so the input order is arbitrary.
const disjointSorted: fc.Arbitrary<Interval[]> = fc
  .tuple(
    fc.integer({ min: -20, max: 20 }),
    fc.array(fc.tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 0, max: 4 })), {
      maxLength: 10,
    }),
  )
  .map(([first, steps]) => {
    const out: Interval[] = [];
    let cursor = first;
    for (const [gap, len] of steps) {
      const start = cursor;
      const end = start + len;
      out.push([start, end]);
      cursor = end + gap; // gap >= 1 so end < next start
    }
    return out;
  });

const disjointShuffled: fc.Arbitrary<{ sorted: Interval[]; input: Interval[] }> =
  disjointSorted.chain(sorted =>
    fc
      .shuffledSubarray(sorted, { minLength: sorted.length, maxLength: sorted.length })
      .map(input => ({ sorted, input })),
  );

// ---------------------------------------------------------------------------
// Small helper oracles (not a re-implementation of mergeIntervals)
// ---------------------------------------------------------------------------

const covers = (xs: readonly Interval[], p: number): boolean =>
  xs.some(([s, e]) => s <= p && p <= e);

// Interesting points to probe: every endpoint, the points just around it,
// and the half-points between integers (the spec says *all real numbers*, so
// [1, 2] and [3, 4] must not be glued together across the gap 2 < x < 3).
const probePoints = (xs: readonly Interval[]): number[] => {
  const pts = new Set<number>();
  for (const [s, e] of xs) {
    for (const v of [s, e]) {
      pts.add(v - 1);
      pts.add(v - 0.5);
      pts.add(v);
      pts.add(v + 0.5);
      pts.add(v + 1);
    }
  }
  return [...pts];
};

const copy = (xs: readonly Interval[]): Interval[] => xs.map(([s, e]): Interval => [s, e]);

describe('mergeIntervals', () => {
  // Pattern: invariant. Every input interval lies inside some output interval.
  it('every input interval lies inside some output interval', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const out = mergeIntervals(xs);
        const uncovered = xs.filter(([s, e]) => !out.some(([a, b]) => a <= s && e <= b));
        expect(uncovered).toEqual([]);
      }),
    );
  });

  // Pattern: invariant. The output is sorted by start, each interval is valid (integer endpoints, start <= end), and consecutive intervals neither overlap nor touch (result[i][1] < result[i + 1][0]).
  it('returns valid, sorted, non-overlapping, non-touching intervals', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const out = mergeIntervals(xs);
        for (const [s, e] of out) {
          expect(Number.isInteger(s) && Number.isInteger(e)).toBe(true);
          expect(s).toBeLessThanOrEqual(e);
        }
        for (let i = 0; i + 1 < out.length; i++) {
          expect(out[i][1]).toBeLessThan(out[i + 1][0]);
        }
      }),
    );
  });

  // Pattern: invariant. Every output interval's endpoints are endpoints taken from the input (merging never invents new boundaries), and the output is never longer than the input.
  it('output endpoints come from the input and output is no longer than input', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const out = mergeIntervals(xs);
        expect(out.length).toBeLessThanOrEqual(xs.length);
        const starts = new Set(xs.map(([s]) => s));
        const ends = new Set(xs.map(([, e]) => e));
        for (const [s, e] of out) {
          expect(starts.has(s)).toBe(true);
          expect(ends.has(e)).toBe(true);
        }
      }),
    );
  });

  // Pattern: invariant. The input array and the intervals in it are not modified.
  it('does not modify its input', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const before = copy(xs);
        const innerRefs = [...xs];
        mergeIntervals(xs);
        expect(xs).toEqual(before);
        // same interval objects, still in the same order
        xs.forEach((iv, i) => expect(iv).toBe(innerRefs[i]));
      }),
    );
  });

  // Pattern: differential. A point p (integer or not) is covered by the output exactly when it is covered by the input.
  it('covers exactly the same points as the input', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const out = mergeIntervals(xs);
        for (const p of probePoints(xs)) {
          expect([p, covers(out, p)]).toEqual([p, covers(xs, p)]);
        }
        // and nothing outside the probe set either: any output point is in the input
        for (const p of probePoints(out)) {
          expect([p, covers(out, p)]).toEqual([p, covers(xs, p)]);
        }
      }),
    );
  });

  // Pattern: metamorphic. Reordering the input (any permutation) does not change the output.
  it('is independent of input order', () => {
    fc.assert(
      fc.property(
        intervalList.chain(xs =>
          fc
            .shuffledSubarray(xs, { minLength: xs.length, maxLength: xs.length })
            .map(ys => ({ xs, ys })),
        ),
        ({ xs, ys }) => {
          expect(mergeIntervals(ys)).toEqual(mergeIntervals(xs));
        },
      ),
    );
  });

  // Pattern: metamorphic. Adding duplicates of existing intervals does not change the output.
  it('is unaffected by duplicated input intervals', () => {
    fc.assert(
      fc.property(
        intervalList.chain(xs =>
          fc.shuffledSubarray(xs).map(dups => ({ xs, ys: [...xs, ...copy(dups)] })),
        ),
        ({ xs, ys }) => {
          expect(mergeIntervals(ys)).toEqual(mergeIntervals(xs));
        },
      ),
    );
  });

  // Pattern: metamorphic. Shifting every interval by a constant k shifts every output interval by k.
  it('commutes with translation', () => {
    fc.assert(
      fc.property(intervalList, fc.integer({ min: -50, max: 50 }), (xs, k) => {
        const shifted = xs.map(([s, e]): Interval => [s + k, e + k]);
        const expected = mergeIntervals(xs).map(([s, e]): Interval => [s + k, e + k]);
        expect(mergeIntervals(shifted)).toEqual(expected);
      }),
    );
  });

  // Pattern: metamorphic. Adding an interval that is already contained in some input interval does not change the output.
  it('is unaffected by adding a sub-interval of an existing interval', () => {
    fc.assert(
      fc.property(
        fc
          .array(smallInterval, { minLength: 1, maxLength: 12 })
          .chain(xs =>
            fc
              .tuple(fc.nat({ max: xs.length - 1 }), fc.nat(), fc.nat())
              .map(([i, a, b]) => {
                const [s, e] = xs[i];
                const width = e - s;
                const lo = s + (a % (width + 1));
                const hi = lo + (b % (e - lo + 1));
                return { xs, extra: [lo, hi] as Interval };
              }),
          ),
        ({ xs, extra }) => {
          expect(mergeIntervals([...xs, extra])).toEqual(mergeIntervals(xs));
        },
      ),
    );
  });

  // Pattern: algebraic. Merging is idempotent: merge(merge(xs)) equals merge(xs).
  it('is idempotent', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const once = mergeIntervals(xs);
        expect(mergeIntervals(once)).toEqual(once);
      }),
    );
  });

  // Pattern: algebraic. Merging the concatenation equals merging the concatenation of the two merged halves: merge(a ++ b) = merge(merge(a) ++ merge(b)).
  it('merging distributes over concatenation', () => {
    fc.assert(
      fc.property(intervalList, intervalList, (a, b) => {
        expect(mergeIntervals([...mergeIntervals(a), ...mergeIntervals(b)])).toEqual(
          mergeIntervals([...a, ...b]),
        );
      }),
    );
  });

  // Pattern: conditional. If the input intervals already neither overlap nor touch, the output is exactly those intervals, sorted by start.
  it('returns already-disjoint input unchanged apart from sorting', () => {
    fc.assert(
      fc.property(disjointShuffled, ({ sorted, input }) => {
        expect(mergeIntervals(input)).toEqual(sorted);
      }),
    );
  });

  // Pattern: conditional. If two intervals touch at exactly one endpoint ([a, b] and [b, c]), they merge into the single interval [a, c].
  it('merges intervals that touch at a shared endpoint', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 1000 }),
        fc.nat({ max: 20 }),
        fc.nat({ max: 20 }),
        fc.boolean(),
        (a, l1, l2, flip) => {
          const left: Interval = [a, a + l1];
          const right: Interval = [a + l1, a + l1 + l2];
          const input = flip ? [right, left] : [left, right];
          expect(mergeIntervals(input)).toEqual([[a, a + l1 + l2]]);
        },
      ),
    );
  });

  // Pattern: conditional. If two intervals are separated by a gap of exactly one integer step ([a, b] and [b + 1, c]), they stay separate.
  it('keeps intervals separated by a unit gap apart', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 1000 }),
        fc.nat({ max: 20 }),
        fc.nat({ max: 20 }),
        fc.boolean(),
        (a, l1, l2, flip) => {
          const left: Interval = [a, a + l1];
          const right: Interval = [a + l1 + 1, a + l1 + 1 + l2];
          const input = flip ? [right, left] : [left, right];
          expect(mergeIntervals(input)).toEqual([left, right]);
        },
      ),
    );
  });

  // Pattern: conditional. If some interval has start > end or a non-integer endpoint, mergeIntervals throws a RangeError.
  it('throws RangeError on invalid intervals', () => {
    const badInterval: fc.Arbitrary<Interval> = fc.oneof(
      // start > end, by construction
      fc
        .tuple(fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: 1, max: 1000 }))
        .map(([s, d]): Interval => [s, s - d]),
      // non-integer start
      fc
        .tuple(fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: 1, max: 1000 }))
        .map(([s, len]): Interval => [s + 0.5, s + len]),
      // non-integer end
      fc
        .tuple(fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: 1, max: 1000 }))
        .map(([s, len]): Interval => [s, s + len - 0.5]),
      // NaN / infinities
      fc.constantFrom<Interval>([Number.NaN, 0], [0, Number.NaN], [0, Infinity], [-Infinity, 0]),
    );
    fc.assert(
      fc.property(
        fc.array(smallInterval, { maxLength: 6 }),
        badInterval,
        fc.array(smallInterval, { maxLength: 6 }),
        (before, bad, after) => {
          expect(() => mergeIntervals([...before, bad, ...after])).toThrow(RangeError);
        },
      ),
    );
  });

  // Example tests from the spec (do not count as properties).
  it('matches the examples in the spec', () => {
    expect(mergeIntervals([])).toEqual([]);
    expect(mergeIntervals([[1, 3], [3, 5]])).toEqual([[1, 5]]);
    expect(mergeIntervals([[1, 2], [3, 4]])).toEqual([[1, 2], [3, 4]]);
    expect(mergeIntervals([[3, 4], [1, 2]])).toEqual([[1, 2], [3, 4]]);
    expect(mergeIntervals([[1, 10], [2, 3]])).toEqual([[1, 10]]);
  });
});
