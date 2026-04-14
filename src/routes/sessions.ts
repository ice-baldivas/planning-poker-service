import { Router, Request, Response } from 'express';
import { sessionStore } from '../session-store';
import { VOTING_SCALES, VotingScaleId } from '../types';
import { sanitize } from '../utils';

const router = Router();

/**
 * POST /api/sessions
 * Create a new session over HTTP (alternative to the create_session socket event).
 * Body: { name: string; voting_scale_id: 'fibonacci' | 'tshirt' }
 * Response: { session_id: string }
 */
router.post('/', (req: Request, res: Response) => {
  const { name, voting_scale_id } = req.body as { name?: unknown; voting_scale_id?: unknown };

  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required and must be a non-empty string' });
    return;
  }

  const scale = VOTING_SCALES[voting_scale_id as VotingScaleId];
  if (!scale) {
    res.status(400).json({ error: 'voting_scale_id must be "fibonacci" or "tshirt"' });
    return;
  }

  const sanitizedName = sanitize(name);
  if (!sanitizedName) {
    res.status(400).json({ error: 'name must not be empty after sanitization' });
    return;
  }

  const session = sessionStore.createSession(sanitizedName, scale);
  res.status(201).json({ session_id: session.id });
});

/**
 * GET /api/sessions/:id
 * Return public metadata for a session (safe to call before connecting via socket).
 */
router.get('/:id', (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const session = sessionStore.getSession(id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  res.json({
    id: session.id,
    name: session.name,
    voting_scale: session.voting_scale,
    participant_count: session.participants.size,
    status: session.status,
  });
});

export default router;
