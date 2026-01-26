import { Router } from 'express';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { walletAuth } from '../middleware/auth.js';
import { validateJoinGame, validateReposition } from '../middleware/validation.js';
import { validatePlacement, PlacementError } from '../core/game/placement.js';
import * as gameService from '../services/game-service.js';
import * as paymentService from '../services/payment-service.js';
import { parseGameId, toCellIndex } from '../core/game/types.js';
import * as repo from '../db/repository.js';

const router = Router();

// POST /api/player/:gameId/join
router.post('/:gameId/join', validateJoinGame, walletAuth, async (req, res) => {
  try {
    const gameId = parseGameId(req.params.gameId);
    const wallet = req.wallet!;
    const { cells, twitterHandle, entryTx } = req.body;

    const game = repo.getGame(gameId);
    if (!game) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }
    if (game.status !== 'waiting') {
      res.status(400).json({ error: 'Game not accepting players' });
      return;
    }

    // Validate placement
    try {
      validatePlacement(cells, game.config.shipSize);
    } catch (err) {
      if (err instanceof PlacementError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    // Verify payment transaction
    const verification = await paymentService.verifyTransaction(
      entryTx,
      wallet,
      game.config.entryFeeLamports
    );
    if (!verification.valid) {
      res.status(400).json({ error: `Payment verification failed: ${verification.error}` });
      return;
    }

    // Join game
    const cellIndices = cells.map(toCellIndex);
    const handle = twitterHandle?.replace(/^@/, '') || null;
    const player = await gameService.joinGame(gameId, wallet, handle, cellIndices, entryTx);

    res.json({
      success: true,
      playerId: player.id,
      position: player.position,
      playerCount: repo.countPlayers(gameId),
      maxPlayers: game.config.maxPlayers,
    });
  } catch (err: any) {
    if (err.message.includes('Already joined') || err.message.includes('Game is full')) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/player/:gameId/reposition
router.post('/:gameId/reposition', validateReposition, walletAuth, async (req, res) => {
  try {
    const gameId = parseGameId(req.params.gameId);
    const wallet = req.wallet!;
    const { cells } = req.body;

    const game = repo.getGame(gameId);
    if (!game) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }
    if (game.status !== 'repositioning') {
      res.status(400).json({ error: 'Not in repositioning phase' });
      return;
    }

    // Validate placement
    try {
      validatePlacement(cells, game.config.shipSize);
    } catch (err) {
      if (err instanceof PlacementError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const cellIndices = cells.map(toCellIndex);
    await gameService.submitReposition(gameId, wallet, cellIndices);

    res.json({ success: true, newPosition: cellIndices });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/player/:gameId/status
router.get('/:gameId/status', async (req, res) => {
  try {
    const gameId = parseGameId(req.params.gameId);
    const walletAddress = req.query.wallet as string | undefined;

    const game = repo.getGame(gameId);
    if (!game) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }

    const players = repo.getPlayers(gameId);
    const rounds = repo.getRounds(gameId);

    // Base response
    const response: any = {
      gameId: game.id,
      status: game.status,
      round: game.round,
      deadline: game.deadline?.toISOString() ?? null,
      playerCount: players.length,
      maxPlayers: game.config.maxPlayers,
      config: {
        entryFeeSol: game.config.entryFeeLamports / LAMPORTS_PER_SOL,
        shipSize: game.config.shipSize,
        shotsPerSalvo: game.config.shotsPerSalvo,
        repositionWindowMinutes: game.config.repositionWindowMinutes,
      },
    };

    // Add round history if game has started
    if (rounds.length > 0) {
      response.lastRound = {
        number: rounds[rounds.length - 1].roundNumber,
        shots: rounds[rounds.length - 1].shots,
        eliminations: rounds[rounds.length - 1].eliminations,
      };
    }

    // Add player-specific data if wallet provided
    if (walletAddress) {
      const player = players.find(p => p.wallet === walletAddress);
      if (player) {
        response.myStatus = {
          position: player.position,
          hits: player.hits,
          isEliminated: player.isEliminated,
          eliminatedRound: player.eliminatedRound,
        };
      }
    }

    // Reveal all positions after salvo (key for skill-based play)
    if (game.status === 'repositioning' || game.status === 'complete') {
      response.allPositions = players.map(p => ({
        wallet: p.wallet.slice(0, 8) + '...',
        position: p.position,
        hits: p.hits,
        isEliminated: p.isEliminated,
      }));
    }

    // Winners
    if (game.status === 'complete') {
      response.winners = game.winners;
    }

    res.json(response);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
