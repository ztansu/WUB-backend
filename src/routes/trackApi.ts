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
import { getNewsThemes, fetchNewsHeadlines } from '../services/grokNews';

const router = Router();

// Store API keys for news fetching
let grokApiKey: string | undefined;

// Store active sessions with pre-generated greeting
interface SessionData {
  engine: TrackEngine;
  greeting?: { text: string; audioBuffer: Buffer };
}
const sessions = new Map<string, SessionData>();

// Initialize the track engine with API keys
export function initTrackApi(openaiKey: string, grokKey?: string) {
  initTrackEngine(openaiKey);
  // Also init the chainedSession's OpenAI client since trackEngine uses its TTS/transcribe
  initOpenAI(openaiKey);
  // Store Grok key for news fetching
  grokApiKey = grokKey;
}

// ============================================
// CREATE SESSION
// ============================================

router.post('/session', async (req: Request, res: Response) => {
  const overallStart = Date.now();
  console.log(`[TrackAPI] ⏱️ POST /session - Request received`);

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

    // Convert segmentOrder from string[] to SegmentConfig[]
    // iOS client sends: ["greeting", "weather", "calendar"]
    // TrackEngine expects: [{type: "greeting", enabled: true}, ...]
    let segments = getDefaultSegmentOrder();
    if (segmentOrder && Array.isArray(segmentOrder)) {
      segments = segmentOrder.map((type: string) => ({
        type: type as any,
        enabled: true,
      }));
    }

    const step1Time = Date.now() - overallStart;
    console.log(`[TrackAPI] ⏱️ Step 1 (Parse request): ${step1Time}ms`);

    // Create engine immediately (don't wait for news)
    const engineStart = Date.now();
    const config: TrackConfig = {
      personaId,
      voiceId,
      userName,
      segmentOrder: segments,
      weather,
      calendar,
      news: news,  // Use provided news (if any)
      facts,
      newsThemes,
      spotifyPlaylistId,
    };

    const engine = new TrackEngine(config);
    const state = engine.getState();
    console.log(`[TrackAPI] ⏱️ Step 2 (Create engine): ${Date.now() - engineStart}ms`);

    console.log(`[TrackAPI] Created session ${state.sessionId} with persona ${personaId}`);

    // Start greeting generation immediately (don't wait for anything)
    const greetingStart = Date.now();
    const greetingPromise = engine.generateSegmentContent();
    console.log(`[TrackAPI] ⏱️ Greeting generation started`);

    // Start news fetch in parallel (only if needed)
    const newsStartTime = Date.now();
    const newsPromise = (newsThemes && newsThemes.length > 0 && grokApiKey && !news)
      ? fetchNewsHeadlines(grokApiKey, newsThemes, 3)
          .then(newsResult => {
            const newsFetchTime = Date.now() - newsStartTime;
            const newsItems = newsResult.headlines.map(h => ({
              headline: h.title,
              summary: h.title,  // Use title as summary for now
              theme: h.category || newsThemes[0],
            }));
            console.log(`[TrackAPI] ⏱️ News fetch completed: ${newsFetchTime}ms (${newsItems.length} items from ${newsResult.source})`);
            return newsItems;
          })
          .catch(newsError => {
            console.error('[TrackAPI] Failed to fetch news:', newsError);
            return undefined;
          })
      : Promise.resolve(undefined);
    console.log(`[TrackAPI] ⏱️ News fetch started (if enabled)`);

    // Wait for both greeting and news to complete
    const parallelStart = Date.now();
    const [greeting, newsItems] = await Promise.all([greetingPromise, newsPromise]);
    console.log(`[TrackAPI] ⏱️ Step 3 (Parallel: Greeting + News): ${Date.now() - parallelStart}ms`);
    console.log(`[TrackAPI] ⏱️   - Greeting generation: ${Date.now() - greetingStart}ms`);

    // Update config with fetched news if we got any
    if (newsItems && newsItems.length > 0) {
      // Re-create engine with news data
      const updatedConfig: TrackConfig = {
        ...config,
        news: newsItems,
      };
      const updatedEngine = new TrackEngine(updatedConfig);
      // Re-generate greeting with news context (optional - greeting doesn't use news anyway)
      // For now just use the original greeting since news doesn't affect it
      sessions.set(state.sessionId, {
        engine: updatedEngine,
        greeting,
      });
    } else {
      sessions.set(state.sessionId, {
        engine,
        greeting,
      });
    }

    const totalTime = Date.now() - overallStart;
    console.log(`[TrackAPI] ⏱️ TOTAL /session time: ${totalTime}ms`);
    console.log(`[TrackAPI] Session ${state.sessionId} ready with pre-generated greeting`);

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
  const sessionData = sessions.get(id);
  if (!sessionData) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    state: sessionData.engine.getState(),
    currentSegment: sessionData.engine.getCurrentSegment(),
    isComplete: sessionData.engine.isComplete(),
  });
});

// ============================================
// GENERATE NEXT SEGMENT (called on silence)
// ============================================

router.post('/session/:id/next', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const sessionData = sessions.get(id);
    if (!sessionData) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const result = await sessionData.engine.handleSilence();

    res.json({
      text: result.text,
      audio: result.audioBuffer.toString('base64'),
      action: result.action,
      currentSegment: sessionData.engine.getCurrentSegment(),
      isComplete: sessionData.engine.isComplete(),
    });
  } catch (error: any) {
    console.error('[TrackAPI] Error generating next segment:', error?.message || error);
    console.error('[TrackAPI] Stack:', error?.stack);
    res.status(500).json({ error: 'Failed to generate segment', details: error?.message });
  }
});

// ============================================
// START SESSION (return pre-generated greeting)
// ============================================

router.post('/session/:id/start', async (req: Request, res: Response) => {
  const startTime = Date.now();
  console.log(`[TrackAPI] ⏱️ POST /start - Request received`);

  try {
    const id = req.params.id as string;
    const sessionData = sessions.get(id);
    if (!sessionData) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Return pre-generated greeting (cached during session creation)
    if (sessionData.greeting) {
      const encodeStart = Date.now();
      const audioBase64 = sessionData.greeting.audioBuffer.toString('base64');
      console.log(`[TrackAPI] ⏱️ Audio encoding: ${Date.now() - encodeStart}ms`);

      console.log(`[TrackAPI] Returning pre-generated greeting for session ${id}`);
      res.json({
        text: sessionData.greeting.text,
        audio: audioBase64,
        currentSegment: sessionData.engine.getCurrentSegment(),
      });

      console.log(`[TrackAPI] ⏱️ TOTAL /start time: ${Date.now() - startTime}ms (cached greeting)`);

      // Clear cached greeting after use
      delete sessionData.greeting;
    } else {
      // Fallback: generate greeting on-demand (shouldn't happen normally)
      console.warn(`[TrackAPI] No cached greeting for session ${id}, generating on-demand`);
      const genStart = Date.now();
      const result = await sessionData.engine.generateSegmentContent();
      console.log(`[TrackAPI] ⏱️ On-demand generation: ${Date.now() - genStart}ms`);

      res.json({
        text: result.text,
        audio: result.audioBuffer.toString('base64'),
        currentSegment: sessionData.engine.getCurrentSegment(),
      });

      console.log(`[TrackAPI] ⏱️ TOTAL /start time: ${Date.now() - startTime}ms (on-demand)`);
    }
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
    const sessionData = sessions.get(id);
    if (!sessionData) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const { audio } = req.body;
    if (!audio) {
      return res.status(400).json({ error: 'No audio provided' });
    }

    const audioBuffer = Buffer.from(audio, 'base64');
    console.log(`[TrackAPI] Received audio: ${audioBuffer.length} bytes`);

    const result = await sessionData.engine.handleUserSpeech(audioBuffer);
    console.log(`[TrackAPI] Speech result:`, result ? `transcript="${result.transcript}"` : 'no speech detected');

    if (!result) {
      // No speech detected
      return res.json({ transcript: null, text: null, audio: null });
    }

    res.json({
      transcript: result.transcript,
      text: result.text,
      audio: result.audioBuffer.toString('base64'),
      currentSegment: sessionData.engine.getCurrentSegment(),
      conversationMode: sessionData.engine.isInConversationMode(),
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
  const sessionData = sessions.get(id);
  if (!sessionData) {
    return res.status(404).json({ error: 'Session not found' });
  }

  sessionData.engine.markAwake();

  res.json({
    message: 'User marked as awake',
    currentSegment: sessionData.engine.getCurrentSegment(),
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
  const sessionData = sessions.get(id);
  if (!sessionData) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    duration: sessionData.engine.getSilenceDuration(),
  });
});

// ============================================
// GET NEWS THEMES (for onboarding)
// ============================================

router.get('/news-themes', (req: Request, res: Response) => {
  const themes = getNewsThemes();
  res.json({ themes });
});

export default router;
