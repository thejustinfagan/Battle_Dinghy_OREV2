import { Router, Request, Response } from 'express';
import { PublicKey, Transaction, SystemProgram, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { config } from '../config.js';
import * as repository from '../db/repository.js';
import { GameId, parseGameId } from '../core/game/types.js';

const router = Router();

// CORS middleware for Solana Actions (Blinks)
const actionsCorsMiddleware = (_req: Request, res: Response, next: Function) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids'
  );
  res.setHeader('Access-Control-Expose-Headers', 'X-Action-Version, X-Blockchain-Ids');
  res.setHeader('X-Action-Version', '2.1.3');
  res.setHeader('X-Blockchain-Ids', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'); // Mainnet
  next();
};

// Handle OPTIONS for CORS preflight
router.options('/game/:gameId', actionsCorsMiddleware, (_req, res) => {
  res.sendStatus(200);
});

/**
 * GET /api/actions/game/:gameId
 * Returns Solana Actions metadata for wallet rendering
 */
router.get('/game/:gameId', actionsCorsMiddleware, async (req: Request, res: Response) => {
  try {
    const { gameId } = req.params;
    const { token } = req.query;

    let game;
    try {
      const id = parseGameId(gameId);
      game = repository.getGame(id);
    } catch {
      return res.status(404).json({
        error: { message: 'Invalid game ID format' },
      });
    }

    if (!game) {
      return res.status(404).json({
        error: { message: 'Game not found' },
      });
    }

    const gameConfig = game.config;

    // Return disabled action for games that can't accept players
    if (game.status !== 'waiting') {
      return res.status(200).json({
        icon: 'https://ucarecdn.com/7aa5b5ab-888a-44d8-8a90-d99db3a3985f/anchor.png',
        title: `Battle Dinghy ${gameId}`,
        description: `This game has already ${game.status === 'active' ? 'started' : 'ended'}.`,
        label: 'Game Unavailable',
        disabled: true,
        error: { message: `Game has already ${game.status === 'active' ? 'started' : 'ended'}` },
      });
    }

    const players = repository.getPlayers(gameId as GameId);
    if (players.length >= gameConfig.maxPlayers) {
      return res.status(200).json({
        icon: 'https://ucarecdn.com/7aa5b5ab-888a-44d8-8a90-d99db3a3985f/anchor.png',
        title: `Battle Dinghy ${gameId}`,
        description: `Game is full with ${gameConfig.maxPlayers} players.`,
        label: 'Game Full',
        disabled: true,
        error: { message: 'Game is full' },
      });
    }

    // Build base URL
    const host = req.get('host') || 'localhost:3000';
    const protocol = req.get('x-forwarded-proto') || (host.includes('localhost') ? 'http' : 'https');
    const baseUrl = `${protocol}://${host}`;

    // Network indicator
    const network = process.env.SOLANA_NETWORK || 'devnet';
    const networkName = network.toUpperCase();
    const networkEmoji = network === 'devnet' ? '🧪' : '⚡';

    // Format SOL amounts
    const formatSol = (lamports: number) => {
      const sol = lamports / LAMPORTS_PER_SOL;
      if (sol >= 0.001) return sol.toFixed(3);
      if (sol >= 0.00001) return sol.toFixed(5);
      return sol.toFixed(8);
    };

    const entryFeeSol = formatSol(gameConfig.entryFeeLamports);

    // Calculate prize pool
    const prizePool = players.length * gameConfig.entryFeeLamports;
    const prizePoolSol = formatSol(prizePool);

    // Build href with token if provided
    const hrefUrl = `${baseUrl}/api/actions/game/${gameId}`;
    const href = token ? `${hrefUrl}?token=${token}` : hrefUrl;

    const actionResponse = {
      icon: 'https://ucarecdn.com/7aa5b5ab-888a-44d8-8a90-d99db3a3985f/anchor.png',
      title: `${networkEmoji} Battle Dinghy ${gameId} [${networkName}]`,
      description: `⚓ Join the naval battle! ${players.length}/${gameConfig.maxPlayers} players joined. Prize pool: ${prizePoolSol} SOL. Entry: ${entryFeeSol} SOL ${network === 'devnet' ? '(TEST SOL - No real money!)' : ''}`,
      label: `Join Battle [${networkName}]`,
      links: {
        actions: [
          {
            label: `Join for ${entryFeeSol} SOL`,
            href,
          },
        ],
      },
    };

    res.json(actionResponse);
  } catch (error) {
    console.error('Error fetching actions metadata:', error);
    res.status(500).json({
      error: { message: 'Failed to fetch game metadata' },
    });
  }
});

/**
 * POST /api/actions/game/:gameId
 * Returns a Solana transaction for joining the game
 */
router.post('/game/:gameId', actionsCorsMiddleware, async (req: Request, res: Response) => {
  try {
    const { gameId } = req.params;
    const { account } = req.body;
    const { token } = req.query;

    if (!account) {
      return res.status(400).json({
        error: { message: 'Missing wallet account' },
      });
    }

    // Verification token is REQUIRED
    if (!token || typeof token !== 'string') {
      return res.status(400).json({
        error: {
          message:
            'Verification token required. Please visit the game join page to verify your Twitter handle first.',
        },
      });
    }

    // Validate verification token
    const verificationToken = repository.getVerificationToken(token);

    if (!verificationToken) {
      return res.status(400).json({
        error: { message: 'Invalid or expired verification token' },
      });
    }

    if (verificationToken.gameId !== gameId) {
      return res.status(400).json({
        error: { message: 'Token is for a different game' },
      });
    }

    if (verificationToken.usedAt) {
      if (verificationToken.walletAddress !== account) {
        return res.status(400).json({
          error: { message: 'Token has already been used by a different wallet' },
        });
      }
      console.log(`Token ${token} reused by same wallet ${account} - allowing transaction refetch`);
    } else {
      repository.markVerificationTokenUsed(token, account);
    }

    if (new Date() > new Date(verificationToken.expiresAt)) {
      return res.status(400).json({
        error: { message: 'Token has expired. Please verify your Twitter handle again.' },
      });
    }

    const twitterHandle = verificationToken.twitterHandle;

    let game;
    try {
      const id = parseGameId(gameId);
      game = repository.getGame(id);
    } catch {
      return res.status(404).json({
        error: { message: 'Invalid game ID format' },
      });
    }

    if (!game) {
      return res.status(404).json({
        error: { message: 'Game not found' },
      });
    }

    const gameConfig = game.config;

    if (game.status !== 'waiting') {
      return res.status(400).json({
        error: { message: 'Game has already started or is completed' },
      });
    }

    const players = repository.getPlayers(gameId as GameId);
    if (players.length >= gameConfig.maxPlayers) {
      return res.status(400).json({
        error: { message: 'Game is full' },
      });
    }

    let playerWallet: PublicKey;
    try {
      playerWallet = new PublicKey(account);
    } catch {
      return res.status(400).json({
        error: { message: 'Invalid Solana wallet address' },
      });
    }

    // Get escrow wallet
    if (!config.solana.escrowPublicKey) {
      return res.status(500).json({
        error: { message: 'Escrow wallet not configured. Set ESCROW_WALLET_PUBLIC_KEY environment variable.' },
      });
    }

    const escrowPublicKey = new PublicKey(config.solana.escrowPublicKey);

    // Create transfer transaction
    const connection = new Connection(config.solana.rpcUrl, 'confirmed');
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

    const transaction = new Transaction({
      feePayer: playerWallet,
      blockhash,
      lastValidBlockHeight,
    }).add(
      SystemProgram.transfer({
        fromPubkey: playerWallet,
        toPubkey: escrowPublicKey,
        lamports: gameConfig.entryFeeLamports,
      })
    );

    // Serialize transaction
    const serialized = transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');

    res.json({
      transaction: serialized,
      message: `Joining Battle Dinghy ${gameId}${twitterHandle ? ` as @${twitterHandle}` : ''}`,
    });
  } catch (error) {
    console.error('Error creating payment transaction:', error);
    const message = error instanceof Error ? error.message : 'Failed to create transaction';
    res.status(500).json({
      error: { message },
    });
  }
});

/**
 * POST /api/games/:gameId/verify-twitter
 * Verify Twitter handle and generate verification token
 */
router.post('/:gameId/verify-twitter', async (req: Request, res: Response) => {
  try {
    const { gameId } = req.params;
    const { twitterHandle } = req.body;

    if (!twitterHandle) {
      return res.status(400).json({ error: 'Twitter handle is required' });
    }

    // Clean and validate Twitter handle
    const cleanHandle = twitterHandle.replace('@', '').trim();
    if (!cleanHandle || cleanHandle.length === 0) {
      return res.status(400).json({ error: 'Invalid Twitter handle' });
    }

    if (!/^[a-zA-Z0-9_]{1,15}$/.test(cleanHandle)) {
      return res.status(400).json({ error: 'Twitter handle contains invalid characters' });
    }

    let game;
    try {
      const id = parseGameId(gameId);
      game = repository.getGame(id);
    } catch {
      return res.status(404).json({ error: 'Invalid game ID format' });
    }

    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    if (game.status !== 'waiting') {
      return res.status(400).json({ error: 'Game is not accepting players' });
    }

    const gameConfig = game.config;
    const players = repository.getPlayers(gameId as GameId);

    if (players.length >= gameConfig.maxPlayers) {
      return res.status(400).json({ error: 'Game is full' });
    }

    // Check if Twitter handle is already in this game
    const handleTaken = players.some(
      (p) => p.twitterHandle?.toLowerCase() === cleanHandle.toLowerCase()
    );
    if (handleTaken) {
      return res.status(400).json({ error: 'This Twitter handle is already in this game' });
    }

    // Generate verification token
    const token = `vt_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    repository.createVerificationToken({
      gameId,
      token,
      twitterHandle: cleanHandle,
      expiresAt: expiresAt.toISOString(),
    });

    // Generate Blink URL with token
    const host = req.get('host') || 'localhost:3000';
    const protocol = req.get('x-forwarded-proto') || (host.includes('localhost') ? 'http' : 'https');
    const baseUrl = `${protocol}://${host}`;
    const actionUrl = `${baseUrl}/api/actions/game/${gameId}?token=${token}`;
    const blinkUrl = `https://dial.to/?action=solana-action:${actionUrl}`;

    res.json({
      success: true,
      token,
      twitterHandle: cleanHandle,
      blinkUrl,
    });
  } catch (error: any) {
    console.error('Error verifying Twitter handle:', error);
    const message = error instanceof Error ? error.message : 'Failed to verify Twitter handle';
    res.status(500).json({ error: message });
  }
});

export default router;
