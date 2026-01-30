/**
 * GPT-Driven API Routes
 *
 * REST endpoints for the GPT-driven (no state machine) approach.
 */

import { Router } from 'express';
import {
  initGptDriven,
  createGptDrivenSession,
  generateGreeting,
  processUserAudio,
  handleSilence,
  GptDrivenSession,
} from '../services/gptDrivenSession';

const router = Router();

// Store active sessions
const gptSessions = new Map<string, GptDrivenSession>();

/**
 * Initialize the GPT-driven API with OpenAI key
 */
export function initGptDrivenApi(apiKey: string) {
  initGptDriven(apiKey);
}

/**
 * POST /api/gpt-driven/session
 * Create a new GPT-driven session
 */
router.post('/session', async (req, res) => {
  try {
    const { personaId, voiceId, context } = req.body;

    const session = createGptDrivenSession({
      personaId: personaId || 'zen-guide',
      voiceId: voiceId || 'soft-female',
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

    gptSessions.set(session.id, session);

    console.log(`[GPT-Driven API] Session created: ${session.id}`);

    res.json({
      sessionId: session.id,
      persona: personaId,
    });
  } catch (error) {
    console.error('[GPT-Driven API] Failed to create session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

/**
 * POST /api/gpt-driven/session/:id/greeting
 * Generate the initial greeting
 */
router.post('/session/:id/greeting', async (req, res) => {
  try {
    const session = gptSessions.get(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const result = await generateGreeting(session);

    res.json({
      text: result.text,
      audio: result.audioBuffer.toString('base64'),
    });
  } catch (error) {
    console.error('[GPT-Driven API] Failed to generate greeting:', error);
    res.status(500).json({ error: 'Failed to generate greeting' });
  }
});

/**
 * POST /api/gpt-driven/session/:id/respond
 * Process user audio and generate response
 */
router.post('/session/:id/respond', async (req, res) => {
  try {
    const session = gptSessions.get(req.params.id);
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
      text: result.text,
      audio: result.audioBuffer.toString('base64'),
    });
  } catch (error) {
    console.error('[GPT-Driven API] Failed to process audio:', error);
    res.status(500).json({ error: 'Failed to process audio' });
  }
});

/**
 * POST /api/gpt-driven/session/:id/silence
 * Handle silence and generate re-engagement
 */
router.post('/session/:id/silence', async (req, res) => {
  try {
    const session = gptSessions.get(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const result = await handleSilence(session);

    res.json({
      text: result.text,
      audio: result.audioBuffer.toString('base64'),
    });
  } catch (error) {
    console.error('[GPT-Driven API] Failed to handle silence:', error);
    res.status(500).json({ error: 'Failed to handle silence' });
  }
});

/**
 * GET /api/gpt-driven/session/:id/state
 * Get current session state
 */
router.get('/session/:id/state', (req, res) => {
  const session = gptSessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    turnCount: session.turnCount,
    silenceCount: session.silenceCount,
    historyLength: session.conversationHistory.length,
  });
});

/**
 * DELETE /api/gpt-driven/session/:id
 * End a session
 */
router.delete('/session/:id', (req, res) => {
  const deleted = gptSessions.delete(req.params.id);
  res.json({ success: deleted });
});

export default router;
