/**
 * OpenAI Realtime API Session Manager
 *
 * Handles WebSocket connections to OpenAI's Realtime API for
 * speech-to-speech voice conversations.
 *
 * Reference: https://platform.openai.com/docs/guides/realtime
 */

import WebSocket from 'ws';
import { Persona } from '../config/personas';

// OpenAI Realtime API endpoint
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';
const MODEL = 'gpt-4o-realtime-preview-2024-12-17';

// Available voices in OpenAI Realtime API (updated Dec 2024)
// Options: 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'
export type OpenAIVoice = 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse' | 'marin' | 'cedar';

// Voice mapping for user-friendly names
export const VOICE_OPTIONS: Record<string, { id: OpenAIVoice; description: string }> = {
  'soft-female': { id: 'shimmer', description: 'Soft, warm female voice' },
  'warm-male': { id: 'echo', description: 'Calm, reassuring male voice' },
  'energetic-female': { id: 'coral', description: 'Bright, energetic female voice' },
  'energetic-male': { id: 'ash', description: 'Strong, motivating male voice' },
  'neutral-1': { id: 'alloy', description: 'Balanced, neutral voice' },
  'neutral-2': { id: 'sage', description: 'Wise, thoughtful voice' },
};

export interface SessionConfig {
  persona: Persona;
  voiceId: string;
  userPreferences: {
    includeNews: boolean;
    includeWeather: boolean;
    includeCalendar: boolean;
  };
  contextData: {
    newsHeadlines?: string;
    weatherInfo?: string;
    calendarEvents?: string;
    currentTime: string;
  };
}

export interface RealtimeSession {
  ws: WebSocket;
  sessionId: string;
  config: SessionConfig;
}

/**
 * Build the system prompt for the wake-up session
 * Combines persona prompt with context data
 */
function buildSystemPrompt(config: SessionConfig): string {
  const { persona, contextData, userPreferences } = config;

  let contextSection = `\n\n# Current Context\n`;
  contextSection += `- Current time: ${contextData.currentTime}\n`;

  if (userPreferences.includeCalendar && contextData.calendarEvents) {
    contextSection += `\n## Today's Calendar\n${contextData.calendarEvents}\n`;
  }

  if (userPreferences.includeNews && contextData.newsHeadlines) {
    contextSection += `\n## News Headlines (use naturally in conversation)\n${contextData.newsHeadlines}\n`;
  }

  if (userPreferences.includeWeather && contextData.weatherInfo) {
    contextSection += `\n## Weather\n${contextData.weatherInfo}\n`;
  }

  // Add user preference overrides
  let preferencesSection = `\n\n# User Preferences\n`;
  preferencesSection += `- News: ${userPreferences.includeNews ? 'Include if appropriate' : 'DO NOT mention news'}\n`;
  preferencesSection += `- Weather: ${userPreferences.includeWeather ? 'Include if appropriate' : 'DO NOT mention weather'}\n`;
  preferencesSection += `- Calendar: ${userPreferences.includeCalendar ? 'Include if appropriate' : 'DO NOT mention calendar'}\n`;

  // Add voice command handling
  const voiceCommandsSection = `
\n\n# Voice Commands
The user may give you commands during the session. Handle these naturally:
- "Skip news" / "No news" → Stop mentioning news, acknowledge briefly
- "Skip weather" / "No weather" → Stop mentioning weather, acknowledge briefly
- "Be gentler" / "Too intense" → Soften your approach
- "Be more firm" / "I need more push" → Escalate your intensity
- "I'm awake" / "I'm up" → Verify with movement challenge, then end warmly
`;

  return persona.systemPrompt + contextSection + preferencesSection + voiceCommandsSection;
}

/**
 * Create a new Realtime API session
 */
export async function createRealtimeSession(
  apiKey: string,
  config: SessionConfig
): Promise<RealtimeSession> {
  return new Promise((resolve, reject) => {
    // Get the OpenAI voice ID from our friendly name
    const voiceOption = VOICE_OPTIONS[config.voiceId] || VOICE_OPTIONS['neutral-1'];
    const openaiVoice = voiceOption.id;

    // Connect to OpenAI Realtime API
    const ws = new WebSocket(`${OPENAI_REALTIME_URL}?model=${MODEL}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    let sessionId = '';

    ws.on('open', () => {
      console.log('[RealtimeSession] Connected to OpenAI Realtime API');

      // Configure the session
      const sessionConfig = {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: buildSystemPrompt(config),
          voice: openaiVoice,
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'whisper-1',
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.8,              // Higher = less sensitive to background noise
            prefix_padding_ms: 400,
            silence_duration_ms: 1200,   // Wait longer before considering speech "done"
          },
        },
      };

      ws.send(JSON.stringify(sessionConfig));
    });

    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());

        if (event.type === 'session.created') {
          sessionId = event.session.id;
          console.log(`[RealtimeSession] Session created: ${sessionId}`);
          resolve({
            ws,
            sessionId,
            config,
          });
        }

        if (event.type === 'session.updated') {
          console.log('[RealtimeSession] Session configured successfully');
        }

        if (event.type === 'error') {
          console.error('[RealtimeSession] Error:', event.error);
        }
      } catch (e) {
        console.error('[RealtimeSession] Failed to parse message:', e);
      }
    });

    ws.on('error', (error) => {
      console.error('[RealtimeSession] WebSocket error:', error);
      reject(error);
    });

    ws.on('close', (code, reason) => {
      console.log(`[RealtimeSession] Connection closed: ${code} - ${reason}`);
    });

    // Timeout if connection takes too long
    setTimeout(() => {
      if (!sessionId) {
        ws.close();
        reject(new Error('Connection timeout'));
      }
    }, 10000);
  });
}

/**
 * Send audio data to the session
 */
export function sendAudio(session: RealtimeSession, audioData: Buffer): void {
  if (session.ws.readyState !== WebSocket.OPEN) {
    console.warn('[RealtimeSession] Cannot send audio - connection not open');
    return;
  }

  const event = {
    type: 'input_audio_buffer.append',
    audio: audioData.toString('base64'),
  };

  session.ws.send(JSON.stringify(event));
}

/**
 * Trigger the agent to start speaking (for initial greeting)
 */
export function triggerAgentResponse(session: RealtimeSession): void {
  if (session.ws.readyState !== WebSocket.OPEN) {
    console.warn('[RealtimeSession] Cannot trigger response - connection not open');
    return;
  }

  // Send a response.create event to start the conversation
  const event = {
    type: 'response.create',
    response: {
      modalities: ['text', 'audio'],
      instructions: 'Begin the wake-up session with your opening greeting. The user just tapped to start the alarm.',
    },
  };

  session.ws.send(JSON.stringify(event));
}

/**
 * End the session
 */
export function endSession(session: RealtimeSession): void {
  if (session.ws.readyState === WebSocket.OPEN) {
    session.ws.close(1000, 'Session ended by user');
  }
}

/**
 * Update session with new preferences mid-conversation
 */
export function updateSessionPreferences(
  session: RealtimeSession,
  preferences: Partial<SessionConfig['userPreferences']>
): void {
  if (session.ws.readyState !== WebSocket.OPEN) {
    return;
  }

  // Update the stored config
  Object.assign(session.config.userPreferences, preferences);

  // Send updated instructions
  const event = {
    type: 'session.update',
    session: {
      instructions: buildSystemPrompt(session.config),
    },
  };

  session.ws.send(JSON.stringify(event));
}
