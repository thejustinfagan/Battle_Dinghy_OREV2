import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config.js';
import * as repository from '../db/repository.js';
import { GameId, parseGameId, parseWalletAddress, CellIndex, toCellIndex } from '../core/game/types.js';
import { validatePlacement } from '../core/game/placement.js';

export interface PaymentMonitorCallbacks {
  onPlayerJoined: (
    gameId: GameId,
    walletAddress: string,
    twitterHandle: string,
    position: CellIndex[],
    txSignature: string
  ) => Promise<void>;
}

/**
 * Payment Monitor - watches escrow wallet for incoming payments
 * and auto-completes player joins
 */
export class PaymentMonitor {
  private connection: Connection;
  private escrowPublicKey: PublicKey;
  private lastCheckedSignature: string | null = null;
  private pollingInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private callbacks: PaymentMonitorCallbacks;

  constructor(escrowPublicKey: string, callbacks: PaymentMonitorCallbacks) {
    this.connection = new Connection(config.solana.rpcUrl, 'confirmed');
    this.escrowPublicKey = new PublicKey(escrowPublicKey);
    this.callbacks = callbacks;

    console.log(`💰 Payment Monitor initialized`);
    console.log(`  RPC: ${config.solana.rpcUrl}`);
    console.log(`  Escrow: ${escrowPublicKey}`);
  }

  async start(): Promise<void> {
    console.log('💰 Payment Monitor - Starting...');

    // Check last 100 transactions on startup
    console.log('💰 Payment Monitor - Checking recent transactions (last 100)...');
    try {
      const signatures = await this.connection.getSignaturesForAddress(this.escrowPublicKey, {
        limit: 100,
      });

      if (signatures.length > 0) {
        for (const sigInfo of signatures.reverse()) {
          await this.processTransaction(sigInfo.signature);
        }
        this.lastCheckedSignature = signatures[0].signature;
        console.log(`💰 Payment Monitor - Processed ${signatures.length} recent transactions`);
        console.log(
          `💰 Payment Monitor - Now monitoring from: ${this.lastCheckedSignature.substring(0, 8)}...`
        );
      }
    } catch (error) {
      console.error('💰 Payment Monitor - Error processing initial transactions:', error);
    }

    // Poll every 10 seconds for new transactions
    this.pollingInterval = setInterval(() => this.checkForNewPayments(), 10000);
    console.log('💰 Payment Monitor - Started (polling every 10 seconds)');
  }

  stop(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      console.log('💰 Payment Monitor - Stopped');
    }
  }

  private async checkForNewPayments(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    try {
      const signatures = await this.connection.getSignaturesForAddress(this.escrowPublicKey, {
        limit: 10,
        until: this.lastCheckedSignature || undefined,
      });

      if (signatures.length === 0) {
        this.isProcessing = false;
        return;
      }

      console.log(`💰 Payment Monitor - Found ${signatures.length} new transaction(s)`);

      for (const sigInfo of signatures.reverse()) {
        await this.processTransaction(sigInfo.signature);
        this.lastCheckedSignature = sigInfo.signature;
      }
    } catch (error) {
      console.error('💰 Payment Monitor - Error checking for payments:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  private async processTransaction(signature: string): Promise<void> {
    try {
      console.log(
        `💰 Payment Monitor - Processing transaction: ${signature.substring(0, 8)}...`
      );

      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (!tx || !tx.meta || tx.meta.err) {
        console.log(
          `💰 Payment Monitor - Transaction failed or not found: ${signature.substring(0, 8)}...`
        );
        return;
      }

      // Find the transfer instruction
      const instructions = tx.transaction.message.instructions;
      for (const instruction of instructions) {
        if ('parsed' in instruction && instruction.parsed?.type === 'transfer') {
          const { source, destination, lamports } = instruction.parsed.info;

          // Check if this is a payment to our escrow wallet
          if (destination === this.escrowPublicKey.toString()) {
            console.log(
              `💰 Payment Monitor - Payment detected: ${lamports} lamports from ${source.substring(0, 8)}...`
            );
            await this.handlePayment(source, lamports, signature);
          }
        }
      }
    } catch (error) {
      console.error(
        `💰 Payment Monitor - Error processing transaction ${signature.substring(0, 8)}:`,
        error
      );
    }
  }

  private async handlePayment(
    walletAddress: string,
    lamports: number,
    txSignature: string
  ): Promise<void> {
    try {
      // Find verification token for this wallet
      const tokens = repository.getAllVerificationTokens();
      const token = tokens.find(
        (t) => t.walletAddress === walletAddress && new Date() <= new Date(t.expiresAt)
      );

      if (!token) {
        console.log(
          `💰 Payment Monitor - No verification token found for wallet ${walletAddress.substring(0, 8)}...`
        );
        return;
      }

      if (new Date() > new Date(token.expiresAt)) {
        console.log(
          `💰 Payment Monitor - Token expired for wallet ${walletAddress.substring(0, 8)}...`
        );
        return;
      }

      const game = repository.getGame(token.gameId as GameId);
      if (!game) {
        console.log(`💰 Payment Monitor - Game ${token.gameId} not found`);
        return;
      }

      const gameConfig = game.config;

      // Check if payment amount matches entry fee
      const expectedLamports = gameConfig.entryFeeLamports;
      const tolerance = 100; // Allow 100 lamport tolerance
      if (Math.abs(lamports - expectedLamports) > tolerance) {
        console.log(
          `💰 Payment Monitor - Payment amount mismatch: ${lamports} lamports vs expected ${expectedLamports} lamports`
        );
        return;
      }

      // Check if player already joined
      const players = repository.getPlayers(token.gameId as GameId);
      if (players.some((p) => p.wallet === walletAddress)) {
        console.log(
          `💰 Payment Monitor - Player ${walletAddress.substring(0, 8)}... already joined`
        );
        return;
      }

      console.log(
        `💰 Payment Monitor - Completing join for @${token.twitterHandle} (${walletAddress.substring(0, 8)}...)`
      );

      // Generate random valid position
      const position = this.generateRandomPosition(gameConfig.shipSize);

      // Call the callback to complete the join
      await this.callbacks.onPlayerJoined(
        token.gameId as GameId,
        walletAddress,
        token.twitterHandle,
        position,
        txSignature
      );

      console.log(
        `✅ Payment Monitor - Player @${token.twitterHandle} joined game ${token.gameId}!`
      );
    } catch (error) {
      console.error('💰 Payment Monitor - Error handling payment:', error);
    }
  }

  /**
   * Generate a random valid ship position
   */
  private generateRandomPosition(shipSize: number): CellIndex[] {
    const maxAttempts = 100;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const startCell = Math.floor(Math.random() * 25) as CellIndex;
      const horizontal = Math.random() < 0.5;

      const cells: CellIndex[] = [startCell];

      if (shipSize > 1) {
        for (let i = 1; i < shipSize; i++) {
          let nextCell: number;
          if (horizontal) {
            nextCell = startCell + i;
          } else {
            nextCell = startCell + i * 5;
          }

          if (nextCell >= 0 && nextCell < 25) {
            cells.push(toCellIndex(nextCell));
          }
        }
      }

      if (cells.length === shipSize) {
        try {
          validatePlacement(cells, shipSize as 1 | 2 | 3);
          return cells;
        } catch {
          // Invalid placement, try again
        }
      }
    }

    // Fallback: single cell at random position
    return [toCellIndex(Math.floor(Math.random() * 25))];
  }
}

// Singleton instance
let paymentMonitor: PaymentMonitor | null = null;

export function initPaymentMonitor(
  escrowPublicKey: string,
  callbacks: PaymentMonitorCallbacks
): PaymentMonitor {
  if (paymentMonitor) {
    paymentMonitor.stop();
  }
  paymentMonitor = new PaymentMonitor(escrowPublicKey, callbacks);
  return paymentMonitor;
}

export function getPaymentMonitor(): PaymentMonitor | null {
  return paymentMonitor;
}
