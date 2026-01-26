import { GameId, GameConfig, SideEffect, PlayerState } from '../core/game/types.js';
import { processPayouts, processRefunds } from './payment-service.js';
import { postTweet, sendNotification } from './twitter-service.js';

// Context needed for executing side effects
export interface ExecutorContext {
  config: GameConfig;
  players: PlayerState[];
}

// Forward declaration - will be set by game-service
let triggerSalvo: (gameId: GameId) => Promise<void>;
let scheduleTimeout: (gameId: GameId, durationMs: number) => void;

export function setExecutorDependencies(
  salvoFn: (gameId: GameId) => Promise<void>,
  timeoutFn: (gameId: GameId, durationMs: number) => void
): void {
  triggerSalvo = salvoFn;
  scheduleTimeout = timeoutFn;
}

export async function executeEffect(
  gameId: GameId,
  effect: SideEffect,
  context: ExecutorContext
): Promise<void> {
  try {
    switch (effect.type) {
      case 'NOTIFY_PLAYERS': {
        const targets = effect.wallets ?? context.players.map(p => p.wallet);
        for (const wallet of targets) {
          const player = context.players.find(p => p.wallet === wallet);
          if (player?.twitterHandle) {
            await sendNotification(player.twitterHandle, effect.message, gameId);
          }
        }
        break;
      }

      case 'PROCESS_PAYOUTS':
        await processPayouts(gameId, effect.winners, context.config);
        break;

      case 'PROCESS_REFUNDS':
        await processRefunds(gameId, effect.wallets, context.config);
        break;

      case 'SCHEDULE_TIMEOUT':
        scheduleTimeout(gameId, effect.durationMs);
        break;

      case 'POST_TWEET':
        await postTweet(effect.content, gameId);
        break;

      case 'TRIGGER_SALVO':
        setTimeout(() => triggerSalvo(gameId), 1000);
        break;
    }
  } catch (error) {
    console.error(`Effect ${effect.type} failed for ${gameId}:`, error);
  }
}
