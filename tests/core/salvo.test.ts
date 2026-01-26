import { describe, it, expect } from 'vitest';
import {
  generateShots,
  generateMockOreHash,
  processSalvo,
  wouldBeHit,
  calculateHits,
} from '../../src/core/game/salvo.js';
import { CellIndex, PlayerState, WalletAddress, toCellIndex } from '../../src/core/game/types.js';

describe('generateMockOreHash', () => {
  it('generates 64 character hex string', () => {
    const hash = generateMockOreHash();
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('generates different hashes', () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      hashes.add(generateMockOreHash());
    }
    expect(hashes.size).toBe(100);
  });
});

describe('generateShots', () => {
  const testHash = 'a'.repeat(64);

  it('generates correct number of shots', () => {
    expect(generateShots(testHash, 1).length).toBe(1);
    expect(generateShots(testHash, 5).length).toBe(5);
    expect(generateShots(testHash, 10).length).toBe(10);
  });

  it('generates unique shots', () => {
    const shots = generateShots(testHash, 15);
    const unique = new Set(shots);
    expect(unique.size).toBe(15);
  });

  it('generates valid cell indices', () => {
    const shots = generateShots(testHash, 25);
    for (const shot of shots) {
      expect(shot).toBeGreaterThanOrEqual(0);
      expect(shot).toBeLessThanOrEqual(24);
    }
  });

  it('returns sorted shots', () => {
    const shots = generateShots(testHash, 10);
    const sorted = [...shots].sort((a, b) => a - b);
    expect(shots).toEqual(sorted);
  });

  it('is deterministic for same hash', () => {
    const hash = generateMockOreHash();
    const shots1 = generateShots(hash, 10);
    const shots2 = generateShots(hash, 10);
    expect(shots1).toEqual(shots2);
  });

  it('produces different shots for different hashes', () => {
    const hash1 = 'a'.repeat(64);
    const hash2 = 'b'.repeat(64);
    const shots1 = generateShots(hash1, 10);
    const shots2 = generateShots(hash2, 10);
    expect(shots1).not.toEqual(shots2);
  });

  it('rejects invalid hash', () => {
    expect(() => generateShots('invalid', 5)).toThrow();
    expect(() => generateShots('a'.repeat(63), 5)).toThrow();
    expect(() => generateShots('g'.repeat(64), 5)).toThrow();
  });

  it('rejects invalid shot count', () => {
    expect(() => generateShots(testHash, 0)).toThrow();
    expect(() => generateShots(testHash, 26)).toThrow();
    expect(() => generateShots(testHash, -1)).toThrow();
  });
});

describe('processSalvo', () => {
  const createPlayer = (
    wallet: string,
    position: number[],
    hits: number[] = [],
    isEliminated = false
  ): PlayerState => ({
    wallet: wallet as WalletAddress,
    twitterHandle: null,
    position: position.map(toCellIndex) as CellIndex[],
    hits: hits.map(toCellIndex) as CellIndex[],
    isEliminated,
    eliminatedRound: isEliminated ? 1 : null,
  });

  it('detects hits on player positions', () => {
    // Hash that generates shots including cell 0, 1
    const hash = 'a'.repeat(64);
    const shots = generateShots(hash, 5);

    const players = [
      createPlayer('player1', shots.slice(0, 2)), // Position on first 2 shots
    ];

    const result = processSalvo({
      oreHash: hash,
      shotCount: 5,
      players,
    });

    expect(result.hits.get(players[0].wallet)?.length).toBeGreaterThan(0);
  });

  it('eliminates players when all cells hit', () => {
    // Create a player with a known position
    const player = createPlayer('player1', [0, 1]);

    // Find a hash that hits both cells
    let hash: string;
    let shots: CellIndex[];
    do {
      hash = generateMockOreHash();
      shots = generateShots(hash, 10);
    } while (!shots.includes(0 as CellIndex) || !shots.includes(1 as CellIndex));

    const result = processSalvo({
      oreHash: hash,
      shotCount: 10,
      players: [player],
    });

    expect(result.eliminations).toContain(player.wallet);
    expect(result.survivors).not.toContain(player.wallet);
  });

  it('does not count already-hit cells as new hits', () => {
    const player = createPlayer('player1', [0, 1, 2], [0]); // Cell 0 already hit

    // Find hash that hits cell 0
    let hash: string;
    do {
      hash = generateMockOreHash();
    } while (!generateShots(hash, 10).includes(0 as CellIndex));

    const result = processSalvo({
      oreHash: hash,
      shotCount: 10,
      players: [player],
    });

    // Cell 0 shouldn't be in new hits
    const newHits = result.hits.get(player.wallet) || [];
    expect(newHits).not.toContain(0);
  });

  it('skips eliminated players', () => {
    const eliminatedPlayer = createPlayer('player1', [0, 1], [], true);
    const activePlayer = createPlayer('player2', [2, 3]);

    const result = processSalvo({
      oreHash: 'a'.repeat(64),
      shotCount: 5,
      players: [eliminatedPlayer, activePlayer],
    });

    expect(result.eliminations).not.toContain(eliminatedPlayer.wallet);
    expect(result.survivors).not.toContain(eliminatedPlayer.wallet);
  });

  it('returns all shots', () => {
    const result = processSalvo({
      oreHash: 'a'.repeat(64),
      shotCount: 7,
      players: [],
    });

    expect(result.shots.length).toBe(7);
  });
});

describe('wouldBeHit', () => {
  it('returns true if position overlaps shots', () => {
    const position = [0, 1, 2].map(toCellIndex) as CellIndex[];
    const shots = [1, 5, 10].map(toCellIndex) as CellIndex[];
    expect(wouldBeHit(position, shots)).toBe(true);
  });

  it('returns false if no overlap', () => {
    const position = [0, 1, 2].map(toCellIndex) as CellIndex[];
    const shots = [10, 15, 20].map(toCellIndex) as CellIndex[];
    expect(wouldBeHit(position, shots)).toBe(false);
  });
});

describe('calculateHits', () => {
  it('returns cells that are both in position and shots', () => {
    const position = [0, 1, 2].map(toCellIndex) as CellIndex[];
    const shots = [1, 2, 10, 15].map(toCellIndex) as CellIndex[];
    const hits = calculateHits(position, shots);
    expect(hits).toEqual([1, 2]);
  });

  it('returns empty array if no hits', () => {
    const position = [0, 1, 2].map(toCellIndex) as CellIndex[];
    const shots = [10, 15, 20].map(toCellIndex) as CellIndex[];
    expect(calculateHits(position, shots)).toEqual([]);
  });
});
