import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { GameId, GameConfig, WalletAddress } from '../core/game/types.js';
import * as repo from '../db/repository.js';
import { config } from '../config.js';
import bs58 from 'bs58';

let connection: Connection | null = null;
let escrowKeypair: Keypair | null = null;

function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(config.solana.rpcUrl, 'confirmed');
  }
  return connection;
}

function getEscrowKeypair(): Keypair {
  if (!escrowKeypair) {
    if (!config.solana.escrowPrivateKey) {
      throw new Error('ESCROW_PRIVATE_KEY not set');
    }
    escrowKeypair = Keypair.fromSecretKey(bs58.decode(config.solana.escrowPrivateKey));
  }
  return escrowKeypair;
}

export async function getEscrowBalance(): Promise<number> {
  return getConnection().getBalance(getEscrowKeypair().publicKey);
}

export async function getEscrowAddress(): Promise<string> {
  return getEscrowKeypair().publicKey.toBase58();
}

export async function processPayouts(
  gameId: GameId,
  winners: WalletAddress[],
  gameConfig: GameConfig
): Promise<void> {
  const players = repo.getPlayers(gameId);
  const totalPool = players.length * gameConfig.entryFeeLamports;
  const platformFee = Math.floor(totalPool * config.features.platformFeePercent / 100);
  const perWinner = Math.floor((totalPool - platformFee) / winners.length);

  const conn = getConnection();
  const keypair = getEscrowKeypair();

  for (const wallet of winners) {
    const txRecord = repo.recordTransaction(gameId, wallet, 'payout', perWinner);
    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: new PublicKey(wallet),
          lamports: perWinner,
        })
      );
      const sig = await sendAndConfirmTransaction(conn, tx, [keypair], {
        commitment: 'confirmed',
      });
      repo.updateTransactionStatus(txRecord.id, 'confirmed', sig);
      console.log(`Payout to ${wallet}: ${sig}`);
    } catch (err: any) {
      repo.updateTransactionStatus(txRecord.id, 'failed', undefined, err.message);
      console.error(`Payout failed for ${wallet}:`, err);
    }
  }
}

export async function processRefunds(
  gameId: GameId,
  wallets: WalletAddress[],
  gameConfig: GameConfig
): Promise<void> {
  const conn = getConnection();
  const keypair = getEscrowKeypair();

  for (const wallet of wallets) {
    const txRecord = repo.recordTransaction(gameId, wallet, 'refund', gameConfig.entryFeeLamports);
    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: new PublicKey(wallet),
          lamports: gameConfig.entryFeeLamports,
        })
      );
      const sig = await sendAndConfirmTransaction(conn, tx, [keypair], {
        commitment: 'confirmed',
      });
      repo.updateTransactionStatus(txRecord.id, 'confirmed', sig);
      console.log(`Refund to ${wallet}: ${sig}`);
    } catch (err: any) {
      repo.updateTransactionStatus(txRecord.id, 'failed', undefined, err.message);
      console.error(`Refund failed for ${wallet}:`, err);
    }
  }
}

export async function retryPendingPayouts(): Promise<void> {
  const pending = repo.getPendingPayouts();
  for (const tx of pending) {
    const game = repo.getGame(tx.gameId);
    if (!game) continue;
    if (tx.type === 'payout') {
      await processPayouts(tx.gameId, [tx.wallet], game.config);
    } else if (tx.type === 'refund') {
      await processRefunds(tx.gameId, [tx.wallet], game.config);
    }
  }
}

export async function verifyTransaction(
  signature: string,
  expectedPayer: string,
  expectedAmount: number
): Promise<{ valid: boolean; error?: string }> {
  try {
    const tx = await getConnection().getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) return { valid: false, error: 'Transaction not found' };
    if (tx.meta?.err) return { valid: false, error: 'Transaction failed' };
    return { valid: true };
  } catch (err: any) {
    return { valid: false, error: err.message };
  }
}
