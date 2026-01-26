-- Battle Dinghy ORE v2 Database Schema
-- SQLite with WAL mode for better concurrency

-- Games table
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  config TEXT NOT NULL, -- JSON GameConfig
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'repositioning', 'complete', 'cancelled')),
  round INTEGER NOT NULL DEFAULT 0,
  deadline TEXT,
  winners TEXT DEFAULT '[]', -- JSON array of wallet addresses
  cancel_reason TEXT CHECK (cancel_reason IN ('insufficient_players', 'admin_cancelled') OR cancel_reason IS NULL),
  tweet_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

-- Players table
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  twitter_handle TEXT,
  position TEXT NOT NULL, -- JSON array of cell indices
  hits TEXT NOT NULL DEFAULT '[]', -- JSON array of hit cell indices
  is_eliminated INTEGER NOT NULL DEFAULT 0,
  eliminated_round INTEGER,
  entry_tx TEXT NOT NULL,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(game_id, wallet_address)
);

-- Rounds table (records each salvo)
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL,
  ore_hash TEXT NOT NULL,
  shots TEXT NOT NULL, -- JSON array of cell indices
  eliminations TEXT NOT NULL DEFAULT '[]', -- JSON array of wallet addresses
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(game_id, round_number)
);

-- Transactions table (SOL movements)
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('entry', 'payout', 'refund')),
  amount_lamports INTEGER NOT NULL,
  signature TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT
);

-- ORE Mining Rounds table (tracks detailed per-round mining activity)
CREATE TABLE IF NOT EXISTS ore_mining_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL,
  squares_bitmask INTEGER NOT NULL, -- 32-bit mask for 25 squares
  deploy_lamports INTEGER NOT NULL, -- SOL deployed this round
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'deployed', 'checkpointed', 'claimed', 'failed')),

  -- Transaction signatures for audit trail
  tx_deploy TEXT,
  tx_checkpoint TEXT,
  tx_claim_sol TEXT,
  tx_claim_ore TEXT, -- Final round only

  -- Rewards earned this round
  sol_claimed_lamports INTEGER DEFAULT 0,
  ore_claimed INTEGER DEFAULT 0, -- ORE in smallest units

  -- Winning square info
  winning_square INTEGER, -- 0-24 index
  did_win INTEGER DEFAULT 0,

  -- Provably fair randomness audit
  used_fallback INTEGER DEFAULT 0, -- 1 if hash-based fallback used
  completed_round_id INTEGER, -- Actual ORE round ID from board PDA

  -- Timestamps
  deployed_at TEXT,
  checkpointed_at TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(game_id, round_number)
);

-- OAuth tokens table (stores Twitter OAuth 2.0 credentials)
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL UNIQUE, -- e.g., 'twitter'
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Verification tokens table (for Twitter handle verification before payment)
CREATE TABLE IF NOT EXISTS verification_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  twitter_handle TEXT NOT NULL,
  wallet_address TEXT, -- Set when token is used for payment
  used_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
CREATE INDEX IF NOT EXISTS idx_games_created_at ON games(created_at);
CREATE INDEX IF NOT EXISTS idx_players_game_id ON players(game_id);
CREATE INDEX IF NOT EXISTS idx_players_wallet ON players(wallet_address);
CREATE INDEX IF NOT EXISTS idx_rounds_game_id ON rounds(game_id);
CREATE INDEX IF NOT EXISTS idx_transactions_game_id ON transactions(game_id);
CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON transactions(wallet_address);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_ore_mining_rounds_game_id ON ore_mining_rounds(game_id);
CREATE INDEX IF NOT EXISTS idx_verification_tokens_token ON verification_tokens(token);
CREATE INDEX IF NOT EXISTS idx_verification_tokens_game_id ON verification_tokens(game_id);
