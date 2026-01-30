/**
 * Wake Up Better - Backend Server
 *
 * This server:
 * 1. Serves a web test page for trying the voice agent
 * 2. Provides a WebSocket relay between clients and OpenAI Realtime API
 * 3. Handles persona selection and session configuration
 */

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import dotenv from 'dotenv';

import { getPersona, getAllPersonas, Persona } from './config/personas';
import {
  createRealtimeSession,
  sendAudio,
  triggerAgentResponse,
  endSession,
  RealtimeSession,
  VOICE_OPTIONS,
} from './services/realtimeSession';
import { getNewsBriefing } from './services/grokNews';
import { WakeSessionBrain } from './services/wakeSessionBrain';
import chainedRouter, { initChainedApi } from './routes/chainedApi';
import gptDrivenRouter, { initGptDrivenApi } from './routes/gptDrivenApi';
import trackRouter, { initTrackApi } from './routes/trackApi';

// Load environment variables
dotenv.config();

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GROK_API_KEY = process.env.GROK_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY environment variable is required');
  process.exit(1);
}

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));  // Larger limit for audio data

// Serve static files (web test page)
app.use(express.static(path.join(__dirname, '../public')));

// Initialize chained API
initChainedApi(OPENAI_API_KEY!);
app.use('/api/chained', chainedRouter);

// Initialize GPT-driven API
initGptDrivenApi(OPENAI_API_KEY!);
app.use('/api/gpt-driven', gptDrivenRouter);

// Initialize Track Engine API
initTrackApi(OPENAI_API_KEY!);
app.use('/api/track', trackRouter);

// ============================================
// REST API ENDPOINTS
// ============================================

// Get all available personas
app.get('/api/personas', (req, res) => {
  const personas = getAllPersonas().map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    defaults: p.defaults,
  }));
  res.json(personas);
});

// Get available voices
app.get('/api/voices', (req, res) => {
  const voices = Object.entries(VOICE_OPTIONS).map(([id, info]) => ({
    id,
    description: info.description,
  }));
  res.json(voices);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// HTTP SERVER & WEBSOCKET SETUP
// ============================================

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Track active sessions and their silence timers
const activeSessions = new Map<WebSocket, RealtimeSession>();
const silenceTimers = new Map<WebSocket, NodeJS.Timeout>();

// Session brains - tracks state and makes decisions for each client
const sessionBrains = new Map<WebSocket, WakeSessionBrain>();

wss.on('connection', async (clientWs) => {
  console.log('[Server] New client connected');

  let realtimeSession: RealtimeSession | null = null;
  let sessionBrain: WakeSessionBrain | null = null;
  let lastAgentResponseTime = Date.now();
  let isAgentSpeaking = false;
  let currentPersonaId = 'morning-coach';

  // Function to prompt agent on silence - now uses the brain
  const promptOnSilence = () => {
    if (isAgentSpeaking) {
      console.log('[Server] Skipping silence prompt - agent is speaking');
      resetSilenceTimer();
      return;
    }

    if (realtimeSession && realtimeSession.ws.readyState === WebSocket.OPEN && sessionBrain) {
      // Tell the brain about the silence
      sessionBrain.recordSilence();

      // Get intelligent instruction from the brain
      const instruction = sessionBrain.generateInstruction();
      const state = sessionBrain.getState();

      console.log(`[Server] Silence detected. Phase: ${state.phase}, Escalation: ${state.escalationLevel}/4`);
      console.log(`[Server] Brain instruction:\n${instruction.substring(0, 200)}...`);

      const event = {
        type: 'response.create',
        response: {
          modalities: ['text', 'audio'],
          instructions: instruction,
        },
      };
      realtimeSession.ws.send(JSON.stringify(event));
    }
  };

  // Reset silence timer
  const resetSilenceTimer = () => {
    const existingTimer = silenceTimers.get(clientWs);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    // Set new timer - 15 seconds of silence before prompting
    const timer = setTimeout(promptOnSilence, 15000);
    silenceTimers.set(clientWs, timer);
  };

  clientWs.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        // ----------------------------------------
        // START SESSION
        // Client sends: { type: 'start', personaId, voiceId, preferences?, context? }
        // ----------------------------------------
        case 'start': {
          const { personaId, voiceId, preferences, context } = message;

          console.log(`[Server] Starting session with persona: ${personaId}, voice: ${voiceId}`);
          currentPersonaId = personaId;

          try {
            const persona = getPersona(personaId);

            // Fetch news if enabled
            let newsHeadlines = '';
            if (preferences?.includeNews !== false && persona.defaults.includeNews) {
              if (GROK_API_KEY) {
                newsHeadlines = await getNewsBriefing(GROK_API_KEY);
              }
            }

            // Build session config
            const sessionConfig = {
              persona,
              voiceId: voiceId || 'soft-female',
              userPreferences: {
                includeNews: preferences?.includeNews ?? persona.defaults.includeNews,
                includeWeather: preferences?.includeWeather ?? persona.defaults.includeWeather,
                includeCalendar: preferences?.includeCalendar ?? persona.defaults.includeCalendar,
              },
              contextData: {
                newsHeadlines,
                weatherInfo: context?.weather || 'Weather information not available.',
                calendarEvents: context?.calendar || 'No calendar events for today.',
                currentTime: new Date().toLocaleTimeString('en-US', {
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                }),
              },
            };

            // Create the session brain for intelligent decision making
            sessionBrain = new WakeSessionBrain(
              personaId,
              {
                includeNews: sessionConfig.userPreferences.includeNews,
                includeWeather: sessionConfig.userPreferences.includeWeather,
                includeCalendar: sessionConfig.userPreferences.includeCalendar,
                includeStories: persona.defaults.includeStories,
              },
              {
                weather: sessionConfig.contextData.weatherInfo,
                calendar: sessionConfig.contextData.calendarEvents,
                news: sessionConfig.contextData.newsHeadlines,
                currentTime: sessionConfig.contextData.currentTime,
              }
            );
            sessionBrains.set(clientWs, sessionBrain);
            console.log('[Server] Session brain initialized');

            // Create OpenAI Realtime session
            realtimeSession = await createRealtimeSession(OPENAI_API_KEY!, sessionConfig);
            activeSessions.set(clientWs, realtimeSession);

            // Forward events from OpenAI to client
            realtimeSession.ws.on('message', (openaiData) => {
              if (clientWs.readyState === WebSocket.OPEN) {
                // Parse and forward the event
                try {
                  const event = JSON.parse(openaiData.toString());

                  // Log all events for debugging
                  if (event.type !== 'response.audio.delta') {
                    console.log(`[OpenAI Event]: ${event.type}`);
                  }

                  // Forward audio and text events to client
                  if (
                    event.type === 'response.audio.delta' ||
                    event.type === 'response.audio_transcript.delta' ||
                    event.type === 'response.text.delta' ||
                    event.type === 'response.done' ||
                    event.type === 'input_audio_buffer.speech_started' ||
                    event.type === 'input_audio_buffer.speech_stopped' ||
                    event.type === 'conversation.item.created' ||
                    event.type === 'response.audio_transcript.done' ||
                    event.type === 'conversation.item.input_audio_transcription.completed'
                  ) {
                    clientWs.send(JSON.stringify(event));
                  }

                  // When agent starts speaking
                  if (event.type === 'response.audio_transcript.delta' && !isAgentSpeaking) {
                    isAgentSpeaking = true;
                    console.log('[Server] Agent started speaking');
                  }

                  // Log what the agent says
                  if (event.type === 'response.audio_transcript.done' && event.transcript) {
                    console.log(`[Agent said]: "${event.transcript}"`);
                  }

                  // When agent finishes speaking, reset silence timer
                  if (event.type === 'response.done') {
                    isAgentSpeaking = false;
                    lastAgentResponseTime = Date.now();
                    resetSilenceTimer();
                    console.log('[Server] Agent finished speaking, silence timer started (20s)');
                  }

                  // When user starts speaking, clear silence timer
                  if (event.type === 'input_audio_buffer.speech_started') {
                    console.log('[Server] >>> User started speaking (VAD detected voice)');
                    const timer = silenceTimers.get(clientWs);
                    if (timer) clearTimeout(timer);
                  }

                  // When user stops speaking
                  if (event.type === 'input_audio_buffer.speech_stopped') {
                    console.log('[Server] <<< User stopped speaking (VAD detected silence)');
                  }

                  // Log transcriptions and update the brain
                  if (event.type === 'conversation.item.input_audio_transcription.completed') {
                    const transcript = event.transcript || '';
                    console.log(`[User said]: "${transcript}"`);

                    // Tell the brain about the user's response
                    if (sessionBrain && transcript.trim()) {
                      sessionBrain.recordUserResponse(transcript);
                      const state = sessionBrain.getState();
                      console.log(`[Brain] User responded. Phase: ${state.phase}, Responsiveness: ${state.responsiveness}`);
                    }
                  }

                  // Log when response is being generated
                  if (event.type === 'response.created') {
                    console.log('[Server] Agent is generating a response...');
                  }
                } catch (e) {
                  // Forward raw if can't parse
                  clientWs.send(openaiData.toString());
                }
              }
            });

            realtimeSession.ws.on('close', () => {
              console.log('[Server] OpenAI connection closed');
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ type: 'session.ended' }));
              }
            });

            // Notify client that session is ready
            clientWs.send(
              JSON.stringify({
                type: 'session.ready',
                sessionId: realtimeSession.sessionId,
                persona: {
                  id: persona.id,
                  name: persona.name,
                },
              })
            );

            // Trigger the agent to start speaking (wait longer to ensure session is ready)
            setTimeout(() => {
              if (realtimeSession) {
                console.log('[Server] Triggering initial greeting...');
                triggerAgentResponse(realtimeSession);
              }
            }, 1000);
          } catch (error) {
            console.error('[Server] Failed to start session:', error);
            clientWs.send(
              JSON.stringify({
                type: 'error',
                message: 'Failed to start session',
              })
            );
          }
          break;
        }

        // ----------------------------------------
        // AUDIO INPUT
        // Client sends: { type: 'audio', data: base64 }
        // ----------------------------------------
        case 'audio': {
          if (realtimeSession) {
            const audioBuffer = Buffer.from(message.data, 'base64');
            sendAudio(realtimeSession, audioBuffer);
          }
          break;
        }

        // ----------------------------------------
        // END SESSION
        // Client sends: { type: 'end' }
        // ----------------------------------------
        case 'end': {
          if (realtimeSession) {
            endSession(realtimeSession);
            activeSessions.delete(clientWs);
            realtimeSession = null;
          }
          clientWs.send(JSON.stringify({ type: 'session.ended' }));
          break;
        }

        default:
          console.log(`[Server] Unknown message type: ${message.type}`);
      }
    } catch (error) {
      console.error('[Server] Error processing message:', error);
    }
  });

  clientWs.on('close', () => {
    console.log('[Server] Client disconnected');
    // Clear silence timer
    const timer = silenceTimers.get(clientWs);
    if (timer) {
      clearTimeout(timer);
      silenceTimers.delete(clientWs);
    }
    // Clean up brain
    sessionBrains.delete(clientWs);
    // Clean up realtime session
    if (realtimeSession) {
      endSession(realtimeSession);
      activeSessions.delete(clientWs);
    }
  });

  clientWs.on('error', (error) => {
    console.error('[Server] Client WebSocket error:', error);
  });
});

// ============================================
// START SERVER
// ============================================

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                    WAKE UP BETTER                          ║
║                    Backend Server                          ║
╠════════════════════════════════════════════════════════════╣
║  HTTP Server:  http://localhost:${PORT}                      ║
║  WebSocket:    ws://localhost:${PORT}/ws                     ║
║  Test Page:    http://localhost:${PORT}                      ║
╠════════════════════════════════════════════════════════════╣
║  API Endpoints:                                            ║
║  - GET /api/personas  - List available personas            ║
║  - GET /api/voices    - List available voices              ║
║  - GET /api/health    - Health check                       ║
╚════════════════════════════════════════════════════════════╝
  `);
});
