import { describe, it, expect } from 'vitest';
import {
  transition,
  createInitialState,
  InvalidTransitionError,
  StateMachineContext,
} from '../../src/core/game/state-machine.js';
import {
  GameConfig,
  GameState,
  GameEvent,
  PlayerState,
  WalletAddress,
  CellIndex,
  toCellIndex,
} from '../../src/core/game/types.js';

const defaultConfig: GameConfig = {
  entryFeeLamports: 100000000,
  maxPlayers: 4,
  shipSize: 2,
  shotsPerSalvo: 5,
  fillDeadlineMinutes: 30,
  repositionWindowMinutes: 5,
  maxRounds: 10,
};

const createPlayer = (
  wallet: string,
  position: number[] = [0, 1],
  isEliminated = false,
  eliminatedRound: number | null = null
): PlayerState => ({
  wallet: wallet as WalletAddress,
  twitterHandle: null,
  position: position.map(toCellIndex) as CellIndex[],
  hits: [],
  isEliminated,
  eliminatedRound,
});

const createContext = (players: PlayerState[] = []): StateMachineContext => ({
  config: defaultConfig,
  players,
});

describe('createInitialState', () => {
  it('creates waiting state', () => {
    const state = createInitialState();
    expect(state.status).toBe('waiting');
    expect(state.round).toBe(0);
    expect(state.winners).toEqual([]);
  });
});

describe('waiting state transitions', () => {
  it('handles PLAYER_JOINED without filling game', () => {
    const state = createInitialState();
    const players = [createPlayer('p1'), createPlayer('p2')];
    const context = createContext(players);

    const result = transition(
      state,
      { type: 'PLAYER_JOINED', wallet: 'p3' as WalletAddress, position: [0, 1] as CellIndex[] },
      context
    );

    expect(result.newState.status).toBe('waiting');
    expect(result.sideEffects).toContainEqual(
      expect.objectContaining({ type: 'NOTIFY_PLAYERS' })
    );
  });

  it('starts game when max players reached via PLAYER_JOINED', () => {
    const state = createInitialState();
    const players = [createPlayer('p1'), createPlayer('p2'), createPlayer('p3')];
    const context = createContext(players);

    const result = transition(
      state,
      { type: 'PLAYER_JOINED', wallet: 'p4' as WalletAddress, position: [0, 1] as CellIndex[] },
      context
    );

    expect(result.newState.status).toBe('active');
    expect(result.newState.round).toBe(1);
    expect(result.sideEffects).toContainEqual(
      expect.objectContaining({ type: 'TRIGGER_SALVO' })
    );
  });

  it('starts game on MAX_PLAYERS_REACHED', () => {
    const state = createInitialState();
    const players = [createPlayer('p1'), createPlayer('p2'), createPlayer('p3'), createPlayer('p4')];
    const context = createContext(players);

    const result = transition(state, { type: 'MAX_PLAYERS_REACHED' }, context);

    expect(result.newState.status).toBe('active');
  });

  it('cancels game on DEADLINE_REACHED with < 2 players', () => {
    const state = createInitialState();
    const players = [createPlayer('p1')];
    const context = createContext(players);

    const result = transition(state, { type: 'DEADLINE_REACHED' }, context);

    expect(result.newState.status).toBe('cancelled');
    expect(result.newState.cancelReason).toBe('insufficient_players');
    expect(result.sideEffects).toContainEqual(
      expect.objectContaining({ type: 'PROCESS_REFUNDS' })
    );
  });

  it('starts game on DEADLINE_REACHED with 2+ players', () => {
    const state = createInitialState();
    const players = [createPlayer('p1'), createPlayer('p2')];
    const context = createContext(players);

    const result = transition(state, { type: 'DEADLINE_REACHED' }, context);

    expect(result.newState.status).toBe('active');
    expect(result.newState.round).toBe(1);
  });

  it('handles ADMIN_FORCE_START with enough players', () => {
    const state = createInitialState();
    const players = [createPlayer('p1'), createPlayer('p2')];
    const context = createContext(players);

    const result = transition(state, { type: 'ADMIN_FORCE_START' }, context);

    expect(result.newState.status).toBe('active');
  });

  it('rejects ADMIN_FORCE_START with < 2 players', () => {
    const state = createInitialState();
    const players = [createPlayer('p1')];
    const context = createContext(players);

    expect(() => transition(state, { type: 'ADMIN_FORCE_START' }, context)).toThrow(
      InvalidTransitionError
    );
  });

  it('handles ADMIN_CANCEL', () => {
    const state = createInitialState();
    const players = [createPlayer('p1')];
    const context = createContext(players);

    const result = transition(state, { type: 'ADMIN_CANCEL' }, context);

    expect(result.newState.status).toBe('cancelled');
    expect(result.newState.cancelReason).toBe('admin_cancelled');
    expect(result.sideEffects).toContainEqual(
      expect.objectContaining({ type: 'PROCESS_REFUNDS' })
    );
  });
});

describe('active state transitions', () => {
  const activeState: GameState = {
    status: 'active',
    round: 1,
    deadline: null,
    winners: [],
    cancelReason: null,
  };

  it('completes game with single winner', () => {
    const players = [
      createPlayer('p1'),
      createPlayer('p2', [5, 6], true, 1),
    ];
    const context = createContext(players);

    const result = transition(
      activeState,
      { type: 'SALVO_COMPLETE', oreHash: 'abc', survivors: ['p1' as WalletAddress] },
      context
    );

    expect(result.newState.status).toBe('complete');
    expect(result.newState.winners).toEqual(['p1']);
    expect(result.sideEffects).toContainEqual(
      expect.objectContaining({ type: 'PROCESS_PAYOUTS', winners: ['p1'] })
    );
  });

  it('splits pot when all eliminated in same round', () => {
    const players = [
      createPlayer('p1', [0, 1], true, 1),
      createPlayer('p2', [5, 6], true, 1),
    ];
    const context = createContext(players);

    const result = transition(
      activeState,
      { type: 'SALVO_COMPLETE', oreHash: 'abc', survivors: [] },
      context
    );

    expect(result.newState.status).toBe('complete');
    expect(result.newState.winners).toContain('p1');
    expect(result.newState.winners).toContain('p2');
  });

  it('goes to repositioning with multiple survivors', () => {
    const players = [createPlayer('p1'), createPlayer('p2')];
    const context = createContext(players);

    const result = transition(
      activeState,
      { type: 'SALVO_COMPLETE', oreHash: 'abc', survivors: ['p1' as WalletAddress, 'p2' as WalletAddress] },
      context
    );

    expect(result.newState.status).toBe('repositioning');
    expect(result.newState.deadline).not.toBeNull();
    expect(result.sideEffects).toContainEqual(
      expect.objectContaining({ type: 'SCHEDULE_TIMEOUT' })
    );
  });

  it('ends game at max rounds', () => {
    const maxRoundState: GameState = { ...activeState, round: 10 };
    const players = [createPlayer('p1'), createPlayer('p2')];
    const context = createContext(players);

    const result = transition(
      maxRoundState,
      { type: 'SALVO_COMPLETE', oreHash: 'abc', survivors: ['p1' as WalletAddress, 'p2' as WalletAddress] },
      context
    );

    expect(result.newState.status).toBe('complete');
    expect(result.newState.winners).toEqual(['p1', 'p2']);
  });

  it('rejects invalid events', () => {
    const context = createContext([]);

    expect(() => transition(activeState, { type: 'PLAYER_JOINED', wallet: 'p1' as WalletAddress, position: [] }, context)).toThrow(
      InvalidTransitionError
    );
  });
});

describe('repositioning state transitions', () => {
  const repoState: GameState = {
    status: 'repositioning',
    round: 1,
    deadline: new Date(Date.now() + 300000),
    winners: [],
    cancelReason: null,
  };

  it('advances round on REPOSITION_TIMEOUT', () => {
    const players = [createPlayer('p1'), createPlayer('p2')];
    const context = createContext(players);

    const result = transition(repoState, { type: 'REPOSITION_TIMEOUT' }, context);

    expect(result.newState.status).toBe('active');
    expect(result.newState.round).toBe(2);
    expect(result.sideEffects).toContainEqual(
      expect.objectContaining({ type: 'TRIGGER_SALVO' })
    );
  });

  it('handles REPOSITION_SUBMITTED', () => {
    const players = [createPlayer('p1'), createPlayer('p2')];
    const context = createContext(players);

    const result = transition(
      repoState,
      { type: 'REPOSITION_SUBMITTED', wallet: 'p1' as WalletAddress, position: [10, 11] as CellIndex[] },
      context
    );

    expect(result.sideEffects).toContainEqual(
      expect.objectContaining({ type: 'NOTIFY_PLAYERS' })
    );
  });

  it('handles ADMIN_CANCEL', () => {
    const players = [createPlayer('p1'), createPlayer('p2')];
    const context = createContext(players);

    const result = transition(repoState, { type: 'ADMIN_CANCEL' }, context);

    expect(result.newState.status).toBe('cancelled');
    expect(result.sideEffects).toContainEqual(
      expect.objectContaining({ type: 'PROCESS_REFUNDS' })
    );
  });
});

describe('terminal states', () => {
  it('rejects transitions from complete', () => {
    const completeState: GameState = {
      status: 'complete',
      round: 3,
      deadline: null,
      winners: ['p1' as WalletAddress],
      cancelReason: null,
    };
    const context = createContext([]);

    expect(() => transition(completeState, { type: 'ADMIN_CANCEL' }, context)).toThrow(
      InvalidTransitionError
    );
  });

  it('rejects transitions from cancelled', () => {
    const cancelledState: GameState = {
      status: 'cancelled',
      round: 0,
      deadline: null,
      winners: [],
      cancelReason: 'admin_cancelled',
    };
    const context = createContext([]);

    expect(() => transition(cancelledState, { type: 'ADMIN_CANCEL' }, context)).toThrow(
      InvalidTransitionError
    );
  });
});
