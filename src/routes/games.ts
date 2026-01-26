import { Router } from 'express';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { parseGameId } from '../core/game/types.js';
import * as repo from '../db/repository.js';

const router = Router();

// GET /api/games - List active games
router.get('/', async (req, res) => {
  try {
    const games = repo.getGamesByStatus(['waiting']);

    const result = games.map(g => {
      const playerCount = repo.countPlayers(g.id);
      return {
        id: g.id,
        status: g.status,
        playerCount,
        maxPlayers: g.config.maxPlayers,
        entryFeeSol: g.config.entryFeeLamports / LAMPORTS_PER_SOL,
        shipSize: g.config.shipSize,
        shotsPerSalvo: g.config.shotsPerSalvo,
        deadline: g.deadline?.toISOString() ?? null,
        createdAt: g.createdAt.toISOString(),
      };
    });

    res.json({ games: result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/games/:gameId - Get game details
router.get('/:gameId', async (req, res) => {
  try {
    const gameId = parseGameId(req.params.gameId);
    const game = repo.getGame(gameId);

    if (!game) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }

    const playerCount = repo.countPlayers(gameId);
    const rounds = repo.getRounds(gameId);

    res.json({
      id: game.id,
      status: game.status,
      playerCount,
      maxPlayers: game.config.maxPlayers,
      entryFeeSol: game.config.entryFeeLamports / LAMPORTS_PER_SOL,
      shipSize: game.config.shipSize,
      shotsPerSalvo: game.config.shotsPerSalvo,
      repositionWindowMinutes: game.config.repositionWindowMinutes,
      round: game.round,
      deadline: game.deadline?.toISOString() ?? null,
      winners: game.status === 'complete' ? game.winners : undefined,
      roundCount: rounds.length,
      createdAt: game.createdAt.toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
