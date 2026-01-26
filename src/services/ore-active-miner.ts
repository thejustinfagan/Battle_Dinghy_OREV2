import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  OreMiner,
  calculateAllSquaresMask,
  calculateMaxDeployPerBlock,
  fetchRoundData,
  oreSquareIndexToCoordinate,
  fetchBoardCurrentRound,
} from './ore-miner.js';
import { config } from '../config.js';
import { CellIndex, toCellIndex, GameId, parseGameId } from '../core/game/types.js';
import * as repository from '../db/repository.js';

// Round duration in milliseconds (1 minute)
const ROUND_DURATION_MS = 60 * 1000;

/**
 * Convert coordinate string (A1-E5) to CellIndex (0-24)
 */
function coordinateToCellIndex(coord: string): CellIndex {
  const col = coord.charCodeAt(0) - 65; // A=0, B=1, etc.
  const row = parseInt(coord[1], 10) - 1; // 1=0, 2=1, etc.
  return toCellIndex(row * 5 + col);
}

/**
 * Generate a mock ORE hash for fallback
 */
function generateMockOreHash(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert hash to coordinate for fallback
 */
function oreHashToCoordinate(blockHash: string): string {
  const hashInt = BigInt('0x' + blockHash.slice(0, 16));
  const position = Number(hashInt % BigInt(25));
  const row = Math.floor(position / 5);
  const col = position % 5;
  return `${String.fromCharCode(65 + col)}${row + 1}`;
}

export interface OreActiveMinerCallbacks {
  onShotFired: (
    gameId: string,
    roundNumber: number,
    coordinate: string,
    cellIndex: CellIndex,
    oreHash: string,
    isProvablyFair: boolean
  ) => Promise<void>;
  onGameComplete: (gameId: string) => Promise<void>;
  onError: (gameId: string, error: Error) => void;
}

/**
 * Active ORE Mining Orchestrator
 * Manages the Deploy → Wait → Checkpoint → ClaimSOL → Repeat loop for a single game
 */
export class OreActiveMiner {
  private gameId: string;
  private oreMiner: OreMiner;
  private connection: Connection;
  private escrowKeypair: Keypair;
  private isRunning: boolean = false;
  private currentRound: number = 0;
  private nextRoundTimer: NodeJS.Timeout | null = null;
  private callbacks: OreActiveMinerCallbacks;

  constructor(
    gameId: string,
    escrowKeypair: Keypair,
    rpcUrl: string,
    callbacks: OreActiveMinerCallbacks
  ) {
    this.gameId = gameId;
    this.escrowKeypair = escrowKeypair;
    this.oreMiner = new OreMiner(escrowKeypair, rpcUrl);
    this.connection = this.oreMiner.getConnection();
    this.callbacks = callbacks;

    console.log(`⚡ OreActiveMiner initialized for game ${gameId}`);
  }

  /**
   * Start active mining for this game
   */
  async start(prizePoolLamports: number): Promise<void> {
    if (this.isRunning) {
      console.log(`Mining already running for game ${this.gameId}`);
      return;
    }

    this.isRunning = true;

    // Calculate max deployment per block
    const deployPerBlock = calculateMaxDeployPerBlock(prizePoolLamports);
    const squaresMask = calculateAllSquaresMask();

    // Store miner info in game
    const minerInfo = this.oreMiner.getMinerInfo();

    console.log(`🚀 Starting active ORE mining for game ${this.gameId}`);
    console.log(`  Prize Pool: ${prizePoolLamports / LAMPORTS_PER_SOL} SOL`);
    console.log(`  Deploy per block: ${deployPerBlock / LAMPORTS_PER_SOL} SOL`);
    console.log(`  Squares mask: 0x${squaresMask.toString(16)}`);
    console.log(`  Miner PDA: ${minerInfo.address}`);

    // Start the mining loop
    await this.executeRound(1, deployPerBlock, squaresMask);
  }

  /**
   * Execute a single mining round
   */
  private async executeRound(
    roundNumber: number,
    deployPerBlock: number,
    squaresMask: number
  ): Promise<void> {
    if (!this.isRunning) {
      console.log(`Mining stopped for game ${this.gameId}`);
      return;
    }

    try {
      console.log(`\n⛏️  Round ${roundNumber}/25 - Game ${this.gameId}`);
      this.currentRound = roundNumber;

      // 1. Deploy SOL to all 25 blocks
      console.log(
        `  📤 Deploying ${deployPerBlock / LAMPORTS_PER_SOL} SOL to each of 25 blocks...`
      );
      const deployTx = await this.oreMiner.deploy(deployPerBlock);
      console.log(`  ✅ Deploy successful: ${deployTx}`);

      // 2. Wait for round to complete (~60 seconds)
      console.log(`  ⏳ Waiting ${ROUND_DURATION_MS / 1000}s for round to complete...`);
      await this.sleep(ROUND_DURATION_MS);

      // 3. Checkpoint to record rewards
      console.log(`  📊 Checkpointing round ${roundNumber}...`);
      const checkpointTx = await this.oreMiner.checkpoint(roundNumber);
      console.log(`  ✅ Checkpoint successful: ${checkpointTx}`);

      // 4. Claim SOL immediately for next round
      console.log(`  💰 Claiming SOL rewards...`);
      const escrowBalanceBefore = await this.connection.getBalance(
        this.escrowKeypair.publicKey
      );
      console.log(
        `  📊 Escrow balance BEFORE claim: ${escrowBalanceBefore / LAMPORTS_PER_SOL} SOL`
      );

      const claimSolTx = await this.oreMiner.claimSol();

      // Poll balance until it stabilizes
      let escrowBalanceAfter = escrowBalanceBefore;
      let attempts = 0;
      const maxAttempts = 10;

      while (attempts < maxAttempts) {
        await this.sleep(1000);
        const newBalance = await this.connection.getBalance(this.escrowKeypair.publicKey);
        if (newBalance !== escrowBalanceAfter) {
          escrowBalanceAfter = newBalance;
          await this.sleep(1000);
          const finalCheck = await this.connection.getBalance(this.escrowKeypair.publicKey);
          if (finalCheck === escrowBalanceAfter) break;
          escrowBalanceAfter = finalCheck;
        }
        attempts++;
      }

      console.log(
        `  📊 Escrow balance AFTER claim: ${escrowBalanceAfter / LAMPORTS_PER_SOL} SOL`
      );

      const deployedThisRound = deployPerBlock * 25;
      const claimedAmount = escrowBalanceAfter - escrowBalanceBefore;
      const solDeltaThisRound = claimedAmount - deployedThisRound;

      console.log(`  ✅ ClaimSOL successful: ${claimSolTx}`);
      console.log(`  💵 Deployed: ${deployedThisRound / LAMPORTS_PER_SOL} SOL`);
      console.log(`  💰 Claimed: ${claimedAmount / LAMPORTS_PER_SOL} SOL`);
      console.log(
        `  📈 Delta this round: ${solDeltaThisRound >= 0 ? '+' : ''}${solDeltaThisRound / LAMPORTS_PER_SOL} SOL`
      );

      // 5. Get winning square from ORE round PDA - PROVABLY FAIR RANDOMNESS!
      console.log(`  🔍 Fetching ORE round data for provably fair randomness...`);

      let roundData = null;
      let coordinate = '';
      let usedFallback = false;

      // Try to read board PDA for authoritative completed round ID
      let boardCurrentRound: number | null = null;
      const maxBoardRetries = 10;

      for (let retryAttempt = 0; retryAttempt < maxBoardRetries; retryAttempt++) {
        boardCurrentRound = await fetchBoardCurrentRound(this.connection);
        if (boardCurrentRound !== null && boardCurrentRound > 0) {
          console.log(
            `  ✅ Board round fetched: ${boardCurrentRound} (attempt ${retryAttempt + 1})`
          );
          break;
        }
        console.log(
          `  ⏳ Board round ${boardCurrentRound ?? 'null'} (attempt ${retryAttempt + 1}/${maxBoardRetries}), waiting 2s...`
        );
        await this.sleep(2000);
      }

      let completedRoundId: number | null = null;
      if (boardCurrentRound !== null && boardCurrentRound > 0) {
        completedRoundId = boardCurrentRound - 1;
        console.log(
          `  🔢 Board current round: ${boardCurrentRound}, Completed round: ${completedRoundId}`
        );

        for (let attempt = 0; attempt < 5; attempt++) {
          roundData = await fetchRoundData(this.connection, completedRoundId);

          if (roundData) {
            if (Number(roundData.roundNumber) !== completedRoundId) {
              console.log(
                `  ⚠️  Round number mismatch! Expected ${completedRoundId}, got ${roundData.roundNumber}`
              );
              roundData = null;
              await this.sleep(3000);
              continue;
            }

            if (roundData.winningSquareIndex < 0 || roundData.winningSquareIndex > 24) {
              console.error(
                `  ❌ Invalid winning square index: ${roundData.winningSquareIndex} - using fallback`
              );
              roundData = null;
              break;
            }

            console.log(`  ✅ Round data fetched and validated!`);
            console.log(`  🎲 Winning square index: ${roundData.winningSquareIndex}`);
            console.log(
              `  💰 Total SOL deployed in round: ${Number(roundData.totalSolDeployed) / LAMPORTS_PER_SOL} SOL`
            );
            console.log(
              `  🎰 Motherlode triggered: ${roundData.motherlodeTriggered ? 'YES! 🎉' : 'No'}`
            );

            coordinate = oreSquareIndexToCoordinate(roundData.winningSquareIndex);
            console.log(`  🎯 Provably fair coordinate: ${coordinate}`);
            break;
          }

          console.log(
            `  ⏳ Round data not available (attempt ${attempt + 1}/5), waiting 3s...`
          );
          await this.sleep(3000);
        }
      }

      // Fallback to hash-based coordinate if round data unavailable
      if (!roundData || !coordinate) {
        usedFallback = true;
        const fallbackHash = generateMockOreHash();
        coordinate = oreHashToCoordinate(fallbackHash);
        console.log(`  ⚠️  WARNING: Using hash-based fallback coordinate: ${coordinate}`);
        console.log(`  ⚠️  This is NOT provably fair - board PDA data was unavailable`);
      }

      // Fire shot via callback
      const oreHash =
        roundData && completedRoundId !== null
          ? `ORE_ROUND_${completedRoundId}_SQUARE_${roundData.winningSquareIndex}`
          : `${deployTx}_HASH_FALLBACK`;

      const cellIndex = coordinateToCellIndex(coordinate);

      await this.callbacks.onShotFired(
        this.gameId,
        roundNumber,
        coordinate,
        cellIndex,
        oreHash,
        !usedFallback
      );

      // Check if game should continue
      const game = repository.getGame(parseGameId(this.gameId));
      if (!game || game.status === 'complete') {
        console.log(`  🏁 Game completed, stopping mining`);
        await this.callbacks.onGameComplete(this.gameId);
        this.stop();
        return;
      }

      // Schedule next round
      if (roundNumber < 25) {
        console.log(`  ⏭️  Scheduling round ${roundNumber + 1}...`);
        this.nextRoundTimer = setTimeout(() => {
          this.executeRound(roundNumber + 1, deployPerBlock, squaresMask);
        }, 5000);
      } else {
        console.log(`  🎉 All 25 rounds complete!`);
        await this.callbacks.onGameComplete(this.gameId);
        this.stop();
      }
    } catch (error) {
      console.error(`❌ CRITICAL ERROR in round ${roundNumber}:`, error);
      this.callbacks.onError(this.gameId, error as Error);
      this.stop();
    }
  }

  /**
   * Stop mining
   */
  stop(): void {
    if (this.nextRoundTimer) {
      clearTimeout(this.nextRoundTimer);
      this.nextRoundTimer = null;
    }
    this.isRunning = false;
    console.log(`⏹️  Mining stopped for game ${this.gameId}`);
  }

  /**
   * Helper to sleep for a duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get mining status
   */
  getStatus(): { isRunning: boolean; currentRound: number; gameId: string } {
    return {
      isRunning: this.isRunning,
      currentRound: this.currentRound,
      gameId: this.gameId,
    };
  }
}

/**
 * Active Mining Manager - singleton to manage all active miners
 */
class OreActiveMiningService {
  private activeMiners: Map<string, OreActiveMiner> = new Map();
  private escrowKeypair: Keypair | null = null;
  private rpcUrl: string = '';
  private cleanupInterval: NodeJS.Timeout | null = null;
  private callbacks: OreActiveMinerCallbacks | null = null;

  /**
   * Initialize with escrow keypair and callbacks
   */
  initialize(
    escrowKeypair: Keypair,
    rpcUrl: string,
    callbacks: OreActiveMinerCallbacks
  ): void {
    this.escrowKeypair = escrowKeypair;
    this.rpcUrl = rpcUrl;
    this.callbacks = callbacks;
    console.log(`⚡ OreActiveMiningService initialized with escrow wallet`);

    if (!this.cleanupInterval) {
      this.cleanupInterval = setInterval(() => {
        this.cleanupStoppedMiners();
      }, 60_000);
    }
  }

  isInitialized(): boolean {
    return this.escrowKeypair !== null && this.callbacks !== null;
  }

  private cleanupStoppedMiners(): void {
    const toRemove: string[] = [];
    for (const [gameId, miner] of this.activeMiners) {
      if (!miner.getStatus().isRunning) {
        toRemove.push(gameId);
      }
    }
    for (const gameId of toRemove) {
      this.activeMiners.delete(gameId);
      console.log(`🧹 Cleaned up stopped miner for game ${gameId}`);
    }
  }

  async startMining(gameId: string, prizePoolLamports: number): Promise<void> {
    if (!this.escrowKeypair || !this.callbacks) {
      throw new Error('Mining service not initialized');
    }

    if (this.activeMiners.has(gameId)) {
      console.log(`Mining already active for game ${gameId}`);
      return;
    }

    const miner = new OreActiveMiner(
      gameId,
      this.escrowKeypair,
      this.rpcUrl,
      this.callbacks
    );
    this.activeMiners.set(gameId, miner);

    await miner.start(prizePoolLamports);
  }

  stopMining(gameId: string): void {
    const miner = this.activeMiners.get(gameId);
    if (miner) {
      miner.stop();
      this.activeMiners.delete(gameId);
    }
  }

  getStatus(): Array<{ gameId: string; isRunning: boolean; currentRound: number }> {
    return Array.from(this.activeMiners.values()).map((miner) => miner.getStatus());
  }

  stopAll(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    for (const miner of this.activeMiners.values()) {
      miner.stop();
    }
    this.activeMiners.clear();
    console.log(`⏹️  All miners stopped`);
  }
}

export const oreActiveMiningService = new OreActiveMiningService();
