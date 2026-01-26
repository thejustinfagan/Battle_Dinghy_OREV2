// Battle Dinghy ORE v2 - Main Entry Point
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from './config.js';
import { initDatabase } from './db/index.js';
import routes from './routes/index.js';
import { errorHandler } from './middleware/error-handler.js';
import { initPaymentMonitor } from './services/payment-monitor.js';
import * as repository from './db/repository.js';
import { GameId, parseGameId, toCellIndex, CellIndex } from './core/game/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('Battle Dinghy ORE v2');
  console.log(`Environment: ${config.nodeEnv}`);

  // Initialize database
  await initDatabase();
  console.log('Database initialized');

  const app = express();

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Static files
  app.use(express.static(join(__dirname, '../public')));

  // API routes
  app.use('/api', routes);

  // Serve frontend pages
  app.get('/join/:gameId', (req, res) => {
    res.sendFile(join(__dirname, '../public/join.html'));
  });

  app.get('/game/:gameId', (req, res) => {
    res.sendFile(join(__dirname, '../public/game.html'));
  });

  app.get('/admin', (req, res) => {
    res.sendFile(join(__dirname, '../public/admin.html'));
  });

  // Error handler
  app.use(errorHandler);

  // Initialize Payment Monitor if escrow wallet is configured
  if (config.solana.escrowPublicKey) {
    const paymentMonitor = initPaymentMonitor(config.solana.escrowPublicKey, {
      onPlayerJoined: async (
        gameId: GameId,
        walletAddress: string,
        twitterHandle: string,
        position: CellIndex[],
        txSignature: string
      ) => {
        try {
          // Add the player to the game
          repository.addPlayer(gameId, {
            wallet: walletAddress as any, // Will be validated by repository
            twitterHandle,
            position,
            entryTx: txSignature,
          });
          console.log(`✅ Player @${twitterHandle} joined game ${gameId} via payment monitor`);
        } catch (error) {
          console.error(`Failed to add player to game ${gameId}:`, error);
        }
      },
    });
    await paymentMonitor.start();
    console.log('Payment Monitor started');
  } else {
    console.log('⚠️ Payment Monitor disabled - ESCROW_WALLET_PUBLIC_KEY not configured');
  }

  // Start server
  app.listen(config.port, () => {
    console.log(`Server running on http://localhost:${config.port}`);
    console.log(`Admin dashboard: http://localhost:${config.port}/admin`);
  });
}

main().catch(console.error);
