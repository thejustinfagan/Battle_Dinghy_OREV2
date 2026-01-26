import { Request, Response, NextFunction } from 'express';
import { isValidCellIndex, ShipSize } from '../core/game/types.js';

export interface CreateGameInput {
  entryFeeSol: number;
  maxPlayers: number;
  shipSize: ShipSize;
  shotsPerSalvo: number;
  fillDeadlineMinutes: number;
  repositionWindowMinutes: number;
  maxRounds?: number;
  customTweetText?: string;
}

export function validateCreateGame(req: Request, res: Response, next: NextFunction): void {
  const b = req.body as CreateGameInput;
  const errors: string[] = [];

  if (typeof b.entryFeeSol !== 'number' || b.entryFeeSol < 0.0001 || b.entryFeeSol > 10) {
    errors.push('entryFeeSol must be 0.0001-10');
  }
  if (!Number.isInteger(b.maxPlayers) || b.maxPlayers < 2 || b.maxPlayers > 100) {
    errors.push('maxPlayers must be 2-100');
  }
  if (![1, 2, 3].includes(b.shipSize)) {
    errors.push('shipSize must be 1, 2, or 3');
  }
  if (!Number.isInteger(b.shotsPerSalvo) || b.shotsPerSalvo < 3 || b.shotsPerSalvo > 15) {
    errors.push('shotsPerSalvo must be 3-15');
  }
  if (!Number.isInteger(b.fillDeadlineMinutes) || b.fillDeadlineMinutes < 5 || b.fillDeadlineMinutes > 1440) {
    errors.push('fillDeadlineMinutes must be 5-1440');
  }
  if (!Number.isInteger(b.repositionWindowMinutes) || b.repositionWindowMinutes < 5 || b.repositionWindowMinutes > 120) {
    errors.push('repositionWindowMinutes must be 5-120');
  }
  if (b.customTweetText && b.customTweetText.length > 200) {
    errors.push('customTweetText max 200 chars');
  }

  if (errors.length > 0) {
    res.status(400).json({ error: 'Validation failed', details: errors });
    return;
  }
  next();
}

export function validateJoinGame(req: Request, res: Response, next: NextFunction): void {
  const { cells, twitterHandle } = req.body;
  const errors: string[] = [];

  if (!Array.isArray(cells)) {
    errors.push('cells must be array');
  } else if (!cells.every(isValidCellIndex)) {
    errors.push('cells must be valid indices 0-24');
  }

  if (twitterHandle !== undefined && twitterHandle !== null && typeof twitterHandle !== 'string') {
    errors.push('twitterHandle must be string');
  }

  if (errors.length > 0) {
    res.status(400).json({ error: 'Validation failed', details: errors });
    return;
  }
  next();
}

export function validateReposition(req: Request, res: Response, next: NextFunction): void {
  const { cells } = req.body;

  if (!Array.isArray(cells) || !cells.every(isValidCellIndex)) {
    res.status(400).json({ error: 'cells must be valid indices 0-24' });
    return;
  }
  next();
}
