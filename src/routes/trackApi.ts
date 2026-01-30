/**
 * Track Engine API Routes
 */

import { Router, Request, Response } from 'express';
import {
  TrackEngine,
  TrackConfig,
  initTrackEngine,
  getDefaultSegmentOrder,
  WeatherData,
  CalendarEvent,
  NewsItem,
} from '../services/trackEngine';
import { initOpenAI } from '../services/chainedSession';

const router = Router();

// Store active sessions
const sessions = new Map<string, TrackEngine>();

// Initialize the track engine with OpenAI key
export function initTrackApi(apiKey: string) {
  initTrackEngine(apiKey);
  // Also init the chainedSession's OpenAI client since trackEngine uses its TTS/transcribe
  initOpenAI(apiKey);
}

// ============================================
// CREATE SESSION
// ============================================

router.post('/session', async (req: Request, res: Response) => {
  try {
    const {
      personaId = 'morning-coach',
      voiceId = 'alloy',
      userName = 'friend',
      segmentOrder,
      weather,
      calendar,
      news,
      facts,
      newsThemes,
      spotifyPlaylistId,
    } = req.body;

    const config: TrackConfig = {
      personaId,
      voiceId,
      userName,
      segmentOrder: segmentOrder || getDefaultSegmentOrder(),
      weather,
      calendar,
      news,
      facts,
      newsThemes,
      spotifyPlaylistId,
    };

    const engine = new TrackEngine(config);
    const state = engine.getState();

    sessions.set(state.sessionId, engine);

    console.log(`[TrackAPI] Created session ${state.sessionId} with persona ${personaId}`);

    res.json({
      sessionId: state.sessionId,
      currentSegment: engine.getCurrentSegment(),
    });
  } catch (error) {
    console.error('[TrackAPI] Error creating session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// ============================================
// GET SESSION STATE
// ============================================

router.get('/session/:id', (req: Request, res: Response) => {
  const id = req.params.id as string;
  const engine = sessions.get(id);
  if (!engine) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    state: engine.getState(),
    currentSegment: engine.getCurrentSegment(),
    isComplete: engine.isComplete(),
  });
});

// ============================================
// GENERATE NEXT SEGMENT (called on silence)
// ============================================

router.post('/session/:id/next', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const engine = sessions.get(id);
    if (!engine) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const result = await engine.handleSilence();

    res.json({
      text: result.text,
      audio: result.audioBuffer.toString('base64'),
      action: result.action,
      currentSegment: engine.getCurrentSegment(),
      isComplete: engine.isComplete(),
    });
  } catch (error: any) {
    console.error('[TrackAPI] Error generating next segment:', error?.message || error);
    console.error('[TrackAPI] Stack:', error?.stack);
    res.status(500).json({ error: 'Failed to generate segment', details: error?.message });
  }
});

// ============================================
// START SESSION (generate greeting)
// ============================================

router.post('/session/:id/start', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const engine = sessions.get(id);
    if (!engine) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const result = await engine.generateSegmentContent();

    res.json({
      text: result.text,
      audio: result.audioBuffer.toString('base64'),
      currentSegment: engine.getCurrentSegment(),
    });
  } catch (error: any) {
    console.error('[TrackAPI] Error starting session:', error?.message || error);
    console.error('[TrackAPI] Stack:', error?.stack);
    res.status(500).json({ error: 'Failed to start session', details: error?.message });
  }
});

// ============================================
// HANDLE USER AUDIO
// ============================================

router.post('/session/:id/audio', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const engine = sessions.get(id);
    if (!engine) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const { audio } = req.body;
    if (!audio) {
      return res.status(400).json({ error: 'No audio provided' });
    }

    const audioBuffer = Buffer.from(audio, 'base64');
    console.log(`[TrackAPI] Received audio: ${audioBuffer.length} bytes`);

    const result = await engine.handleUserSpeech(audioBuffer);
    console.log(`[TrackAPI] Speech result:`, result ? `transcript="${result.transcript}"` : 'no speech detected');

    if (!result) {
      // No speech detected
      return res.json({ transcript: null, text: null, audio: null });
    }

    res.json({
      transcript: result.transcript,
      text: result.text,
      audio: result.audioBuffer.toString('base64'),
      currentSegment: engine.getCurrentSegment(),
      conversationMode: engine.isInConversationMode(),
    });
  } catch (error) {
    console.error('[TrackAPI] Error processing audio:', error);
    res.status(500).json({ error: 'Failed to process audio' });
  }
});

// ============================================
// MARK USER AS AWAKE
// ============================================

router.post('/session/:id/awake', (req: Request, res: Response) => {
  const id = req.params.id as string;
  const engine = sessions.get(id);
  if (!engine) {
    return res.status(404).json({ error: 'Session not found' });
  }

  engine.markAwake();

  res.json({
    message: 'User marked as awake',
    currentSegment: engine.getCurrentSegment(),
  });
});

// ============================================
// END SESSION
// ============================================

router.delete('/session/:id', (req: Request, res: Response) => {
  const id = req.params.id as string;
  const deleted = sessions.delete(id);
  res.json({ deleted });
});

// ============================================
// GET SILENCE DURATION
// ============================================

router.get('/session/:id/silence-duration', (req: Request, res: Response) => {
  const id = req.params.id as string;
  const engine = sessions.get(id);
  if (!engine) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    duration: engine.getSilenceDuration(),
  });
});

export default router;
