import { Request, Response, NextFunction } from 'express';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { config } from '../config.js';
import { parseWalletAddress, WalletAddress } from '../core/game/types.js';

declare global {
  namespace Express {
    interface Request {
      wallet?: WalletAddress;
    }
  }
}

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-admin-key'];
  if (!apiKey || apiKey !== config.admin.apiKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

export async function walletAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { walletAddress, signature, message, timestamp } = req.body;

    if (!walletAddress || !signature || !message || !timestamp) {
      res.status(400).json({ error: 'Missing auth fields' });
      return;
    }

    const now = Date.now();
    const ts = typeof timestamp === 'number' ? timestamp : parseInt(timestamp, 10);
    if (Math.abs(now - ts) > 5 * 60 * 1000) {
      res.status(401).json({ error: 'Signature expired' });
      return;
    }

    if (!verifySignature(walletAddress, signature, message)) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    req.wallet = parseWalletAddress(walletAddress);
    next();
  } catch (err: any) {
    res.status(401).json({ error: err.message });
  }
}

function verifySignature(walletAddress: string, signature: string, message: string): boolean {
  try {
    const pubkey = new PublicKey(walletAddress);
    const sigBytes = bs58.decode(signature);
    const msgBytes = new TextEncoder().encode(message);
    return nacl.sign.detached.verify(msgBytes, sigBytes, pubkey.toBytes());
  } catch {
    return false;
  }
}
