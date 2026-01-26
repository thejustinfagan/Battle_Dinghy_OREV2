import {
  GameId,
  GameConfig,
  GameState,
  GameEvent,
  WalletAddress,
  CellIndex,
  PlayerState,
  createGameId,
} from '../core/game/types.js';
import { transition, StateMachineContext } from '../core/game/state-machine.js';
import { processSalvo, generateMockOreHash } from '../core/game/salvo.js';
import * as repo from '../db/repository.js';
import { config } from '../config.js';
import { executeEffect, setExecutorDependencies, ExecutorContext } from './event-executor.js';

// Timer storage
const pendingTimeouts = new Map<string, NodeJS.Timeout>();

// Wire up executor dependencies
setExecutorDependencies(executeSalvo, scheduleRepositionTimeout);

// ============================================
// GAME LIFECYCLE
// ============================================

export async function createGame(gameConfig: GameConfig): Promise<repo.GameRecord> {
  const id = createGameId();
  const deadline = new Date(Date.now() + gameConfig.fillDeadlineMinutes * 60 * 1000);
  const game = repo.createGame(id, gameConfig, deadline);
  scheduleDeadlineCheck(id, gameConfig.fillDeadlineMinutes * 60 * 1000);
  return game;
}

export async function joinGame(
  gameId: GameId,
  wallet: WalletAddress,
  twitterHandle: string | null,
  position: CellIndex[],
  entryTx: string
): Promise<repo.PlayerRecord> {
  const player = repo.addPlayer(gameId, { wallet, twitterHandle, position, entryTx });
  const game = repo.getGame(gameId)!;
  repo.recordTransaction(gameId, wallet, 'entry', game.config.entryFeeLamports, entryTx);

  const playerCount = repo.countPlayers(gameId);
  if (playerCount >= game.config.maxPlayers) {
    await dispatchEvent(gameId, { type: 'MAX_PLAYERS_REACHED' });
  } else {
    await dispatchEvent(gameId, { type: 'PLAYER_JOINED', wallet, position });
  }
  return player;
}

export async function forceStartGame(gameId: GameId): Promise<void> {
  await dispatchEvent(gameId, { type: 'ADMIN_FORCE_START' });
}

export async function cancelGame(gameId: GameId): Promise<void> {
  await dispatchEvent(gameId, { type: 'ADMIN_CANCEL' });
}

export async function submitReposition(
  gameId: GameId,
  wallet: WalletAddress,
  newPosition: CellIndex[]
): Promise<void> {
  const game = repo.getGame(gameId);
  if (!game) throw new Error('Game not found');
  if (game.status !== 'repositioning') throw new Error('Not in repositioning phase');

  const player = repo.getPlayer(gameId, wallet);
  if (!player) throw new Error('Not in this game');
  if (player.isEliminated) throw new Error('Eliminated');

  repo.updatePlayerPosition(gameId, wallet, newPosition);
}

// ============================================
// SALVO EXECUTION
// ============================================

export async function executeSalvo(gameId: GameId): Promise<void> {
  const game = repo.getGame(gameId);
  if (!game || game.status !== 'active') return;

  const players = repo.getActivePlayers(gameId);
  const playerStates: PlayerState[] = players.map(p => ({
    wallet: p.wallet,
    twitterHandle: p.twitterHandle,
    position: p.position,
    hits: p.hits,
    isEliminated: p.isEliminated,
    eliminatedRound: p.eliminatedRound,
  }));

  const oreHash = config.features.useRealOre ? await getRealOreHash() : generateMockOreHash();
  const result = processSalvo({
    oreHash,
    shotCount: game.config.shotsPerSalvo,
    players: playerStates,
  });

  // Update hits
  for (const [wallet, newHits] of result.hits) {
    const player = players.find(p => p.wallet === wallet)!;
    repo.updatePlayerHits(gameId, wallet, [...player.hits, ...newHits]);
  }

  // Mark eliminations
  for (const wallet of result.eliminations) {
    repo.eliminatePlayer(gameId, wallet, game.round);
  }

  // Record round
  repo.addRound(gameId, game.round, oreHash, result.shots, result.eliminations);

  // Dispatch event
  await dispatchEvent(gameId, {
    type: 'SALVO_COMPLETE',
    oreHash,
    survivors: result.survivors,
  });
}

async function getRealOreHash(): Promise<string> {
  throw new Error('Real ORE not implemented');
}

// ============================================
// EVENT DISPATCH
// ============================================

async function dispatchEvent(gameId: GameId, event: GameEvent): Promise<void> {
  const game = repo.getGame(gameId);
  if (!game) throw new Error('Game not found');

  const players = repo.getPlayers(gameId);

  // Convert to PlayerState for state machine
  const playerStates: PlayerState[] = players.map(p => ({
    wallet: p.wallet,
    twitterHandle: p.twitterHandle,
    position: p.position,
    hits: p.hits,
    isEliminated: p.isEliminated,
    eliminatedRound: p.eliminatedRound,
  }));

  const context: StateMachineContext = {
    config: game.config,
    players: playerStates,
  };

  const currentState: GameState = {
    status: game.status,
    round: game.round,
    deadline: game.deadline,
    winners: game.winners,
    cancelReason: game.cancelReason as GameState['cancelReason'],
  };

  const result = transition(currentState, event, context);
  repo.updateGameState(gameId, result.newState);

  // Execute side effects
  const executorContext: ExecutorContext = {
    config: game.config,
    players: playerStates,
  };

  for (const effect of result.sideEffects) {
    await executeEffect(gameId, effect, executorContext);
  }
}

// ============================================
// TIMERS
// ============================================

function scheduleDeadlineCheck(gameId: GameId, delayMs: number): void {
  const key = `deadline:${gameId}`;
  if (pendingTimeouts.has(key)) {
    clearTimeout(pendingTimeouts.get(key)!);
  }

  const timeout = setTimeout(async () => {
    pendingTimeouts.delete(key);
    const game = repo.getGame(gameId);
    if (game?.status === 'waiting') {
      await dispatchEvent(gameId, { type: 'DEADLINE_REACHED' });
    }
  }, delayMs);
  pendingTimeouts.set(key, timeout);
}

function scheduleRepositionTimeout(gameId: GameId, delayMs: number): void {
  const key = `reposition:${gameId}`;
  if (pendingTimeouts.has(key)) {
    clearTimeout(pendingTimeouts.get(key)!);
  }

  const timeout = setTimeout(async () => {
    pendingTimeouts.delete(key);
    const game = repo.getGame(gameId);
    if (game?.status === 'repositioning') {
      await dispatchEvent(gameId, { type: 'REPOSITION_TIMEOUT' });
    }
  }, delayMs);
  pendingTimeouts.set(key, timeout);
}

// ============================================
// QUERIES (re-export from repository)
// ============================================

export const getGame = repo.getGame;
export const getPlayers = repo.getPlayers;
export const getRounds = repo.getRounds;
export const getActiveGames = () => repo.getGamesByStatus(['waiting', 'active', 'repositioning']);
export const getWaitingGames = () => repo.getGamesByStatus(['waiting']);
export const countPlayers = repo.countPlayers;
