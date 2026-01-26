import { Router } from 'express';
import adminRoutes from './admin.js';
import playerRoutes from './player.js';
import gamesRoutes from './games.js';
import blinksRoutes from './blinks.js';

const router = Router();

router.use('/admin', adminRoutes);
router.use('/player', playerRoutes);
router.use('/games', gamesRoutes);
router.use('/actions', blinksRoutes);

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;
