import { getDatabase, saveDatabase, transaction } from './connection.js';
import {
  GameId, GameState, GameConfig, WalletAddress, CellIndex,
  parseGameId, parseWalletAddress, toCellIndex,
} from '../core/game/types.js';

// ============================================
// TYPES
// ============================================

export interface GameRecord {
  id: GameId;
  status: GameState['status'];
  config: GameConfig;
  round: number;
  deadline: Date | null;
  winners: WalletAddress[];
  cancelReason: string | null;
  tweetId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface PlayerRecord {
  id: number;
  gameId: GameId;
  wallet: WalletAddress;
  twitterHandle: string | null;
  position: CellIndex[];
  hits: CellIndex[];
  isEliminated: boolean;
  eliminatedRound: number | null;
  entryTx: string;
  joinedAt: Date;
}

export interface RoundRecord {
  id: number;
  gameId: GameId;
  roundNumber: number;
  oreHash: string;
  shots: CellIndex[];
  eliminations: WalletAddress[];
  createdAt: Date;
}

export interface TransactionRecord {
  id: number;
  gameId: GameId;
  wallet: WalletAddress;
  type: 'entry' | 'payout' | 'refund';
  amountLamports: number;
  signature: string | null;
  status: 'pending' | 'confirmed' | 'failed';
  error: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
}

// ============================================
// HELPER FUNCTIONS FOR SQL.JS
// ============================================

function queryOne<T>(sql: string, params: unknown[] = []): T | null {
  const db = getDatabase();
  const stmt = db.prepare(sql);
  stmt.bind(params as any[]);
  if (stmt.step()) {
    const result = stmt.getAsObject() as T;
    stmt.free();
    return result;
  }
  stmt.free();
  return null;
}

function queryAll<T>(sql: string, params: unknown[] = []): T[] {
  const db = getDatabase();
  const stmt = db.prepare(sql);
  stmt.bind(params as any[]);
  const results: T[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return results;
}

function execute(sql: string, params: unknown[] = []): void {
  const db = getDatabase();
  db.run(sql, params as any[]);
  saveDatabase();
}

// ============================================
// GAME REPOSITORY
// ============================================

export function createGame(id: GameId, config: GameConfig, deadline: Date): GameRecord {
  execute(
    `INSERT INTO games (id, config, deadline) VALUES (?, ?, ?)`,
    [id, JSON.stringify(config), deadline.toISOString()]
  );
  return getGame(id)!;
}

export function getGame(id: GameId): GameRecord | null {
  const row = queryOne<any>('SELECT * FROM games WHERE id = ?', [id]);
  if (!row) return null;

  return {
    id: parseGameId(row.id),
    status: row.status,
    config: JSON.parse(row.config),
    round: row.round,
    deadline: row.deadline ? new Date(row.deadline) : null,
    winners: row.winners ? JSON.parse(row.winners).map(parseWalletAddress) : [],
    cancelReason: row.cancel_reason,
    tweetId: row.tweet_id,
    createdAt: new Date(row.created_at),
    startedAt: row.started_at ? new Date(row.started_at) : null,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
  };
}

export function getGamesByStatus(statuses: GameState['status'][]): GameRecord[] {
  const placeholders = statuses.map(() => '?').join(',');
  const rows = queryAll<any>(
    `SELECT * FROM games WHERE status IN (${placeholders}) ORDER BY created_at DESC`,
    statuses
  );
  return rows.map(row => ({
    id: parseGameId(row.id),
    status: row.status,
    config: JSON.parse(row.config),
    round: row.round,
    deadline: row.deadline ? new Date(row.deadline) : null,
    winners: row.winners ? JSON.parse(row.winners).map(parseWalletAddress) : [],
    cancelReason: row.cancel_reason,
    tweetId: row.tweet_id,
    createdAt: new Date(row.created_at),
    startedAt: row.started_at ? new Date(row.started_at) : null,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
  }));
}

export function updateGameState(id: GameId, state: Partial<GameState>): void {
  const updates: string[] = [];
  const values: any[] = [];

  if (state.status !== undefined) {
    updates.push('status = ?');
    values.push(state.status);
    if (state.status === 'active') {
      updates.push('started_at = datetime("now")');
    }
    if (state.status === 'complete' || state.status === 'cancelled') {
      updates.push('completed_at = datetime("now")');
    }
  }
  if (state.round !== undefined) {
    updates.push('round = ?');
    values.push(state.round);
  }
  if (state.deadline !== undefined) {
    updates.push('deadline = ?');
    values.push(state.deadline?.toISOString() ?? null);
  }
  if (state.winners !== undefined) {
    updates.push('winners = ?');
    values.push(JSON.stringify(state.winners));
  }
  if (state.cancelReason !== undefined) {
    updates.push('cancel_reason = ?');
    values.push(state.cancelReason);
  }

  if (updates.length === 0) return;
  values.push(id);
  execute(`UPDATE games SET ${updates.join(', ')} WHERE id = ?`, values);
}

export function updateGameTweetId(id: GameId, tweetId: string): void {
  execute('UPDATE games SET tweet_id = ? WHERE id = ?', [tweetId, id]);
}

// ============================================
// PLAYER REPOSITORY
// ============================================

export interface AddPlayerInput {
  wallet: WalletAddress;
  twitterHandle: string | null;
  position: CellIndex[];
  entryTx: string;
}

export function addPlayer(gameId: GameId, input: AddPlayerInput): PlayerRecord {
  return transaction(() => {
    const game = getGame(gameId);
    if (!game) throw new Error('Game not found');
    if (game.status !== 'waiting') throw new Error('Game not accepting players');

    const countRow = queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM players WHERE game_id = ?',
      [gameId]
    );
    if (countRow && countRow.count >= game.config.maxPlayers) {
      throw new Error('Game is full');
    }

    const existing = queryOne<any>(
      'SELECT id FROM players WHERE game_id = ? AND wallet_address = ?',
      [gameId, input.wallet]
    );
    if (existing) throw new Error('Already joined');

    execute(
      `INSERT INTO players (game_id, wallet_address, twitter_handle, position, entry_tx) VALUES (?, ?, ?, ?, ?)`,
      [gameId, input.wallet, input.twitterHandle, JSON.stringify(input.position), input.entryTx]
    );
    return getPlayer(gameId, input.wallet)!;
  });
}

export function getPlayer(gameId: GameId, wallet: WalletAddress): PlayerRecord | null {
  const row = queryOne<any>(
    'SELECT * FROM players WHERE game_id = ? AND wallet_address = ?',
    [gameId, wallet]
  );
  if (!row) return null;
  return {
    id: row.id,
    gameId: parseGameId(row.game_id),
    wallet: parseWalletAddress(row.wallet_address),
    twitterHandle: row.twitter_handle,
    position: JSON.parse(row.position).map(toCellIndex),
    hits: JSON.parse(row.hits).map(toCellIndex),
    isEliminated: row.is_eliminated === 1,
    eliminatedRound: row.eliminated_round,
    entryTx: row.entry_tx,
    joinedAt: new Date(row.joined_at),
  };
}

export function getPlayers(gameId: GameId): PlayerRecord[] {
  const rows = queryAll<any>(
    'SELECT * FROM players WHERE game_id = ? ORDER BY joined_at',
    [gameId]
  );
  return rows.map(row => ({
    id: row.id,
    gameId: parseGameId(row.game_id),
    wallet: parseWalletAddress(row.wallet_address),
    twitterHandle: row.twitter_handle,
    position: JSON.parse(row.position).map(toCellIndex),
    hits: JSON.parse(row.hits).map(toCellIndex),
    isEliminated: row.is_eliminated === 1,
    eliminatedRound: row.eliminated_round,
    entryTx: row.entry_tx,
    joinedAt: new Date(row.joined_at),
  }));
}

export function getActivePlayers(gameId: GameId): PlayerRecord[] {
  return getPlayers(gameId).filter(p => !p.isEliminated);
}

export function updatePlayerPosition(gameId: GameId, wallet: WalletAddress, position: CellIndex[]): void {
  execute(
    'UPDATE players SET position = ? WHERE game_id = ? AND wallet_address = ?',
    [JSON.stringify(position), gameId, wallet]
  );
}

export function updatePlayerHits(gameId: GameId, wallet: WalletAddress, hits: CellIndex[]): void {
  execute(
    'UPDATE players SET hits = ? WHERE game_id = ? AND wallet_address = ?',
    [JSON.stringify(hits), gameId, wallet]
  );
}

export function eliminatePlayer(gameId: GameId, wallet: WalletAddress, round: number): void {
  execute(
    'UPDATE players SET is_eliminated = 1, eliminated_round = ? WHERE game_id = ? AND wallet_address = ?',
    [round, gameId, wallet]
  );
}

export function countPlayers(gameId: GameId): number {
  const row = queryOne<{ count: number }>(
    'SELECT COUNT(*) as count FROM players WHERE game_id = ?',
    [gameId]
  );
  return row?.count ?? 0;
}

// ============================================
// ROUND REPOSITORY
// ============================================

export function addRound(
  gameId: GameId,
  roundNumber: number,
  oreHash: string,
  shots: CellIndex[],
  eliminations: WalletAddress[]
): RoundRecord {
  execute(
    `INSERT INTO rounds (game_id, round_number, ore_hash, shots, eliminations) VALUES (?, ?, ?, ?, ?)`,
    [gameId, roundNumber, oreHash, JSON.stringify(shots), JSON.stringify(eliminations)]
  );
  return getRound(gameId, roundNumber)!;
}

export function getRound(gameId: GameId, roundNumber: number): RoundRecord | null {
  const row = queryOne<any>(
    'SELECT * FROM rounds WHERE game_id = ? AND round_number = ?',
    [gameId, roundNumber]
  );
  if (!row) return null;
  return {
    id: row.id,
    gameId: parseGameId(row.game_id),
    roundNumber: row.round_number,
    oreHash: row.ore_hash,
    shots: JSON.parse(row.shots).map(toCellIndex),
    eliminations: JSON.parse(row.eliminations).map(parseWalletAddress),
    createdAt: new Date(row.created_at),
  };
}

export function getRounds(gameId: GameId): RoundRecord[] {
  const rows = queryAll<any>(
    'SELECT * FROM rounds WHERE game_id = ? ORDER BY round_number',
    [gameId]
  );
  return rows.map(row => ({
    id: row.id,
    gameId: parseGameId(row.game_id),
    roundNumber: row.round_number,
    oreHash: row.ore_hash,
    shots: JSON.parse(row.shots).map(toCellIndex),
    eliminations: JSON.parse(row.eliminations).map(parseWalletAddress),
    createdAt: new Date(row.created_at),
  }));
}

// ============================================
// TRANSACTION REPOSITORY
// ============================================

export function recordTransaction(
  gameId: GameId,
  wallet: WalletAddress,
  type: 'entry' | 'payout' | 'refund',
  amountLamports: number,
  signature?: string
): TransactionRecord {
  const status = signature ? 'confirmed' : 'pending';
  execute(
    `INSERT INTO transactions (game_id, wallet_address, type, amount_lamports, signature, status) VALUES (?, ?, ?, ?, ?, ?)`,
    [gameId, wallet, type, amountLamports, signature ?? null, status]
  );

  // Get the last inserted row
  const row = queryOne<any>(
    'SELECT * FROM transactions WHERE game_id = ? AND wallet_address = ? AND type = ? ORDER BY id DESC LIMIT 1',
    [gameId, wallet, type]
  );
  return {
    id: row.id,
    gameId: parseGameId(row.game_id),
    wallet: parseWalletAddress(row.wallet_address),
    type: row.type,
    amountLamports: row.amount_lamports,
    signature: row.signature,
    status: row.status,
    error: row.error,
    createdAt: new Date(row.created_at),
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : null,
  };
}

export function updateTransactionStatus(
  id: number,
  status: 'confirmed' | 'failed',
  signature?: string,
  error?: string
): void {
  execute(
    `UPDATE transactions SET status = ?, signature = COALESCE(?, signature), error = ?, confirmed_at = CASE WHEN ? = 'confirmed' THEN datetime('now') ELSE confirmed_at END WHERE id = ?`,
    [status, signature ?? null, error ?? null, status, id]
  );
}

export function getGameTransactions(gameId: GameId): TransactionRecord[] {
  const rows = queryAll<any>(
    'SELECT * FROM transactions WHERE game_id = ? ORDER BY created_at',
    [gameId]
  );
  return rows.map(row => ({
    id: row.id,
    gameId: parseGameId(row.game_id),
    wallet: parseWalletAddress(row.wallet_address),
    type: row.type,
    amountLamports: row.amount_lamports,
    signature: row.signature,
    status: row.status,
    error: row.error,
    createdAt: new Date(row.created_at),
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : null,
  }));
}

export function getPendingPayouts(): TransactionRecord[] {
  const rows = queryAll<any>(
    "SELECT * FROM transactions WHERE type IN ('payout', 'refund') AND status = 'pending'",
    []
  );
  return rows.map(row => ({
    id: row.id,
    gameId: parseGameId(row.game_id),
    wallet: parseWalletAddress(row.wallet_address),
    type: row.type,
    amountLamports: row.amount_lamports,
    signature: row.signature,
    status: row.status,
    error: row.error,
    createdAt: new Date(row.created_at),
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at) : null,
  }));
}

// ============================================
// OAUTH TOKEN REPOSITORY
// ============================================

export interface OAuthTokenRecord {
  id: number;
  provider: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

export function getOAuthToken(provider: string): OAuthTokenRecord | null {
  const row = queryOne<any>(
    'SELECT * FROM oauth_tokens WHERE provider = ?',
    [provider]
  );
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
  };
}

export function upsertOAuthToken(
  provider: string,
  accessToken: string,
  refreshToken?: string,
  expiresAt?: Date
): void {
  const existing = getOAuthToken(provider);
  if (existing) {
    execute(
      'UPDATE oauth_tokens SET access_token = ?, refresh_token = ?, expires_at = ? WHERE provider = ?',
      [accessToken, refreshToken ?? null, expiresAt?.toISOString() ?? null, provider]
    );
  } else {
    execute(
      'INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?)',
      [provider, accessToken, refreshToken ?? null, expiresAt?.toISOString() ?? null]
    );
  }
}

export function deleteOAuthToken(provider: string): void {
  execute('DELETE FROM oauth_tokens WHERE provider = ?', [provider]);
}

// ============================================
// VERIFICATION TOKEN REPOSITORY
// ============================================

export interface VerificationTokenRecord {
  id: number;
  gameId: string;
  token: string;
  twitterHandle: string;
  walletAddress: string | null;
  usedAt: Date | null;
  expiresAt: Date;
}

export interface CreateVerificationTokenInput {
  gameId: string;
  token: string;
  twitterHandle: string;
  expiresAt: string;
}

export function createVerificationToken(input: CreateVerificationTokenInput): VerificationTokenRecord {
  execute(
    'INSERT INTO verification_tokens (game_id, token, twitter_handle, expires_at) VALUES (?, ?, ?, ?)',
    [input.gameId, input.token, input.twitterHandle, input.expiresAt]
  );
  return getVerificationToken(input.token)!;
}

export function getVerificationToken(token: string): VerificationTokenRecord | null {
  const row = queryOne<any>(
    'SELECT * FROM verification_tokens WHERE token = ?',
    [token]
  );
  if (!row) return null;
  return {
    id: row.id,
    gameId: row.game_id,
    token: row.token,
    twitterHandle: row.twitter_handle,
    walletAddress: row.wallet_address,
    usedAt: row.used_at ? new Date(row.used_at) : null,
    expiresAt: new Date(row.expires_at),
  };
}

export function markVerificationTokenUsed(token: string, walletAddress: string): void {
  execute(
    'UPDATE verification_tokens SET used_at = datetime("now"), wallet_address = ? WHERE token = ?',
    [walletAddress, token]
  );
}

export function getAllVerificationTokens(): VerificationTokenRecord[] {
  const rows = queryAll<any>(
    'SELECT * FROM verification_tokens ORDER BY id DESC',
    []
  );
  return rows.map(row => ({
    id: row.id,
    gameId: row.game_id,
    token: row.token,
    twitterHandle: row.twitter_handle,
    walletAddress: row.wallet_address,
    usedAt: row.used_at ? new Date(row.used_at) : null,
    expiresAt: new Date(row.expires_at),
  }));
}

export function getVerificationTokensByGame(gameId: string): VerificationTokenRecord[] {
  const rows = queryAll<any>(
    'SELECT * FROM verification_tokens WHERE game_id = ? ORDER BY id DESC',
    [gameId]
  );
  return rows.map(row => ({
    id: row.id,
    gameId: row.game_id,
    token: row.token,
    twitterHandle: row.twitter_handle,
    walletAddress: row.wallet_address,
    usedAt: row.used_at ? new Date(row.used_at) : null,
    expiresAt: new Date(row.expires_at),
  }));
}

// ============================================
// ORE MINING ROUND REPOSITORY
// ============================================

export interface OreMiningRoundRecord {
  id: number;
  gameId: string;
  roundNumber: number;
  squaresBitmask: number;
  deployLamports: number;
  status: 'pending' | 'deploying' | 'checkpoint' | 'claiming' | 'complete' | 'failed';
  txDeploy: string | null;
  txCheckpoint: string | null;
  txClaimSol: string | null;
  txClaimOre: string | null;
  solClaimedLamports: number;
  winningSquare: number | null;
  usedFallback: boolean;
  completedRoundId: number | null;
  createdAt: Date;
}

export interface CreateOreMiningRoundInput {
  gameId: string;
  roundNumber: number;
  squaresBitmask: number;
  deployLamports: number;
}

export function createOreMiningRound(input: CreateOreMiningRoundInput): OreMiningRoundRecord {
  execute(
    'INSERT INTO ore_mining_rounds (game_id, round_number, squares_bitmask, deploy_lamports) VALUES (?, ?, ?, ?)',
    [input.gameId, input.roundNumber, input.squaresBitmask, input.deployLamports]
  );
  return getOreMiningRound(input.gameId, input.roundNumber)!;
}

export function getOreMiningRound(gameId: string, roundNumber: number): OreMiningRoundRecord | null {
  const row = queryOne<any>(
    'SELECT * FROM ore_mining_rounds WHERE game_id = ? AND round_number = ?',
    [gameId, roundNumber]
  );
  if (!row) return null;
  return {
    id: row.id,
    gameId: row.game_id,
    roundNumber: row.round_number,
    squaresBitmask: row.squares_bitmask,
    deployLamports: row.deploy_lamports,
    status: row.status,
    txDeploy: row.tx_deploy,
    txCheckpoint: row.tx_checkpoint,
    txClaimSol: row.tx_claim_sol,
    txClaimOre: row.tx_claim_ore,
    solClaimedLamports: row.sol_claimed_lamports,
    winningSquare: row.winning_square,
    usedFallback: row.used_fallback === 1,
    completedRoundId: row.completed_round_id,
    createdAt: new Date(row.created_at),
  };
}

export function getOreMiningRounds(gameId: string): OreMiningRoundRecord[] {
  const rows = queryAll<any>(
    'SELECT * FROM ore_mining_rounds WHERE game_id = ? ORDER BY round_number',
    [gameId]
  );
  return rows.map(row => ({
    id: row.id,
    gameId: row.game_id,
    roundNumber: row.round_number,
    squaresBitmask: row.squares_bitmask,
    deployLamports: row.deploy_lamports,
    status: row.status,
    txDeploy: row.tx_deploy,
    txCheckpoint: row.tx_checkpoint,
    txClaimSol: row.tx_claim_sol,
    txClaimOre: row.tx_claim_ore,
    solClaimedLamports: row.sol_claimed_lamports,
    winningSquare: row.winning_square,
    usedFallback: row.used_fallback === 1,
    completedRoundId: row.completed_round_id,
    createdAt: new Date(row.created_at),
  }));
}

export function updateOreMiningRoundStatus(
  gameId: string,
  roundNumber: number,
  status: OreMiningRoundRecord['status']
): void {
  execute(
    'UPDATE ore_mining_rounds SET status = ? WHERE game_id = ? AND round_number = ?',
    [status, gameId, roundNumber]
  );
}

export function updateOreMiningRoundTx(
  gameId: string,
  roundNumber: number,
  txType: 'deploy' | 'checkpoint' | 'claim_sol' | 'claim_ore',
  txSignature: string
): void {
  const column = `tx_${txType}`;
  execute(
    `UPDATE ore_mining_rounds SET ${column} = ? WHERE game_id = ? AND round_number = ?`,
    [txSignature, gameId, roundNumber]
  );
}

export function updateOreMiningRoundResult(
  gameId: string,
  roundNumber: number,
  winningSquare: number,
  solClaimedLamports: number,
  completedRoundId: number,
  usedFallback: boolean
): void {
  execute(
    'UPDATE ore_mining_rounds SET winning_square = ?, sol_claimed_lamports = ?, completed_round_id = ?, used_fallback = ?, status = ? WHERE game_id = ? AND round_number = ?',
    [winningSquare, solClaimedLamports, completedRoundId, usedFallback ? 1 : 0, 'complete', gameId, roundNumber]
  );
}

export function getPendingOreMiningRounds(): OreMiningRoundRecord[] {
  const rows = queryAll<any>(
    "SELECT * FROM ore_mining_rounds WHERE status NOT IN ('complete', 'failed') ORDER BY created_at",
    []
  );
  return rows.map(row => ({
    id: row.id,
    gameId: row.game_id,
    roundNumber: row.round_number,
    squaresBitmask: row.squares_bitmask,
    deployLamports: row.deploy_lamports,
    status: row.status,
    txDeploy: row.tx_deploy,
    txCheckpoint: row.tx_checkpoint,
    txClaimSol: row.tx_claim_sol,
    txClaimOre: row.tx_claim_ore,
    solClaimedLamports: row.sol_claimed_lamports,
    winningSquare: row.winning_square,
    usedFallback: row.used_fallback === 1,
    completedRoundId: row.completed_round_id,
    createdAt: new Date(row.created_at),
  }));
}
