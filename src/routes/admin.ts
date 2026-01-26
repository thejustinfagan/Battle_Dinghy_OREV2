import { Router } from 'express';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { adminAuth } from '../middleware/auth.js';
import { validateCreateGame, CreateGameInput } from '../middleware/validation.js';
import * as gameService from '../services/game-service.js';
import * as paymentService from '../services/payment-service.js';
import * as twitterService from '../services/twitter-service.js';
import { parseGameId, GameConfig } from '../core/game/types.js';
import * as repo from '../db/repository.js';

const router = Router();
router.use(adminAuth);

// GET /api/admin/status
router.get('/status', async (req, res) => {
  try {
    const [escrowBalance, twitterOk] = await Promise.all([
      paymentService.getEscrowBalance().catch(() => null),
      twitterService.healthCheck(),
    ]);
    const activeGames = repo.getGamesByStatus(['active', 'repositioning']);
    const waitingGames = repo.getGamesByStatus(['waiting']);

    res.json({
      server: { status: 'ok', uptime: process.uptime() },
      database: { status: 'ok' },
      twitter: { status: twitterOk ? 'ok' : 'error' },
      solana: { status: escrowBalance !== null ? 'ok' : 'error' },
      escrow: {
        balanceLamports: escrowBalance,
        balanceSol: escrowBalance ? escrowBalance / LAMPORTS_PER_SOL : null,
        address: await paymentService.getEscrowAddress().catch(() => null),
      },
      games: { waiting: waitingGames.length, active: activeGames.length },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/games
router.get('/games', async (req, res) => {
  try {
    const status = req.query.status as string | undefined;
    const games = status
      ? repo.getGamesByStatus([status as any])
      : [
          ...repo.getGamesByStatus(['waiting']),
          ...repo.getGamesByStatus(['active', 'repositioning']),
          ...repo.getGamesByStatus(['complete', 'cancelled']).slice(0, 20),
        ];

    const result = games.map(g => {
      const players = repo.getPlayers(g.id);
      return {
        id: g.id,
        status: g.status,
        playerCount: players.length,
        maxPlayers: g.config.maxPlayers,
        entryFeeSol: g.config.entryFeeLamports / LAMPORTS_PER_SOL,
        prizePoolSol: (players.length * g.config.entryFeeLamports) / LAMPORTS_PER_SOL,
        round: g.round,
        createdAt: g.createdAt.toISOString(),
        deadline: g.deadline?.toISOString() ?? null,
      };
    });

    res.json({ games: result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/games
router.post('/games', validateCreateGame, async (req, res) => {
  try {
    const input = req.body as CreateGameInput;
    const gameConfig: GameConfig = {
      entryFeeLamports: Math.floor(input.entryFeeSol * LAMPORTS_PER_SOL),
      maxPlayers: input.maxPlayers,
      shipSize: input.shipSize,
      shotsPerSalvo: input.shotsPerSalvo,
      fillDeadlineMinutes: input.fillDeadlineMinutes,
      repositionWindowMinutes: input.repositionWindowMinutes,
      maxRounds: input.maxRounds ?? 10,
    };

    const game = await gameService.createGame(gameConfig);
    const tweetResult = await twitterService.postGameAnnouncement(
      game.id,
      input.entryFeeSol,
      input.maxPlayers,
      input.shipSize,
      input.shotsPerSalvo,
      input.customTweetText
    );
    if (tweetResult?.tweetId) repo.updateGameTweetId(game.id, tweetResult.tweetId);

    res.json({
      success: true,
      gameId: game.id,
      tweetId: tweetResult?.tweetId ?? null,
      joinUrl: `/join/${game.id}`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/games/:gameId
router.get('/games/:gameId', async (req, res) => {
  try {
    const gameId = parseGameId(req.params.gameId);
    const game = repo.getGame(gameId);
    if (!game) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }

    const players = repo.getPlayers(gameId);
    const rounds = repo.getRounds(gameId);
    const transactions = repo.getGameTransactions(gameId);

    res.json({
      id: game.id,
      status: game.status,
      config: {
        ...game.config,
        entryFeeSol: game.config.entryFeeLamports / LAMPORTS_PER_SOL,
      },
      round: game.round,
      deadline: game.deadline?.toISOString() ?? null,
      winners: game.winners,
      cancelReason: game.cancelReason,
      tweetId: game.tweetId,
      createdAt: game.createdAt.toISOString(),
      startedAt: game.startedAt?.toISOString() ?? null,
      completedAt: game.completedAt?.toISOString() ?? null,
      players: players.map(p => ({
        wallet: p.wallet,
        twitterHandle: p.twitterHandle,
        position: p.position,
        hits: p.hits,
        isEliminated: p.isEliminated,
        eliminatedRound: p.eliminatedRound,
        joinedAt: p.joinedAt.toISOString(),
      })),
      rounds: rounds.map(r => ({
        number: r.roundNumber,
        oreHash: r.oreHash,
        shots: r.shots,
        eliminations: r.eliminations,
        createdAt: r.createdAt.toISOString(),
      })),
      transactions: transactions.map(t => ({
        type: t.type,
        wallet: t.wallet,
        amountSol: t.amountLamports / LAMPORTS_PER_SOL,
        status: t.status,
        signature: t.signature,
        error: t.error,
      })),
      prizePool: {
        totalSol: (players.length * game.config.entryFeeLamports) / LAMPORTS_PER_SOL,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/games/:gameId/cancel
router.post('/games/:gameId/cancel', async (req, res) => {
  try {
    const gameId = parseGameId(req.params.gameId);
    const game = repo.getGame(gameId);
    if (!game) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }
    if (!['waiting', 'repositioning'].includes(game.status)) {
      res.status(400).json({ error: 'Cannot cancel game in this status' });
      return;
    }
    await gameService.cancelGame(gameId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/games/:gameId/force-start
router.post('/games/:gameId/force-start', async (req, res) => {
  try {
    const gameId = parseGameId(req.params.gameId);
    const game = repo.getGame(gameId);
    if (!game) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }
    if (game.status !== 'waiting') {
      res.status(400).json({ error: 'Can only force start waiting games' });
      return;
    }
    const count = repo.countPlayers(gameId);
    if (count < 2) {
      res.status(400).json({ error: 'Need at least 2 players' });
      return;
    }
    await gameService.forceStartGame(gameId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/games/:gameId/retry-payout
router.post('/games/:gameId/retry-payout', async (req, res) => {
  try {
    await paymentService.retryPendingPayouts();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/escrow
router.get('/escrow', async (req, res) => {
  try {
    const [balance, address] = await Promise.all([
      paymentService.getEscrowBalance(),
      paymentService.getEscrowAddress(),
    ]);
    const activeGames = repo.getGamesByStatus(['waiting', 'active', 'repositioning']);
    let committed = 0;
    for (const g of activeGames) {
      committed += repo.countPlayers(g.id) * g.config.entryFeeLamports;
    }

    res.json({
      address,
      balanceLamports: balance,
      balanceSol: balance / LAMPORTS_PER_SOL,
      committedLamports: committed,
      committedSol: committed / LAMPORTS_PER_SOL,
      availableLamports: balance - committed,
      availableSol: (balance - committed) / LAMPORTS_PER_SOL,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
