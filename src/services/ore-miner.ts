import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  Transaction,
  Keypair,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { config } from '../config.js';

// ORE Program ID - v3 on mainnet
export const ORE_PROGRAM_ID = process.env.ORE_PROGRAM_ID
  ? new PublicKey(process.env.ORE_PROGRAM_ID)
  : new PublicKey('oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv');

// ORE Token mint address (mainnet)
export const ORE_TOKEN_MINT = new PublicKey('oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp');

// Instruction discriminators (from ORE v3 program)
const DEPLOY_DISCRIMINATOR = 6;
const CHECKPOINT_DISCRIMINATOR = 2;
const CLAIM_SOL_DISCRIMINATOR = 3;
const CLAIM_ORE_DISCRIMINATOR = 4;

// PDA seeds
const MINER_SEED = Buffer.from('miner');
const BOARD_SEED = Buffer.from('board');
const ROUND_SEED = Buffer.from('round');
const TREASURY_SEED = Buffer.from('treasury');

/**
 * Calculate the squares bitmask for deploying to all 25 blocks
 * Returns a 32-bit integer where the first 25 bits are set to 1
 */
export function calculateAllSquaresMask(): number {
  return (1 << 25) - 1; // 0x1FFFFFF (33554431 in decimal)
}

/**
 * Calculate maximum deployment per block accounting for transaction fees
 */
export function calculateMaxDeployPerBlock(
  totalPrizePool: number,
  estimatedFeesPerRound: number = 10000,
  numRounds: number = 25
): number {
  const totalFeesReserved = estimatedFeesPerRound * numRounds * 5;
  const availableForDeployment = totalPrizePool - totalFeesReserved;
  const totalDeployments = 25;
  const perBlockDeployment = Math.floor(availableForDeployment / totalDeployments);

  console.log(`💰 Prize Pool: ${totalPrizePool / LAMPORTS_PER_SOL} SOL`);
  console.log(`💸 Reserved for fees: ${totalFeesReserved / LAMPORTS_PER_SOL} SOL`);
  console.log(`🎯 Available for deployment: ${availableForDeployment / LAMPORTS_PER_SOL} SOL`);
  console.log(`📊 Deploy per block: ${perBlockDeployment / LAMPORTS_PER_SOL} SOL`);

  return perBlockDeployment;
}

/**
 * Derive the miner PDA for a given authority
 */
export function getMinerPda(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MINER_SEED, authority.toBuffer()],
    ORE_PROGRAM_ID
  );
}

/**
 * Get the board PDA (singleton account)
 */
export function getBoardPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([BOARD_SEED], ORE_PROGRAM_ID);
}

/**
 * Get the round PDA for a given round ID
 */
export function getRoundPda(roundId: number): [PublicKey, number] {
  const roundIdBuffer = Buffer.alloc(8);
  roundIdBuffer.writeBigUInt64LE(BigInt(roundId));

  return PublicKey.findProgramAddressSync(
    [ROUND_SEED, roundIdBuffer],
    ORE_PROGRAM_ID
  );
}

/**
 * Get the treasury PDA (singleton account)
 */
export function getTreasuryPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TREASURY_SEED], ORE_PROGRAM_ID);
}

/**
 * ORE Round account data structure
 */
export interface OreRoundData {
  roundNumber: bigint;
  startTime: bigint;
  endTime: bigint;
  winningSquareIndex: number; // 0-24
  totalSolDeployed: bigint;
  solPerSquare: bigint[];
  motherlodeTriggered: boolean;
}

/**
 * Fetch and parse the ORE round PDA account
 */
export async function fetchRoundData(
  connection: Connection,
  roundId: number
): Promise<OreRoundData | null> {
  try {
    const [roundPda] = getRoundPda(roundId);
    const accountInfo = await connection.getAccountInfo(roundPda);

    if (!accountInfo) {
      console.log(`⚠️  Round ${roundId} PDA not found - may not be finalized yet`);
      return null;
    }

    const data = accountInfo.data;

    if (data.length < 8) {
      throw new Error('Invalid round account data - too short');
    }

    // Skip the 8-byte Anchor discriminator
    let offset = 8;

    const roundNumber = data.readBigUInt64LE(offset);
    offset += 8;

    const startTime = data.readBigInt64LE(offset);
    offset += 8;

    const endTime = data.readBigInt64LE(offset);
    offset += 8;

    const winningSquareIndex = data.readUInt8(offset);
    offset += 1;

    // Align to next 8-byte boundary
    offset = Math.ceil(offset / 8) * 8;

    const totalSolDeployed = data.readBigUInt64LE(offset);
    offset += 8;

    const solPerSquare: bigint[] = [];
    for (let i = 0; i < 25; i++) {
      solPerSquare.push(data.readBigUInt64LE(offset));
      offset += 8;
    }

    const motherlodeTriggered = data.readUInt8(offset) !== 0;

    return {
      roundNumber,
      startTime,
      endTime,
      winningSquareIndex,
      totalSolDeployed,
      solPerSquare,
      motherlodeTriggered,
    };
  } catch (error) {
    console.error(`❌ Error fetching round ${roundId} data:`, error);
    return null;
  }
}

/**
 * Convert ORE winning square index (0-24) to Battle Dinghy coordinate (A1-E5)
 */
export function oreSquareIndexToCoordinate(squareIndex: number): string {
  if (squareIndex < 0 || squareIndex > 24) {
    throw new Error(`Invalid square index: ${squareIndex}. Must be 0-24.`);
  }

  const row = Math.floor(squareIndex / 5);
  const col = squareIndex % 5;

  const rowLabel = (row + 1).toString();
  const colLabel = String.fromCharCode(65 + col);

  return colLabel + rowLabel;
}

/**
 * Fetch the current round number from the board PDA
 */
export async function fetchBoardCurrentRound(
  connection: Connection
): Promise<number | null> {
  try {
    const [boardPda] = getBoardPda();
    const accountInfo = await connection.getAccountInfo(boardPda);

    if (!accountInfo || !accountInfo.data) {
      console.error('❌ Board account not found');
      return null;
    }

    if (accountInfo.data.length < 16) {
      console.error('❌ Board account data too short');
      return null;
    }

    const currentRound = Number(accountInfo.data.readBigUInt64LE(8));
    return currentRound;
  } catch (error) {
    console.error('❌ Error fetching board current round:', error);
    return null;
  }
}

/**
 * Create Deploy instruction
 */
export function createDeployInstruction(
  signer: PublicKey,
  authority: PublicKey,
  amount: number,
  squaresMask: number
): TransactionInstruction {
  const [minerPda] = getMinerPda(authority);
  const [boardPda] = getBoardPda();
  const [roundPda] = getRoundPda(0);

  const data = Buffer.alloc(13);
  data.writeUInt8(DEPLOY_DISCRIMINATOR, 0);
  data.writeBigUInt64LE(BigInt(amount), 1);
  data.writeUInt32LE(squaresMask, 9);

  return new TransactionInstruction({
    programId: ORE_PROGRAM_ID,
    keys: [
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: authority, isSigner: false, isWritable: true },
      { pubkey: PublicKey.default, isSigner: false, isWritable: true },
      { pubkey: boardPda, isSigner: false, isWritable: true },
      { pubkey: minerPda, isSigner: false, isWritable: true },
      { pubkey: roundPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Create Checkpoint instruction
 */
export function createCheckpointInstruction(
  signer: PublicKey,
  authority: PublicKey,
  roundId: number
): TransactionInstruction {
  const [minerPda] = getMinerPda(authority);
  const [boardPda] = getBoardPda();
  const [roundPda] = getRoundPda(roundId);
  const [treasuryPda] = getTreasuryPda();

  const data = Buffer.alloc(1);
  data.writeUInt8(CHECKPOINT_DISCRIMINATOR, 0);

  return new TransactionInstruction({
    programId: ORE_PROGRAM_ID,
    keys: [
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: boardPda, isSigner: false, isWritable: false },
      { pubkey: minerPda, isSigner: false, isWritable: true },
      { pubkey: roundPda, isSigner: false, isWritable: true },
      { pubkey: treasuryPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Create ClaimSOL instruction
 */
export function createClaimSolInstruction(
  signer: PublicKey,
  authority: PublicKey
): TransactionInstruction {
  const [minerPda] = getMinerPda(authority);

  const data = Buffer.alloc(1);
  data.writeUInt8(CLAIM_SOL_DISCRIMINATOR, 0);

  return new TransactionInstruction({
    programId: ORE_PROGRAM_ID,
    keys: [
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: minerPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Create ClaimORE instruction
 */
export function createClaimOreInstruction(
  signer: PublicKey,
  authority: PublicKey,
  minerTokenAccount: PublicKey
): TransactionInstruction {
  const [minerPda] = getMinerPda(authority);
  const [treasuryPda] = getTreasuryPda();

  const data = Buffer.alloc(1);
  data.writeUInt8(CLAIM_ORE_DISCRIMINATOR, 0);

  return new TransactionInstruction({
    programId: ORE_PROGRAM_ID,
    keys: [
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: minerPda, isSigner: false, isWritable: true },
      { pubkey: minerTokenAccount, isSigner: false, isWritable: true },
      { pubkey: treasuryPda, isSigner: false, isWritable: true },
      { pubkey: ORE_TOKEN_MINT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Execute transactions
 */
export async function executeDeploy(
  connection: Connection,
  payer: Keypair,
  authority: PublicKey,
  amount: number,
  squaresMask: number
): Promise<string> {
  const instruction = createDeployInstruction(payer.publicKey, authority, amount, squaresMask);
  const transaction = new Transaction().add(instruction);
  const signature = await sendAndConfirmTransaction(connection, transaction, [payer]);
  console.log(`✅ Deploy transaction confirmed: ${signature}`);
  return signature;
}

export async function executeCheckpoint(
  connection: Connection,
  payer: Keypair,
  authority: PublicKey,
  roundId: number
): Promise<string> {
  const instruction = createCheckpointInstruction(payer.publicKey, authority, roundId);
  const transaction = new Transaction().add(instruction);
  const signature = await sendAndConfirmTransaction(connection, transaction, [payer]);
  console.log(`✅ Checkpoint transaction confirmed: ${signature}`);
  return signature;
}

export async function executeClaimSol(
  connection: Connection,
  payer: Keypair,
  authority: PublicKey
): Promise<string> {
  const instruction = createClaimSolInstruction(payer.publicKey, authority);
  const transaction = new Transaction().add(instruction);
  const signature = await sendAndConfirmTransaction(connection, transaction, [payer]);
  console.log(`✅ ClaimSOL transaction confirmed: ${signature}`);
  return signature;
}

export async function executeClaimOre(
  connection: Connection,
  payer: Keypair,
  authority: PublicKey,
  minerTokenAccount: PublicKey
): Promise<string> {
  const instruction = createClaimOreInstruction(payer.publicKey, authority, minerTokenAccount);
  const transaction = new Transaction().add(instruction);
  const signature = await sendAndConfirmTransaction(connection, transaction, [payer]);
  console.log(`✅ ClaimORE transaction confirmed: ${signature}`);
  return signature;
}

/**
 * Get miner account balance
 */
export async function getMinerBalance(
  connection: Connection,
  authority: PublicKey
): Promise<number> {
  const [minerPda] = getMinerPda(authority);
  try {
    return await connection.getBalance(minerPda);
  } catch (error) {
    console.error('Error fetching miner balance:', error);
    return 0;
  }
}

/**
 * OreMiner class - wraps all ORE mining operations
 */
export class OreMiner {
  private connection: Connection;
  private escrowKeypair: Keypair;
  private authority: PublicKey;
  private minerPda: PublicKey;
  private minerBump: number;

  constructor(escrowKeypair: Keypair, rpcUrl: string) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.escrowKeypair = escrowKeypair;
    this.authority = escrowKeypair.publicKey;

    const [minerPda, minerBump] = getMinerPda(this.authority);
    this.minerPda = minerPda;
    this.minerBump = minerBump;

    console.log(`⛏️  OreMiner initialized`);
    console.log(`  Authority: ${this.authority.toString()}`);
    console.log(`  Miner PDA: ${this.minerPda.toString()}`);
    console.log(`  Bump: ${this.minerBump}`);
  }

  async deploy(amountPerBlock: number): Promise<string> {
    const squaresMask = calculateAllSquaresMask();
    return await executeDeploy(
      this.connection,
      this.escrowKeypair,
      this.authority,
      amountPerBlock,
      squaresMask
    );
  }

  async checkpoint(roundId: number): Promise<string> {
    return await executeCheckpoint(
      this.connection,
      this.escrowKeypair,
      this.authority,
      roundId
    );
  }

  async claimSol(): Promise<string> {
    return await executeClaimSol(
      this.connection,
      this.escrowKeypair,
      this.authority
    );
  }

  async claimOre(minerTokenAccount: PublicKey): Promise<string> {
    return await executeClaimOre(
      this.connection,
      this.escrowKeypair,
      this.authority,
      minerTokenAccount
    );
  }

  async getBalance(): Promise<number> {
    return await getMinerBalance(this.connection, this.authority);
  }

  getMinerInfo(): { address: string; bump: number } {
    return {
      address: this.minerPda.toString(),
      bump: this.minerBump,
    };
  }

  getConnection(): Connection {
    return this.connection;
  }

  getEscrowKeypair(): Keypair {
    return this.escrowKeypair;
  }
}
