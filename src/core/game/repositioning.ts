import { CellIndex, PlayerState, ShipSize } from './types.js';
import { validatePlacement } from './placement.js';

export interface RepositionValidation {
  canReposition: boolean;
  reason?: string;
  unhitCells: CellIndex[];
  hitCells: CellIndex[];
}

/**
 * Check if a player can reposition their ship.
 *
 * KEY RULE FOR LEGAL COMPLIANCE:
 * Players can only reposition if they have unhit cells remaining.
 * This makes the game skill-based rather than pure chance.
 *
 * @param player - Current player state with position and hits
 * @returns Validation result with unhit/hit cell breakdown
 */
export function canPlayerReposition(player: PlayerState): RepositionValidation {
  if (player.isEliminated) {
    return {
      canReposition: false,
      reason: 'Player is eliminated',
      unhitCells: [],
      hitCells: player.hits
    };
  }

  // Find cells that haven't been hit yet
  const hitSet = new Set(player.hits);
  const unhitCells = player.position.filter(cell => !hitSet.has(cell)) as CellIndex[];
  const hitCells = player.position.filter(cell => hitSet.has(cell)) as CellIndex[];

  if (unhitCells.length === 0) {
    return {
      canReposition: false,
      reason: 'All ship cells have been hit - cannot reposition',
      unhitCells: [],
      hitCells
    };
  }

  return {
    canReposition: true,
    unhitCells,
    hitCells
  };
}

/**
 * Validate a new position for repositioning.
 *
 * RULES:
 * 1. New position must be a valid ship placement (contiguous cells)
 * 2. Must maintain same ship size
 * 3. Player must have at least one unhit cell (skill element)
 *
 * NOTE: Players can move to ANY valid position, even if it puts them
 * in danger. This is intentional - the skill is in choosing WHERE to move.
 *
 * @param oldPosition - Current ship position
 * @param newPosition - Proposed new position
 * @param hits - Cells that have been hit
 * @param shipSize - Size of ship (1, 2, or 3)
 * @returns Validation result
 */
export function validateRepositionMove(
  oldPosition: CellIndex[],
  newPosition: CellIndex[],
  hits: CellIndex[],
  shipSize: ShipSize
): { valid: boolean; error?: string } {

  // Rule 1: Validate new position is a legal ship placement
  try {
    validatePlacement(newPosition, shipSize);
  } catch (e: any) {
    return { valid: false, error: `Invalid ship placement: ${e.message}` };
  }

  // Rule 2: Must be same ship size (can't change ship structure)
  if (newPosition.length !== shipSize) {
    return { valid: false, error: `Ship size must be ${shipSize} cells` };
  }

  if (oldPosition.length !== newPosition.length) {
    return { valid: false, error: 'Cannot change ship size during repositioning' };
  }

  // Rule 3: Must have at least one unhit cell (skill-based requirement)
  const hitSet = new Set(hits);
  const unhitCells = oldPosition.filter(cell => !hitSet.has(cell));

  if (unhitCells.length === 0) {
    return { valid: false, error: 'Cannot move a fully hit ship' };
  }

  // All checks passed - player can reposition anywhere they want
  // (The strategic choice of WHERE is the skill element)
  return { valid: true };
}

/**
 * Calculate statistics about ship damage for UI display.
 *
 * @param player - Player state
 * @returns Damage statistics
 */
export function getShipDamageStats(player: PlayerState): {
  totalCells: number;
  hitCells: number;
  unhitCells: number;
  damagePercent: number;
  canMove: boolean;
} {
  const hitSet = new Set(player.hits);
  const hitCells = player.position.filter(cell => hitSet.has(cell)).length;
  const unhitCells = player.position.length - hitCells;

  return {
    totalCells: player.position.length,
    hitCells,
    unhitCells,
    damagePercent: Math.round((hitCells / player.position.length) * 100),
    canMove: unhitCells > 0 && !player.isEliminated
  };
}
