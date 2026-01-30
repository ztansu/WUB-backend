/**
 * Chained Architecture API Routes
 *
 * REST + WebSocket endpoints for the chained (STT→GPT→TTS) architecture.
 * This allows comparing with the Realtime API version.
 */

import { Router } from 'express';
import { WebSocket } from 'ws';
import {
  initOpenAI,
  createChainedSession,
  generateGreeting,
  processUserAudio,
  handleSilence,
  ChainedSession,
} from '../services/chainedSession';
import { getPersona } from '../config/personas';

const router = Router();

// Store active chained sessions
const chainedSessions = new Map<string, ChainedSession>();

/**
 * Initialize the chained API with OpenAI key
 */
export function initChainedApi(apiKey: string) {
  initOpenAI(apiKey);
}

/**
 * POST /api/chained/session
 * Create a new chained session
 */
router.post('/session', async (req, res) => {
  try {
    const { personaId, voiceId, preferences, context } = req.body;

    const persona = getPersona(personaId);

    const session = createChainedSession({
      persona,
      voiceId: voiceId || 'soft-female',
      preferences: {
        includeNews: preferences?.includeNews ?? persona.defaults.includeNews,
        includeWeather: preferences?.includeWeather ?? persona.defaults.includeWeather,
        includeCalendar: preferences?.includeCalendar ?? persona.defaults.includeCalendar,
        includeStories: preferences?.includeStories ?? persona.defaults.includeStories,
      },
      context: {
        weather: context?.weather || 'Weather information not available.',
        calendar: context?.calendar || 'No calendar events for today.',
        news: context?.news || '',
        currentTime: new Date().toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }),
      },
    });

    chainedSessions.set(session.id, session);

    console.log(`[Chained API] Session created: ${session.id}`);

    res.json({
      sessionId: session.id,
      persona: { id: persona.id, name: persona.name },
    });
  } catch (error) {
    console.error('[Chained API] Failed to create session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

/**
 * POST /api/chained/session/:id/greeting
 * Generate the initial greeting
 */
router.post('/session/:id/greeting', async (req, res) => {
  try {
    const session = chainedSessions.get(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const result = await generateGreeting(session);

    res.json({
      text: result.response,
      audio: result.audioBuffer.toString('base64'),
      brainState: session.brain.getState(),
    });
  } catch (error) {
    console.error('[Chained API] Failed to generate greeting:', error);
    res.status(500).json({ error: 'Failed to generate greeting' });
  }
});

/**
 * POST /api/chained/session/:id/respond
 * Process user audio and generate response
 * Body: { audio: base64 encoded audio }
 */
router.post('/session/:id/respond', async (req, res) => {
  try {
    const session = chainedSessions.get(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const { audio } = req.body;
    if (!audio) {
      return res.status(400).json({ error: 'Audio data required' });
    }

    const audioBuffer = Buffer.from(audio, 'base64');
    const result = await processUserAudio(session, audioBuffer);

    res.json({
      transcript: result.transcript,
      response: result.response,
      audio: result.audioBuffer.toString('base64'),
      brainState: session.brain.getState(),
    });
  } catch (error) {
    console.error('[Chained API] Failed to process audio:', error);
    res.status(500).json({ error: 'Failed to process audio' });
  }
});

/**
 * POST /api/chained/session/:id/silence
 * Handle silence and generate re-engagement
 */
router.post('/session/:id/silence', async (req, res) => {
  try {
    const session = chainedSessions.get(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const result = await handleSilence(session);

    res.json({
      response: result.response,
      audio: result.audioBuffer.toString('base64'),
      brainState: session.brain.getState(),
    });
  } catch (error) {
    console.error('[Chained API] Failed to handle silence:', error);
    res.status(500).json({ error: 'Failed to handle silence' });
  }
});

/**
 * GET /api/chained/session/:id/state
 * Get current brain state
 */
router.get('/session/:id/state', (req, res) => {
  const session = chainedSessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    brainState: session.brain.getState(),
    historyLength: session.conversationHistory.length,
  });
});

/**
 * DELETE /api/chained/session/:id
 * End a session
 */
router.delete('/session/:id', (req, res) => {
  const deleted = chainedSessions.delete(req.params.id);
  res.json({ success: deleted });
});

export default router;
