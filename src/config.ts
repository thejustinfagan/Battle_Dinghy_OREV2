import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function optional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const config = {
  port: parseInt(optional('PORT', '3000'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),

  database: {
    path: optional('DATABASE_PATH', './data/battle-dinghy.db'),
  },

  solana: {
    rpcUrl: optional('SOLANA_RPC_URL', 'https://api.devnet.solana.com'),
    escrowPrivateKey: process.env.ESCROW_PRIVATE_KEY,
    escrowPublicKey: process.env.ESCROW_WALLET_PUBLIC_KEY,
  },

  twitter: {
    // OAuth 2.0 credentials (preferred)
    clientId: process.env.TWITTER_CLIENT_ID,
    clientSecret: process.env.TWITTER_CLIENT_SECRET,
    // OAuth 1.0a credentials (legacy)
    apiKey: process.env.TWITTER_API_KEY,
    apiSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
    handle: optional('TWITTER_HANDLE', 'battle_dinghy'),
    get enabled() {
      // Either OAuth 2.0 or OAuth 1.0a credentials
      return !!(this.clientId && this.clientSecret) || !!(this.apiKey && this.apiSecret);
    },
  },

  admin: {
    apiKey: optional('ADMIN_API_KEY', 'dev-admin-key'),
  },

  features: {
    useRealOre: optional('USE_REAL_ORE', 'false') === 'true',
    platformFeePercent: parseInt(optional('PLATFORM_FEE_PERCENT', '5'), 10),
  },
} as const;
