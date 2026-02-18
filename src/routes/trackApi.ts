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
  SegmentConfig,
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
  // News fetch that may still be in-flight (resolved when news segment is needed)
  pendingNews?: Promise<NewsItem[] | undefined>;
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

    console.log(`[TrackAPI] 📋 Received segmentOrder:`, segmentOrder);
    console.log(`[TrackAPI] 📋 Converted segments:`, segments.map((s, i) => `[${i}] ${s.type}`).join(', '));

    const step1Time = Date.now() - overallStart;
    console.log(`[TrackAPI] ⏱️ Step 1 (Parse request): ${step1Time}ms`);

    // Create engine immediately (without news — news will load in background)
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

    // Start news fetch in background (only if needed) — DON'T await it here.
    // The news segment won't be reached for 2+ minutes of playback, so we
    // let the fetch run while the user is listening to earlier segments.
    const newsStartTime = Date.now();
    const pendingNews: Promise<NewsItem[] | undefined> = (newsThemes && newsThemes.length > 0 && grokApiKey && !news)
      ? fetchNewsHeadlines(grokApiKey, newsThemes, 3)
          .then(newsResult => {
            const newsFetchTime = Date.now() - newsStartTime;
            const newsItems: NewsItem[] = newsResult.headlines.map(h => ({
              headline: h.title,
              summary: h.title,
              theme: h.category || newsThemes[0],
            }));
            console.log(`[TrackAPI] ⏱️ News fetch completed in background: ${newsFetchTime}ms (${newsItems.length} items from ${newsResult.source})`);
            // Update the engine's news data now that it's available
            engine.setNews(newsItems);
            return newsItems;
          })
          .catch(newsError => {
            console.error('[TrackAPI] Failed to fetch news:', newsError);
            return undefined;
          })
      : Promise.resolve(undefined);
    console.log(`[TrackAPI] ⏱️ News fetch kicked off in background (not blocking response)`);

    // Only wait for the greeting — news loads in background
    const greeting = await greetingPromise;
    console.log(`[TrackAPI] ⏱️ Step 3 (Greeting only): ${Date.now() - greetingStart}ms`);

    sessions.set(state.sessionId, {
      engine,
      greeting,
      pendingNews,
    });

    const totalTime = Date.now() - overallStart;
    console.log(`[TrackAPI] ⏱️ TOTAL /session time: ${totalTime}ms (news still loading in background)`);
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

    // If news is still loading and the next segment might need it, wait now.
    // The news fetch runs in the background during earlier segments; by the
    // time the news segment is reached it's almost always already done.
    // We check both the next segment and the one after (conversation mode
    // exit can skip to the segment after next).
    if (sessionData.pendingNews) {
      const nextSeg = sessionData.engine.peekNextSegment();
      const currentSeg = sessionData.engine.getCurrentSegment();
      if (currentSeg?.type === 'news' || nextSeg?.type === 'news') {
        console.log(`[TrackAPI] ⏳ News segment approaching — waiting for background fetch...`);
        await sessionData.pendingNews;
        sessionData.pendingNews = undefined; // Already resolved, clean up
        console.log(`[TrackAPI] ✅ News data ready`);
      }
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
