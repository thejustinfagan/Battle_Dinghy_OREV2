import { TwitterApi } from 'twitter-api-v2';
import { config } from '../config.js';
import * as repository from '../db/repository.js';
import { GameId, WalletAddress } from '../core/game/types.js';

// OAuth 2.0 credentials from environment
const TWITTER_CLIENT_ID = process.env.TWITTER_CLIENT_ID || '';
const TWITTER_CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET || '';

// Twitter client (will be initialized from database tokens)
let twitterClient: TwitterApi | null = null;

// OAuth 2.0 PKCE flow storage
const oauth2CodeVerifiers = new Map<string, string>();
const oauth2CallbackUrls = new Map<string, string>();

/**
 * Check if Twitter is configured
 */
export function isTwitterConfigured(): boolean {
  return !!(TWITTER_CLIENT_ID && TWITTER_CLIENT_SECRET);
}

/**
 * Initialize Twitter OAuth tokens from environment variables into database
 */
export function initializeTwitterTokensFromEnv(): void {
  const existingToken = repository.getOAuthToken('twitter');

  if (existingToken) {
    console.log('✅ Twitter tokens already in database');
    return;
  }

  const accessToken = process.env.TWITTER_ACCESS_TOKEN || '';
  const refreshToken = process.env.TWITTER_REFRESH_TOKEN || '';

  if (!accessToken || !refreshToken) {
    console.log(
      '⚠️  No Twitter tokens in environment variables or database. Please authorize via admin dashboard.'
    );
    return;
  }

  console.log('🔄 Migrating Twitter tokens from environment variables to database...');

  try {
    repository.upsertOAuthToken(
      'twitter',
      accessToken,
      refreshToken,
      new Date(Date.now() + 2 * 60 * 60 * 1000)
    );
    console.log('✅ Twitter tokens migrated to database successfully');
  } catch (error) {
    console.error('❌ Failed to migrate Twitter tokens to database:', error);
  }
}

/**
 * Check Twitter credentials status
 */
export function checkTwitterCredentials(): {
  configured: boolean;
  hasClientId: boolean;
  hasClientSecret: boolean;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
} {
  const token = repository.getOAuthToken('twitter');

  return {
    configured: !!(TWITTER_CLIENT_ID && TWITTER_CLIENT_SECRET && token?.accessToken),
    hasClientId: !!TWITTER_CLIENT_ID,
    hasClientSecret: !!TWITTER_CLIENT_SECRET,
    hasAccessToken: !!token?.accessToken,
    hasRefreshToken: !!token?.refreshToken,
  };
}

/**
 * Refresh Twitter OAuth 2.0 token
 */
export async function refreshTwitterToken(): Promise<void> {
  const currentToken = repository.getOAuthToken('twitter');

  if (!TWITTER_CLIENT_ID || !TWITTER_CLIENT_SECRET || !currentToken?.refreshToken) {
    throw new Error('Cannot refresh token: Missing OAuth 2.0 credentials or refresh token');
  }

  console.log('🔄 Refreshing Twitter OAuth 2.0 token...');

  const client = new TwitterApi({
    clientId: TWITTER_CLIENT_ID,
    clientSecret: TWITTER_CLIENT_SECRET,
  });

  const { accessToken, refreshToken, expiresIn } = await client.refreshOAuth2Token(
    currentToken.refreshToken
  );

  const expiresAt = new Date(Date.now() + (expiresIn || 7200) * 1000);

  repository.upsertOAuthToken(
    'twitter',
    accessToken,
    refreshToken || currentToken.refreshToken,
    expiresAt
  );

  twitterClient = null;

  console.log(
    '✅ Twitter token refreshed and saved to database. Expires in:',
    expiresIn || 7200,
    'seconds'
  );
}

/**
 * Initialize Twitter client with token refresh if needed
 */
export async function initTwitterClient(): Promise<TwitterApi> {
  const token = repository.getOAuthToken('twitter');

  if (!token?.accessToken) {
    throw new Error(
      'No Twitter access token available. Please authorize via the admin dashboard.'
    );
  }

  const tokenWillExpireSoon =
    token.expiresAt && Date.now() >= new Date(token.expiresAt).getTime() - 5 * 60 * 1000;

  if (tokenWillExpireSoon && token.refreshToken) {
    try {
      await refreshTwitterToken();
      const refreshedToken = repository.getOAuthToken('twitter');
      if (!refreshedToken) {
        throw new Error('Token refresh succeeded but unable to retrieve refreshed token');
      }
      twitterClient = new TwitterApi(refreshedToken.accessToken);
    } catch (error) {
      console.error('Failed to refresh Twitter token:', error);
      throw new Error('Twitter token expired and refresh failed. Please re-authorize the app.');
    }
  }

  if (!twitterClient) {
    twitterClient = new TwitterApi(token.accessToken);
  }

  return twitterClient;
}

/**
 * Execute Twitter API call with automatic token refresh on auth failures
 */
export async function executeWithRefresh<T>(
  operation: (client: TwitterApi) => Promise<T>
): Promise<T> {
  try {
    const client = await initTwitterClient();
    return await operation(client);
  } catch (error: any) {
    const isAuthError =
      error?.code === 401 ||
      error?.code === 403 ||
      error?.status === 401 ||
      error?.status === 403;

    const token = repository.getOAuthToken('twitter');

    if (isAuthError && token?.refreshToken) {
      console.log('⚠️  Authentication failed, attempting token refresh...');

      try {
        await refreshTwitterToken();
        const client = await initTwitterClient();
        return await operation(client);
      } catch (refreshError) {
        console.error('Failed to refresh and retry:', refreshError);
        throw new Error(
          'Twitter authentication failed. Please re-authorize the app in the admin dashboard.'
        );
      }
    }

    throw error;
  }
}

/**
 * Post game announcement tweet
 */
export async function postGameAnnouncement(
  gameId: GameId,
  entryFeeSol: number,
  maxPlayers: number,
  shipSize: number,
  shotsPerSalvo: number,
  customText?: string,
  joinUrl?: string
): Promise<{ tweetId: string; threadId: string } | null> {
  if (!config.twitter.enabled) {
    const shipNames = ['Tiny Dinghy', 'Mid Ship', 'Giant Vessel'];
    console.log('[TWITTER STUB] Game announcement:', {
      gameId,
      entryFeeSol,
      maxPlayers,
      ship: shipNames[shipSize - 1],
    });
    return { tweetId: `stub-${Date.now()}`, threadId: `stub-${Date.now()}` };
  }

  return await executeWithRefresh(async (client) => {
    const shipNames = ['Tiny Dinghy', 'Mid Ship', 'Giant Vessel'];
    const url = joinUrl || `/join/${gameId}`;

    const tweetText = `${customText ? customText + '\n\n' : ''}🚢 BATTLE DINGHY ${gameId} ⚓

💰 Entry: ${entryFeeSol} SOL
👥 Max: ${maxPlayers} players
🚤 Ship: ${shipNames[shipSize - 1]}
💥 Shots: ${shotsPerSalvo} per round
🏆 Last one standing wins!

${url}

First shot incoming... 🎯`;

    const tweet = await client.v2.tweet(tweetText);

    return {
      tweetId: tweet.data.id,
      threadId: tweet.data.id,
    };
  });
}

/**
 * Post shot announcement tweet
 */
export async function postShotAnnouncement(
  gameId: GameId,
  threadId: string,
  shotNumber: number,
  coordinate: string,
  hitPlayers: Array<{ wallet: WalletAddress; twitterHandle: string | null; result: string }>,
  alivePlayers: number
): Promise<string> {
  if (!config.twitter.enabled) {
    console.log('[TWITTER STUB] Shot announcement:', {
      gameId,
      shotNumber,
      coordinate,
      hits: hitPlayers.filter((h) => h.result !== 'miss').length,
      alivePlayers,
    });
    return `stub-shot-${Date.now()}`;
  }

  return await executeWithRefresh(async (client) => {
    const hits = hitPlayers.filter((h) => h.result !== 'miss');
    const missCount = hitPlayers.length - hits.length;

    let tweetText = `⚡ SHOT #${shotNumber}: ${coordinate} ⚡\n\n`;

    if (hits.length > 0) {
      tweetText += `🎯 HITS:\n`;
      for (const { twitterHandle, result } of hits) {
        const handle = twitterHandle ? `@${twitterHandle}` : 'A player';
        if (result === 'eliminated') {
          tweetText += `${handle} - ELIMINATED! 💀\n`;
        } else if (result === 'sunk') {
          tweetText += `${handle} - Ship SUNK! ⚰️\n`;
        } else {
          tweetText += `${handle} - Ship damaged!\n`;
        }
      }
      tweetText += `\n`;
    }

    if (missCount > 0) {
      tweetText += `💨 MISSES: ${missCount} players\n\n`;
    }

    tweetText += `👥 ${alivePlayers} players remaining`;

    const tweet = await client.v2.tweet({
      text: tweetText,
      reply: {
        in_reply_to_tweet_id: threadId,
      },
    });

    return tweet.data.id;
  });
}

/**
 * Post winner announcement tweet
 */
export async function postWinnerAnnouncement(
  gameId: GameId,
  threadId: string,
  winnerHandle: string | null,
  prizePoolSol: number,
  shotsTotal: number,
  hullRemaining: number
): Promise<string> {
  if (!config.twitter.enabled) {
    console.log('[TWITTER STUB] Winner announcement:', {
      gameId,
      winnerHandle,
      prizePoolSol,
    });
    return `stub-winner-${Date.now()}`;
  }

  return await executeWithRefresh(async (client) => {
    const winner = winnerHandle ? `@${winnerHandle}` : 'The winner';

    const tweetText = `🏆 GAME ${gameId} COMPLETE! 🏆

WINNER: ${winner}
Prize: ${prizePoolSol.toFixed(4)} SOL 💎

📊 Final Stats:
- Survived: ${shotsTotal}/25 shots
- Hull: ${hullRemaining} HP remaining

Next game starting soon ⏰`;

    const tweet = await client.v2.tweet({
      text: tweetText,
      reply: {
        in_reply_to_tweet_id: threadId,
      },
    });

    return tweet.data.id;
  });
}

/**
 * Send player board card as tweet reply
 */
export async function sendPlayerBoard(
  playerHandle: string,
  gameId: GameId,
  threadId: string,
  imageBuffer: Buffer
): Promise<string> {
  if (!config.twitter.enabled) {
    console.log('[TWITTER STUB] Player board:', { playerHandle, gameId });
    return `stub-board-${Date.now()}`;
  }

  return await executeWithRefresh(async (client) => {
    const mediaId = await client.v1.uploadMedia(imageBuffer, { mimeType: 'image/png' });

    const message = `@${playerHandle} 🚢 Your Battle Dinghy board for ${gameId}!

Your ship is placed. Good luck! ⚓`;

    const tweet = await client.v2.tweet(message, {
      reply: { in_reply_to_tweet_id: threadId },
      media: { media_ids: [mediaId] },
    });

    return tweet.data.id;
  });
}

/**
 * Initiate OAuth 2.0 PKCE flow
 */
export async function initiateOAuthFlow(callbackUrl: string): Promise<string> {
  if (!TWITTER_CLIENT_ID || !TWITTER_CLIENT_SECRET) {
    throw new Error('Twitter OAuth 2.0 Client ID and Secret not configured');
  }

  const client = new TwitterApi({
    clientId: TWITTER_CLIENT_ID,
    clientSecret: TWITTER_CLIENT_SECRET,
  });

  const { url, codeVerifier, state } = client.generateOAuth2AuthLink(callbackUrl, {
    scope: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
  });

  oauth2CodeVerifiers.set(state, codeVerifier);
  oauth2CallbackUrls.set(state, callbackUrl);

  return url;
}

/**
 * Handle OAuth 2.0 callback
 */
export async function handleOAuthCallback(
  code: string,
  state: string
): Promise<{ accessToken: string; refreshToken: string | undefined; screenName: string }> {
  const codeVerifier = oauth2CodeVerifiers.get(state);
  const callbackUrl = oauth2CallbackUrls.get(state);

  if (!codeVerifier || !callbackUrl) {
    throw new Error('OAuth session not found or expired. Please restart the authorization flow.');
  }

  oauth2CodeVerifiers.delete(state);
  oauth2CallbackUrls.delete(state);

  const client = new TwitterApi({
    clientId: TWITTER_CLIENT_ID,
    clientSecret: TWITTER_CLIENT_SECRET,
  });

  const {
    client: loggedClient,
    accessToken,
    refreshToken,
  } = await client.loginWithOAuth2({
    code,
    codeVerifier,
    redirectUri: callbackUrl,
  });

  const { data: user } = await loggedClient.v2.me();

  // Save tokens to database
  repository.upsertOAuthToken(
    'twitter',
    accessToken,
    refreshToken || '',
    new Date(Date.now() + 2 * 60 * 60 * 1000)
  );

  return {
    accessToken,
    refreshToken,
    screenName: user.username,
  };
}

/**
 * Post a tweet (generic)
 */
export async function postTweet(content: string, gameId: GameId): Promise<string | null> {
  if (!config.twitter.enabled) {
    console.log(`[TWITTER STUB] Would tweet for game ${gameId}: ${content.substring(0, 50)}...`);
    return `stub-tweet-${Date.now()}`;
  }

  return await executeWithRefresh(async (client) => {
    const tweet = await client.v2.tweet(content);
    return tweet.data.id;
  });
}

/**
 * Send notification to a user
 */
export async function sendNotification(
  handle: string,
  message: string,
  gameId: GameId
): Promise<void> {
  if (!config.twitter.enabled) {
    console.log(`[TWITTER STUB] Would notify @${handle}: ${message}`);
    return;
  }
  console.log(`[Twitter] Notifying @${handle}: ${message}`);
}

/**
 * Health check
 */
export async function healthCheck(): Promise<boolean> {
  if (!config.twitter.enabled) return true;

  try {
    const credentials = checkTwitterCredentials();
    return credentials.configured;
  } catch {
    return false;
  }
}
