import { describe, it, expect } from 'vitest';
import {
  validatePlacement,
  PlacementError,
  getCellLabel,
  parseCellLabel,
  getValidPlacements,
} from '../../src/core/game/placement.js';
import { toCellIndex } from '../../src/core/game/types.js';

describe('validatePlacement', () => {
  describe('size 1 ships', () => {
    it('accepts any single cell', () => {
      const result = validatePlacement([0], 1);
      expect(result.cells).toEqual([0]);
      expect(result.orientation).toBe('single');
    });

    it('accepts cell 24', () => {
      const result = validatePlacement([24], 1);
      expect(result.cells).toEqual([24]);
    });

    it('rejects wrong number of cells', () => {
      expect(() => validatePlacement([0, 1], 1)).toThrow(PlacementError);
      expect(() => validatePlacement([], 1)).toThrow(PlacementError);
    });
  });

  describe('size 2 ships', () => {
    it('accepts horizontal placement', () => {
      const result = validatePlacement([0, 1], 2);
      expect(result.cells).toEqual([0, 1]);
      expect(result.orientation).toBe('horizontal');
    });

    it('accepts vertical placement', () => {
      const result = validatePlacement([0, 5], 2);
      expect(result.cells).toEqual([0, 5]);
      expect(result.orientation).toBe('vertical');
    });

    it('sorts cells', () => {
      const result = validatePlacement([1, 0], 2);
      expect(result.cells).toEqual([0, 1]);
    });

    it('rejects non-contiguous cells', () => {
      expect(() => validatePlacement([0, 2], 2)).toThrow(PlacementError);
    });

    it('rejects diagonal placement', () => {
      expect(() => validatePlacement([0, 6], 2)).toThrow(PlacementError);
    });

    it('rejects wrap-around horizontal', () => {
      // Cell 4 and 5 are on different rows
      expect(() => validatePlacement([4, 5], 2)).toThrow(PlacementError);
    });
  });

  describe('size 3 ships', () => {
    it('accepts horizontal placement', () => {
      const result = validatePlacement([0, 1, 2], 3);
      expect(result.cells).toEqual([0, 1, 2]);
      expect(result.orientation).toBe('horizontal');
    });

    it('accepts vertical placement', () => {
      const result = validatePlacement([0, 5, 10], 3);
      expect(result.cells).toEqual([0, 5, 10]);
      expect(result.orientation).toBe('vertical');
    });

    it('rejects L-shaped placement', () => {
      expect(() => validatePlacement([0, 1, 6], 3)).toThrow(PlacementError);
    });

    it('rejects non-contiguous cells', () => {
      expect(() => validatePlacement([0, 1, 3], 3)).toThrow(PlacementError);
    });
  });

  describe('validation errors', () => {
    it('rejects invalid cell indices', () => {
      expect(() => validatePlacement([-1], 1)).toThrow(PlacementError);
      expect(() => validatePlacement([25], 1)).toThrow(PlacementError);
      expect(() => validatePlacement([1.5], 1)).toThrow(PlacementError);
    });

    it('rejects duplicate cells', () => {
      expect(() => validatePlacement([0, 0], 2)).toThrow(PlacementError);
    });

    it('rejects wrong cell count', () => {
      expect(() => validatePlacement([0, 1, 2], 2)).toThrow(PlacementError);
      expect(() => validatePlacement([0], 2)).toThrow(PlacementError);
    });
  });
});

describe('getCellLabel', () => {
  it('converts cell 0 to A1', () => {
    expect(getCellLabel(toCellIndex(0))).toBe('A1');
  });

  it('converts cell 4 to A5', () => {
    expect(getCellLabel(toCellIndex(4))).toBe('A5');
  });

  it('converts cell 5 to B1', () => {
    expect(getCellLabel(toCellIndex(5))).toBe('B1');
  });

  it('converts cell 24 to E5', () => {
    expect(getCellLabel(toCellIndex(24))).toBe('E5');
  });

  it('converts cell 12 to C3', () => {
    expect(getCellLabel(toCellIndex(12))).toBe('C3');
  });
});

describe('parseCellLabel', () => {
  it('parses A1 to cell 0', () => {
    expect(parseCellLabel('A1')).toBe(0);
  });

  it('parses E5 to cell 24', () => {
    expect(parseCellLabel('E5')).toBe(24);
  });

  it('is case insensitive', () => {
    expect(parseCellLabel('a1')).toBe(0);
    expect(parseCellLabel('e5')).toBe(24);
  });

  it('rejects invalid labels', () => {
    expect(() => parseCellLabel('F1')).toThrow(PlacementError);
    expect(() => parseCellLabel('A6')).toThrow(PlacementError);
    expect(() => parseCellLabel('A0')).toThrow(PlacementError);
    expect(() => parseCellLabel('AA1')).toThrow(PlacementError);
    expect(() => parseCellLabel('')).toThrow(PlacementError);
  });
});

describe('getValidPlacements', () => {
  it('returns single cell for size 1', () => {
    const placements = getValidPlacements(toCellIndex(12), 1);
    expect(placements).toEqual([[12]]);
  });

  it('returns 4 options from center for size 2', () => {
    const placements = getValidPlacements(toCellIndex(12), 2);
    expect(placements.length).toBe(4);
    // Should have horizontal left, horizontal right, vertical up, vertical down
    expect(placements).toContainEqual([12, 13]); // right
    expect(placements).toContainEqual([11, 12]); // left
    expect(placements).toContainEqual([7, 12]); // up
    expect(placements).toContainEqual([12, 17]); // down
  });

  it('returns 2 options from corner for size 2', () => {
    const placements = getValidPlacements(toCellIndex(0), 2);
    expect(placements.length).toBe(2);
    expect(placements).toContainEqual([0, 1]); // right
    expect(placements).toContainEqual([0, 5]); // down
  });

  it('deduplicates placements', () => {
    const placements = getValidPlacements(toCellIndex(2), 3);
    const keys = placements.map(p => p.join(','));
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
  });
});
