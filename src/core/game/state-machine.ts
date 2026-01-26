import {
  GameConfig,
  GameState,
  GameEvent,
  GameStatus,
  PlayerState,
  SideEffect,
  TransitionResult,
  WalletAddress,
  CellIndex,
} from './types.js';
import { processSalvo } from './salvo.js';

export class InvalidTransitionError extends Error {
  constructor(
    public readonly currentStatus: GameStatus,
    public readonly event: GameEvent
  ) {
    super(`Invalid transition: ${currentStatus} + ${event.type}`);
    this.name = 'InvalidTransitionError';
  }
}

export interface StateMachineContext {
  config: GameConfig;
  players: PlayerState[];
}

/**
 * Pure state machine for game transitions.
 * Returns new state and side effects without performing I/O.
 */
export function transition(
  state: GameState,
  event: GameEvent,
  context: StateMachineContext
): TransitionResult {
  const { config, players } = context;

  switch (state.status) {
    case 'waiting':
      return handleWaiting(state, event, config, players);

    case 'active':
      return handleActive(state, event, config, players);

    case 'repositioning':
      return handleRepositioning(state, event, config, players);

    case 'complete':
    case 'cancelled':
      throw new InvalidTransitionError(state.status, event);

    default:
      throw new Error(`Unknown state: ${state.status}`);
  }
}

function handleWaiting(
  state: GameState,
  event: GameEvent,
  config: GameConfig,
  players: PlayerState[]
): TransitionResult {
  switch (event.type) {
    case 'PLAYER_JOINED': {
      const sideEffects: SideEffect[] = [
        {
          type: 'NOTIFY_PLAYERS',
          message: `Player joined! ${players.length + 1}/${config.maxPlayers}`,
        },
      ];

      // Check if this fills the game
      if (players.length + 1 >= config.maxPlayers) {
        return {
          newState: {
            status: 'active',
            round: 1,
            deadline: null,
            winners: [],
            cancelReason: null,
          },
          sideEffects: [
            ...sideEffects,
            { type: 'NOTIFY_PLAYERS', message: 'Game is full! Starting...' },
            { type: 'POST_TWEET', content: 'Game starting! All players joined.' },
            { type: 'TRIGGER_SALVO' },
          ],
        };
      }

      return { newState: state, sideEffects };
    }

    case 'MAX_PLAYERS_REACHED': {
      return {
        newState: {
          status: 'active',
          round: 1,
          deadline: null,
          winners: [],
          cancelReason: null,
        },
        sideEffects: [
          { type: 'NOTIFY_PLAYERS', message: 'Game is full! Starting...' },
          { type: 'POST_TWEET', content: 'Game starting! All players joined.' },
          { type: 'TRIGGER_SALVO' },
        ],
      };
    }

    case 'DEADLINE_REACHED': {
      const activePlayers = players.filter(p => !p.isEliminated);

      if (activePlayers.length < 2) {
        // Not enough players - refund all
        return {
          newState: {
            status: 'cancelled',
            round: 0,
            deadline: null,
            winners: [],
            cancelReason: 'insufficient_players',
          },
          sideEffects: [
            { type: 'PROCESS_REFUNDS', wallets: players.map(p => p.wallet) },
            {
              type: 'NOTIFY_PLAYERS',
              message: 'Game cancelled - not enough players. Refunds processing.',
            },
          ],
        };
      }

      // Enough players - start game
      return {
        newState: {
          status: 'active',
          round: 1,
          deadline: null,
          winners: [],
          cancelReason: null,
        },
        sideEffects: [
          {
            type: 'NOTIFY_PLAYERS',
            message: `Game starting with ${activePlayers.length} players!`,
          },
          { type: 'POST_TWEET', content: `Game starting with ${activePlayers.length} players!` },
          { type: 'TRIGGER_SALVO' },
        ],
      };
    }

    case 'ADMIN_FORCE_START': {
      const activePlayers = players.filter(p => !p.isEliminated);

      if (activePlayers.length < 2) {
        throw new InvalidTransitionError(state.status, event);
      }

      return {
        newState: {
          status: 'active',
          round: 1,
          deadline: null,
          winners: [],
          cancelReason: null,
        },
        sideEffects: [
          {
            type: 'NOTIFY_PLAYERS',
            message: `Admin started game with ${activePlayers.length} players!`,
          },
          { type: 'TRIGGER_SALVO' },
        ],
      };
    }

    case 'ADMIN_CANCEL': {
      return {
        newState: {
          status: 'cancelled',
          round: 0,
          deadline: null,
          winners: [],
          cancelReason: 'admin_cancelled',
        },
        sideEffects: [
          { type: 'PROCESS_REFUNDS', wallets: players.map(p => p.wallet) },
          { type: 'NOTIFY_PLAYERS', message: 'Game cancelled by admin. Refunds processing.' },
        ],
      };
    }

    default:
      throw new InvalidTransitionError(state.status, event);
  }
}

function handleActive(
  state: GameState,
  event: GameEvent,
  config: GameConfig,
  players: PlayerState[]
): TransitionResult {
  switch (event.type) {
    case 'SALVO_COMPLETE': {
      const { survivors } = event;

      // Check win conditions
      if (survivors.length === 0) {
        // All eliminated - split pot among last round survivors
        const lastRoundSurvivors = players
          .filter(p => p.eliminatedRound === state.round || !p.isEliminated)
          .map(p => p.wallet);

        return {
          newState: {
            status: 'complete',
            round: state.round,
            deadline: null,
            winners: lastRoundSurvivors as WalletAddress[],
            cancelReason: null,
          },
          sideEffects: [
            { type: 'PROCESS_PAYOUTS', winners: lastRoundSurvivors as WalletAddress[] },
            {
              type: 'NOTIFY_PLAYERS',
              message: `Game over! All ships sunk in final salvo. Pot split among ${lastRoundSurvivors.length} players.`,
            },
            {
              type: 'POST_TWEET',
              content: `Game complete! Pot split among ${lastRoundSurvivors.length} survivors.`,
            },
          ],
        };
      }

      if (survivors.length === 1) {
        // Single winner
        return {
          newState: {
            status: 'complete',
            round: state.round,
            deadline: null,
            winners: survivors,
            cancelReason: null,
          },
          sideEffects: [
            { type: 'PROCESS_PAYOUTS', winners: survivors },
            {
              type: 'NOTIFY_PLAYERS',
              message: `Game over! Winner: ${survivors[0]}`,
            },
            { type: 'POST_TWEET', content: `We have a winner! Congratulations!` },
          ],
        };
      }

      // Check max rounds
      if (state.round >= config.maxRounds) {
        // Hit max rounds - split among survivors
        return {
          newState: {
            status: 'complete',
            round: state.round,
            deadline: null,
            winners: survivors,
            cancelReason: null,
          },
          sideEffects: [
            { type: 'PROCESS_PAYOUTS', winners: survivors },
            {
              type: 'NOTIFY_PLAYERS',
              message: `Max rounds reached! Pot split among ${survivors.length} survivors.`,
            },
            {
              type: 'POST_TWEET',
              content: `Game complete after ${config.maxRounds} rounds! ${survivors.length} survivors split the pot.`,
            },
          ],
        };
      }

      // Multiple survivors - go to repositioning
      const repositionDeadline = new Date(
        Date.now() + config.repositionWindowMinutes * 60 * 1000
      );

      return {
        newState: {
          status: 'repositioning',
          round: state.round,
          deadline: repositionDeadline,
          winners: [],
          cancelReason: null,
        },
        sideEffects: [
          {
            type: 'NOTIFY_PLAYERS',
            message: `Round ${state.round} complete! ${survivors.length} survivors. Reposition your ships!`,
            wallets: survivors,
          },
          {
            type: 'SCHEDULE_TIMEOUT',
            durationMs: config.repositionWindowMinutes * 60 * 1000,
            event: { type: 'REPOSITION_TIMEOUT' },
          },
        ],
      };
    }

    default:
      throw new InvalidTransitionError(state.status, event);
  }
}

function handleRepositioning(
  state: GameState,
  event: GameEvent,
  config: GameConfig,
  players: PlayerState[]
): TransitionResult {
  switch (event.type) {
    case 'REPOSITION_SUBMITTED': {
      // This is informational - check if all have repositioned
      const activePlayers = players.filter(p => !p.isEliminated);
      const allRepositioned = activePlayers.every(
        p => p.wallet === event.wallet || p.position.length > 0
      );

      if (allRepositioned) {
        // All repositioned - advance to next round
        return {
          newState: {
            status: 'active',
            round: state.round + 1,
            deadline: null,
            winners: [],
            cancelReason: null,
          },
          sideEffects: [
            {
              type: 'NOTIFY_PLAYERS',
              message: `All players repositioned! Round ${state.round + 1} starting...`,
            },
            { type: 'TRIGGER_SALVO' },
          ],
        };
      }

      // Still waiting for others
      return {
        newState: state,
        sideEffects: [
          {
            type: 'NOTIFY_PLAYERS',
            message: `${event.wallet} has repositioned.`,
          },
        ],
      };
    }

    case 'REPOSITION_TIMEOUT': {
      // Time's up - players who didn't reposition keep current positions
      return {
        newState: {
          status: 'active',
          round: state.round + 1,
          deadline: null,
          winners: [],
          cancelReason: null,
        },
        sideEffects: [
          {
            type: 'NOTIFY_PLAYERS',
            message: `Repositioning time up! Round ${state.round + 1} starting...`,
          },
          { type: 'TRIGGER_SALVO' },
        ],
      };
    }

    case 'ADMIN_CANCEL': {
      // Admin can cancel during repositioning - refund all
      return {
        newState: {
          status: 'cancelled',
          round: state.round,
          deadline: null,
          winners: [],
          cancelReason: 'admin_cancelled',
        },
        sideEffects: [
          { type: 'PROCESS_REFUNDS', wallets: players.map(p => p.wallet) },
          { type: 'NOTIFY_PLAYERS', message: 'Game cancelled by admin. Refunds processing.' },
        ],
      };
    }

    default:
      throw new InvalidTransitionError(state.status, event);
  }
}

/**
 * Create initial game state.
 */
export function createInitialState(): GameState {
  return {
    status: 'waiting',
    round: 0,
    deadline: null,
    winners: [],
    cancelReason: null,
  };
}

/**
 * Check if a transition is valid without performing it.
 */
export function canTransition(
  state: GameState,
  event: GameEvent,
  context: StateMachineContext
): boolean {
  try {
    transition(state, event, context);
    return true;
  } catch (e) {
    if (e instanceof InvalidTransitionError) {
      return false;
    }
    throw e;
  }
}
