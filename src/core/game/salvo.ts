import { CellIndex, PlayerState, WalletAddress, toCellIndex } from './types.js';

const TOTAL_CELLS = 25;

export interface SalvoInput {
  oreHash: string;
  shotCount: number;
  players: PlayerState[];
}

export interface SalvoResult {
  shots: CellIndex[];
  hits: Map<WalletAddress, CellIndex[]>;
  eliminations: WalletAddress[];
  survivors: WalletAddress[];
}

/**
 * Generate a mock ORE hash for testing/development.
 * Returns a 64-character hex string.
 */
export function generateMockOreHash(): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate shot positions from an ORE hash.
 * Uses the hash as a deterministic seed to select unique cell positions.
 */
export function generateShots(oreHash: string, count: number): CellIndex[] {
  if (count < 1 || count > TOTAL_CELLS) {
    throw new Error(`Invalid shot count: ${count}. Must be 1-${TOTAL_CELLS}`);
  }

  // Normalize hash to lowercase
  const hash = oreHash.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('Invalid ORE hash: must be 64 hex characters');
  }

  const shots: CellIndex[] = [];
  const used = new Set<number>();

  // Use 2-byte chunks from hash to generate positions
  // Each chunk gives us a number 0-65535, we mod by remaining cells
  let hashIndex = 0;

  while (shots.length < count) {
    // Get next 2 bytes (4 hex chars) from hash, wrapping if needed
    const chunk = hash.substring(hashIndex % 64, (hashIndex % 64) + 4).padEnd(4, hash.substring(0, 4 - ((hashIndex % 64) + 4 - 64)));
    const actualChunk = hashIndex % 64 + 4 <= 64
      ? hash.substring(hashIndex % 64, hashIndex % 64 + 4)
      : hash.substring(hashIndex % 64) + hash.substring(0, (hashIndex % 64 + 4) - 64);

    const value = parseInt(actualChunk, 16);
    hashIndex += 4;

    // Find next available cell
    const remaining = TOTAL_CELLS - used.size;
    const targetIndex = value % remaining;

    // Map to actual cell index (skip used cells)
    let cellIndex = 0;
    let skipped = 0;
    while (skipped < targetIndex || used.has(cellIndex)) {
      if (!used.has(cellIndex)) {
        skipped++;
      }
      if (skipped < targetIndex || used.has(cellIndex)) {
        cellIndex++;
      }
    }

    used.add(cellIndex);
    shots.push(toCellIndex(cellIndex));
  }

  return shots.sort((a, b) => a - b);
}

/**
 * Process a salvo against all players.
 * Returns shots fired, hits per player, eliminations, and survivors.
 */
export function processSalvo(input: SalvoInput): SalvoResult {
  const { oreHash, shotCount, players } = input;

  // Generate shots from hash
  const shots = generateShots(oreHash, shotCount);
  const shotSet = new Set(shots);

  // Track hits and eliminations
  const hits = new Map<WalletAddress, CellIndex[]>();
  const eliminations: WalletAddress[] = [];
  const survivors: WalletAddress[] = [];

  for (const player of players) {
    // Skip already eliminated players
    if (player.isEliminated) {
      continue;
    }

    // Find new hits (shots that hit position cells not already hit)
    const existingHits = new Set(player.hits);
    const newHits: CellIndex[] = [];

    for (const cell of player.position) {
      if (shotSet.has(cell) && !existingHits.has(cell)) {
        newHits.push(cell);
      }
    }

    if (newHits.length > 0) {
      hits.set(player.wallet, newHits);
    }

    // Check if player is now eliminated (all cells hit)
    const totalHits = player.hits.length + newHits.length;
    if (totalHits >= player.position.length) {
      eliminations.push(player.wallet);
    } else {
      survivors.push(player.wallet);
    }
  }

  return {
    shots,
    hits,
    eliminations,
    survivors,
  };
}

/**
 * Check if a position would be hit by shots.
 * Useful for UI to show potential danger zones.
 */
export function wouldBeHit(position: CellIndex[], shots: CellIndex[]): boolean {
  const shotSet = new Set(shots);
  return position.some(cell => shotSet.has(cell));
}

/**
 * Calculate hits on a position from shots.
 */
export function calculateHits(position: CellIndex[], shots: CellIndex[]): CellIndex[] {
  const shotSet = new Set(shots);
  return position.filter(cell => shotSet.has(cell));
}
