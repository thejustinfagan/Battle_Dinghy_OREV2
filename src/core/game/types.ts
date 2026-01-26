// Branded types for type safety
declare const GameIdBrand: unique symbol;
export type GameId = string & { readonly [GameIdBrand]: never };

declare const WalletAddressBrand: unique symbol;
export type WalletAddress = string & { readonly [WalletAddressBrand]: never };

declare const TxSignatureBrand: unique symbol;
export type TxSignature = string & { readonly [TxSignatureBrand]: never };

// Cell index 0-24 for 5x5 grid
export type CellIndex = 0|1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|23|24;

export type ShipSize = 1 | 2 | 3;

export interface GameConfig {
  entryFeeLamports: number;
  maxPlayers: number;
  shipSize: ShipSize;
  shotsPerSalvo: number;
  fillDeadlineMinutes: number;
  repositionWindowMinutes: number;
  maxRounds: number;
}

export type GameStatus = 'waiting' | 'active' | 'repositioning' | 'complete' | 'cancelled';

export type CancelReason = 'insufficient_players' | 'admin_cancelled';

export interface GameState {
  status: GameStatus;
  round: number;
  deadline: Date | null;
  winners: WalletAddress[];
  cancelReason: CancelReason | null;
}

export interface PlayerState {
  wallet: WalletAddress;
  twitterHandle: string | null;
  position: CellIndex[];
  hits: CellIndex[];
  isEliminated: boolean;
  eliminatedRound: number | null;
}

export type GameEvent =
  | { type: 'PLAYER_JOINED'; wallet: WalletAddress; position: CellIndex[] }
  | { type: 'DEADLINE_REACHED' }
  | { type: 'MAX_PLAYERS_REACHED' }
  | { type: 'SALVO_COMPLETE'; oreHash: string; survivors: WalletAddress[] }
  | { type: 'REPOSITION_SUBMITTED'; wallet: WalletAddress; position: CellIndex[] }
  | { type: 'REPOSITION_TIMEOUT' }
  | { type: 'ADMIN_CANCEL' }
  | { type: 'ADMIN_FORCE_START' };

export type SideEffect =
  | { type: 'NOTIFY_PLAYERS'; message: string; wallets?: WalletAddress[] }
  | { type: 'PROCESS_PAYOUTS'; winners: WalletAddress[] }
  | { type: 'PROCESS_REFUNDS'; wallets: WalletAddress[] }
  | { type: 'SCHEDULE_TIMEOUT'; durationMs: number; event: GameEvent }
  | { type: 'POST_TWEET'; content: string }
  | { type: 'TRIGGER_SALVO' };

export interface TransitionResult {
  newState: GameState;
  sideEffects: SideEffect[];
}

export interface RoundResult {
  roundNumber: number;
  oreHash: string;
  shots: CellIndex[];
  eliminations: WalletAddress[];
  timestamp: Date;
}

// Factory functions
export function createGameId(): GameId {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `BD-${ts}${rand}` as GameId;
}

export function parseGameId(id: string): GameId {
  if (!/^BD-[A-Z0-9]+$/.test(id)) {
    throw new Error(`Invalid game ID: ${id}`);
  }
  return id as GameId;
}

export function parseWalletAddress(addr: string): WalletAddress {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) {
    throw new Error(`Invalid wallet address: ${addr}`);
  }
  return addr as WalletAddress;
}

export function toCellIndex(n: number): CellIndex {
  if (!Number.isInteger(n) || n < 0 || n > 24) {
    throw new Error(`Invalid cell index: ${n}`);
  }
  return n as CellIndex;
}

export function isValidCellIndex(n: number): n is CellIndex {
  return Number.isInteger(n) && n >= 0 && n <= 24;
}
