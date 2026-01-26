import { CellIndex, ShipSize, toCellIndex } from './types.js';

const GRID_SIZE = 5;
const TOTAL_CELLS = 25;

export type Orientation = 'horizontal' | 'vertical' | 'single';

export interface ValidatedPlacement {
  cells: CellIndex[];
  orientation: Orientation;
}

export class PlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlacementError';
  }
}

/**
 * Validates ship placement on 5x5 grid.
 * Grid layout:
 *     0  1  2  3  4
 *     5  6  7  8  9
 *    10 11 12 13 14
 *    15 16 17 18 19
 *    20 21 22 23 24
 */
export function validatePlacement(cells: number[], shipSize: ShipSize): ValidatedPlacement {
  if (cells.length !== shipSize) {
    throw new PlacementError(`Ship size ${shipSize} requires ${shipSize} cell(s), got ${cells.length}`);
  }

  const validated: CellIndex[] = [];
  for (const cell of cells) {
    if (!Number.isInteger(cell) || cell < 0 || cell >= TOTAL_CELLS) {
      throw new PlacementError(`Invalid cell index: ${cell}`);
    }
    validated.push(toCellIndex(cell));
  }

  if (new Set(validated).size !== validated.length) {
    throw new PlacementError('Duplicate cells in placement');
  }

  if (shipSize === 1) {
    return { cells: validated, orientation: 'single' };
  }

  const sorted = [...validated].sort((a, b) => a - b);
  const orientation = determineOrientation(sorted);

  if (!orientation) {
    throw new PlacementError('Ship cells must be contiguous horizontally or vertically');
  }

  return { cells: sorted, orientation };
}

function determineOrientation(sorted: CellIndex[]): Orientation | null {
  // Check horizontal
  const isHorizontal = sorted.every((cell, i) => {
    if (i === 0) return true;
    const prev = sorted[i - 1];
    const sameRow = Math.floor(cell / GRID_SIZE) === Math.floor(prev / GRID_SIZE);
    return sameRow && cell === prev + 1;
  });
  if (isHorizontal) return 'horizontal';

  // Check vertical
  const isVertical = sorted.every((cell, i) => {
    if (i === 0) return true;
    return cell === sorted[i - 1] + GRID_SIZE;
  });
  if (isVertical) return 'vertical';

  return null;
}

/**
 * Get cell label (A1-E5) for display
 */
export function getCellLabel(cell: CellIndex): string {
  const row = Math.floor(cell / GRID_SIZE);
  const col = cell % GRID_SIZE;
  return `${String.fromCharCode(65 + row)}${col + 1}`;
}

/**
 * Parse cell label back to index
 */
export function parseCellLabel(label: string): CellIndex {
  const match = label.toUpperCase().match(/^([A-E])([1-5])$/);
  if (!match) {
    throw new PlacementError(`Invalid cell label: ${label}`);
  }
  const row = match[1].charCodeAt(0) - 65;
  const col = parseInt(match[2], 10) - 1;
  return toCellIndex(row * GRID_SIZE + col);
}

/**
 * Get all valid placements starting from a cell.
 * Used by frontend to show valid options.
 */
export function getValidPlacements(startCell: CellIndex, shipSize: ShipSize): CellIndex[][] {
  if (shipSize === 1) {
    return [[startCell]];
  }

  const placements: CellIndex[][] = [];
  const row = Math.floor(startCell / GRID_SIZE);
  const col = startCell % GRID_SIZE;

  // Horizontal right
  if (col + shipSize <= GRID_SIZE) {
    const cells: CellIndex[] = [];
    for (let i = 0; i < shipSize; i++) {
      cells.push(toCellIndex(startCell + i));
    }
    placements.push(cells);
  }

  // Horizontal left
  if (col - shipSize + 1 >= 0) {
    const cells: CellIndex[] = [];
    for (let i = 0; i < shipSize; i++) {
      cells.push(toCellIndex(startCell - i));
    }
    placements.push(cells.sort((a, b) => a - b));
  }

  // Vertical down
  if (row + shipSize <= GRID_SIZE) {
    const cells: CellIndex[] = [];
    for (let i = 0; i < shipSize; i++) {
      cells.push(toCellIndex(startCell + i * GRID_SIZE));
    }
    placements.push(cells);
  }

  // Vertical up
  if (row - shipSize + 1 >= 0) {
    const cells: CellIndex[] = [];
    for (let i = 0; i < shipSize; i++) {
      cells.push(toCellIndex(startCell - i * GRID_SIZE));
    }
    placements.push(cells.sort((a, b) => a - b));
  }

  // Deduplicate
  const seen = new Set<string>();
  return placements.filter(p => {
    const key = p.join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
