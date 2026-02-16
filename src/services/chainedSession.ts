/**
 * Chained Architecture Session Manager
 *
 * This implements the STT → GPT → TTS pipeline:
 * 1. Speech-to-Text: User audio → text transcript (Whisper)
 * 2. GPT Processing: Transcript + brain state → response text
 * 3. Text-to-Speech: Response text → audio (TTS)
 *
 * Benefits over Realtime API:
 * - Full control over each step
 * - Brain can inject state on every turn
 * - Much cheaper (~10x)
 * - Easier to debug (text in, text out)
 *
 * Tradeoff:
 * - Higher latency (~1-2 seconds per turn)
 */

import OpenAI from 'openai';
import { Persona } from '../config/personas';
import { WakeSessionBrain } from './wakeSessionBrain';

// Initialize OpenAI client
let openaiClient: OpenAI | null = null;

export function initOpenAI(apiKey: string) {
  openaiClient = new OpenAI({ apiKey });
}

export interface ChainedSessionConfig {
  persona: Persona;
  voiceId: string;
  preferences: {
    includeNews: boolean;
    includeWeather: boolean;
    includeCalendar: boolean;
    includeStories: boolean;
  };
  context: {
    weather?: string;
    calendar?: string;
    news?: string;
    currentTime: string;
  };
}

export interface ChainedSession {
  id: string;
  config: ChainedSessionConfig;
  brain: WakeSessionBrain;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  isProcessing: boolean;
}

// Voice mapping for TTS
const TTS_VOICES: Record<string, 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer'> = {
  'soft-female': 'shimmer',
  'warm-male': 'echo',
  'energetic-female': 'nova',
  'energetic-male': 'onyx',
  'neutral-1': 'alloy',
  'neutral-2': 'fable',
};

/**
 * Create a new chained session
 */
export function createChainedSession(config: ChainedSessionConfig): ChainedSession {
  const brain = new WakeSessionBrain(
    config.persona.id,
    config.preferences,
    config.context
  );

  return {
    id: `chained_${Date.now()}`,
    config,
    brain,
    conversationHistory: [],
    isProcessing: false,
  };
}

/**
 * Detect audio format from buffer header
 */
function detectAudioFormat(buffer: Buffer): { mimeType: string; extension: string } {
  // Check for WAV header (RIFF....WAVE)
  if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && // RIFF
      buffer[8] === 0x57 && buffer[9] === 0x41 && buffer[10] === 0x56 && buffer[11] === 0x45) { // WAVE
    return { mimeType: 'audio/wav', extension: 'wav' };
  }

  // Check for WebM/Matroska header (0x1A 0x45 0xDF 0xA3)
  if (buffer.length >= 4 &&
      buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) {
    return { mimeType: 'audio/webm', extension: 'webm' };
  }

  // Default to webm for backwards compatibility
  console.log('[Chained] Unknown audio format, defaulting to webm');
  return { mimeType: 'audio/webm', extension: 'webm' };
}

/**
 * Transcribe audio to text using Whisper
 * Uses gpt-4o-transcribe with VAD for better silence handling
 */
export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  if (!openaiClient) throw new Error('OpenAI client not initialized');

  // Detect audio format
  const format = detectAudioFormat(audioBuffer);
  console.log(`[Chained] Detected audio format: ${format.mimeType} (${audioBuffer.length} bytes)`);

  try {
    // Create a File-like object from the buffer with correct format
    const blob = new Blob([new Uint8Array(audioBuffer)], { type: format.mimeType });
    const file = new File([blob], `audio.${format.extension}`, { type: format.mimeType });

    // Use gpt-4o-transcribe with prompt to filter noise
    const response = await openaiClient.audio.transcriptions.create({
      model: 'gpt-4o-transcribe',
      file: file,
      language: 'en',
      // Prompt helps guide the model - tell it this is conversational speech
      prompt: 'This is a person speaking in response to a wake-up alarm. Transcribe only actual spoken words. If there is no speech, return an empty string.',
    });

    const text = response.text?.trim() || '';

    // Additional filter: if it's just punctuation, whitespace, or common noise transcriptions
    const noisePatterns = [
      /^[\s.,!?-]+$/, // Just punctuation/whitespace
      /^\.+$/, // Just dots
      /^(um|uh|hmm|mhm|ah)+$/i, // Just filler sounds (though these might be valid)
      /^thanks for watching\.?$/i, // Common Whisper hallucination
      /^thank you\.?$/i, // Another common hallucination on silence
      /^you$/i, // Single word hallucination
      /^bye\.?$/i, // Common hallucination
    ];

    for (const pattern of noisePatterns) {
      if (pattern.test(text)) {
        console.log(`[Chained] Filtered noise transcript: "${text}"`);
        return '';
      }
    }

    return text;
  } catch (error) {
    console.error('[Chained] Transcription error:', error);
    // Fall back to whisper-1 if gpt-4o-transcribe fails
    try {
      const blob = new Blob([new Uint8Array(audioBuffer)], { type: format.mimeType });
      const file = new File([blob], `audio.${format.extension}`, { type: format.mimeType });

      const response = await openaiClient.audio.transcriptions.create({
        model: 'whisper-1',
        file: file,
        language: 'en',
      });
      return response.text?.trim() || '';
    } catch (fallbackError) {
      console.error('[Chained] Fallback transcription also failed:', fallbackError);
      return '';
    }
  }
}

/**
 * Generate response using GPT-4
 */
export async function generateResponse(
  session: ChainedSession,
  userMessage: string | null  // null for initial greeting or silence prompts
): Promise<string> {
  if (!openaiClient) throw new Error('OpenAI client not initialized');

  const { persona, context } = session.config;
  const brain = session.brain;

  // Log brain state BEFORE generating instruction
  const stateBefore = brain.getState();
  console.log(`[Brain] ──────────────────────────────────────`);
  console.log(`[Brain] Phase: ${stateBefore.phase} | Silence: ${stateBefore.silenceCount} | Responses: ${stateBefore.responseCount}`);
  console.log(`[Brain] Escalation: ${stateBefore.escalationLevel}/4 | Responsiveness: ${stateBefore.responsiveness}`);
  console.log(`[Brain] Tools used: [${stateBefore.toolsUsed.slice(-5).join(', ')}]`);

  // Build the system prompt with brain intelligence
  let systemPrompt = persona.systemPrompt;

  // Add brain-generated instructions
  const brainInstruction = brain.generateInstruction();

  // Log what tool the brain picked
  const stateAfter = brain.getState();
  const lastTool = stateAfter.toolsUsed[stateAfter.toolsUsed.length - 1];
  console.log(`[Brain] Next tool: ${lastTool || 'none'}`);
  console.log(`[Brain] ──────────────────────────────────────`);

  systemPrompt += `\n\n# SESSION BRAIN GUIDANCE\n${brainInstruction}`;

  // Add context
  systemPrompt += `\n\n# CURRENT CONTEXT\nTime: ${context.currentTime}`;
  if (context.weather) systemPrompt += `\nWeather: ${context.weather}`;
  if (context.calendar) systemPrompt += `\nCalendar: ${context.calendar}`;
  if (context.news) systemPrompt += `\nNews: ${context.news}`;

  // Build messages array
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
  ];

  // Add conversation history
  for (const msg of session.conversationHistory) {
    messages.push(msg);
  }

  // Add current user message if exists (and it's not empty/just quotes)
  // Filter out Whisper hallucinations: "", """", """"", etc.
  const isJustQuotes = userMessage ? /^["]+$/.test(userMessage.trim()) : false;
  const hasRealMessage = userMessage && userMessage.trim() && !isJustQuotes;

  if (hasRealMessage) {
    console.log(`[Brain] Recording USER RESPONSE: "${userMessage}"`);
    messages.push({ role: 'user', content: userMessage });
    session.conversationHistory.push({ role: 'user', content: userMessage });

    // Tell brain about user response
    brain.recordUserResponse(userMessage);
  } else if (session.conversationHistory.length === 0) {
    // Initial greeting - no user message yet
    // IMPORTANT: Override brain instruction for greeting - we want it SHORT, NO weather yet
    messages[0].content = persona.systemPrompt + `

# INITIAL GREETING INSTRUCTION
This is your FIRST message. Keep it SHORT and warm:
- Start with "Good morning!" (or afternoon/evening based on time)
- You can add the user's name if you have it
- That's it. Just a warm, simple hello. 1 short sentence max.
- Examples: "Good morning!", "Good morning, hope you're cozy!", "Hey there, good morning!"
- Do NOT mention weather yet - save that for later
- Do NOT ask questions yet
- Do NOT mention calendar
- Do NOT be long-winded

Time: ${context.currentTime}`;

    messages.push({
      role: 'user',
      content: '[Session starting. Give your short, warm opening greeting.]',
    });
  } else if (userMessage !== null) {
    // User sent empty/invalid message - treat as silence
    console.log(`[Brain] Recording SILENCE (empty message: "${userMessage}")`);
    brain.recordSilence();
    messages.push({
      role: 'user',
      content: '[User is silent. Follow the brain guidance above to re-engage them.]',
    });
  } else {
    // Explicit silence (null passed in)
    // NOTE: Don't record silence here - the caller (handleSilence) already did it
    console.log(`[Brain] Silence prompt (caller already recorded silence)`);
    messages.push({
      role: 'user',
      content: '[User is silent. Follow the brain guidance above to re-engage them.]',
    });
  }

  try {
    const response = await openaiClient.chat.completions.create({
      model: 'gpt-4o',
      messages: messages,
      max_tokens: 300,
      temperature: 0.8,
    });

    const assistantMessage = response.choices[0]?.message?.content || '';

    // Store in history
    session.conversationHistory.push({ role: 'assistant', content: assistantMessage });

    return assistantMessage;
  } catch (error) {
    console.error('[Chained] GPT error:', error);
    return "I'm having trouble connecting. Are you still there?";
  }
}

/**
 * Convert text to speech using OpenAI TTS
 */
export async function textToSpeech(
  text: string,
  voiceId: string
): Promise<Buffer> {
  if (!openaiClient) throw new Error('OpenAI client not initialized');

  // Support both direct OpenAI voice names and legacy mappings
  const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
  const voice = validVoices.includes(voiceId) 
    ? voiceId 
    : (TTS_VOICES[voiceId] || 'nova');

  try {
    const response = await openaiClient.audio.speech.create({
      model: 'tts-1',
      voice: voice,
      input: text,
      response_format: 'mp3',  // MP3 format for iOS AVAudioPlayer compatibility
      speed: 1.0,
    });

    // Get the audio data as a buffer
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    console.error('[Chained] TTS error:', error);
    throw error;
  }
}

/**
 * Process a complete turn: transcribe → generate → speak
 */
export async function processUserAudio(
  session: ChainedSession,
  audioBuffer: Buffer
): Promise<{ transcript: string; response: string; audioBuffer: Buffer }> {
  session.isProcessing = true;

  try {
    // Step 1: Transcribe (now handles noise filtering internally)
    console.log('[Chained] Step 1: Transcribing audio...');
    const transcript = await transcribeAudio(audioBuffer);

    // If transcript is empty after noise filtering, skip response
    if (!transcript) {
      console.log('[Chained] No valid speech detected, skipping response');
      return {
        transcript: '',
        response: '',
        audioBuffer: Buffer.alloc(0)
      };
    }

    console.log(`[Chained] Valid transcript: "${transcript}"`);

    // Step 2: Generate response
    console.log('[Chained] Step 2: Generating response...');
    const response = await generateResponse(session, transcript);
    console.log(`[Chained] Response: "${response.substring(0, 100)}..."`);

    // Step 3: Convert to speech
    console.log('[Chained] Step 3: Converting to speech...');
    const audioResponse = await textToSpeech(response, session.config.voiceId);
    console.log(`[Chained] Audio generated: ${audioResponse.length} bytes`);

    return { transcript, response, audioBuffer: audioResponse };
  } finally {
    session.isProcessing = false;
  }
}

/**
 * Generate initial greeting (no user audio)
 */
export async function generateGreeting(
  session: ChainedSession
): Promise<{ response: string; audioBuffer: Buffer }> {
  session.isProcessing = true;

  try {
    // Generate greeting
    console.log('[Chained] Generating initial greeting...');
    console.log('[Chained] Session config:', JSON.stringify({
      personaId: session.config.persona.id,
      voiceId: session.config.voiceId,
    }));

    const response = await generateResponse(session, null);
    console.log(`[Chained] Greeting: "${response.substring(0, 100)}..."`);

    // Convert to speech
    console.log(`[Chained] Converting to speech with voice: ${session.config.voiceId}`);
    const audioResponse = await textToSpeech(response, session.config.voiceId);
    console.log(`[Chained] Audio generated: ${audioResponse.length} bytes`);

    return { response, audioBuffer: audioResponse };
  } catch (error) {
    console.error('[Chained] Error in generateGreeting:', error);
    throw error;
  } finally {
    session.isProcessing = false;
  }
}

/**
 * Handle silence (brain-driven re-engagement)
 */
export async function handleSilence(
  session: ChainedSession
): Promise<{ response: string; audioBuffer: Buffer }> {
  session.isProcessing = true;

  try {
    // Tell brain about silence BEFORE generating response
    console.log(`[Brain] handleSilence() called - recording silence first`);
    session.brain.recordSilence();
    const state = session.brain.getState();
    console.log(`[Brain] After recordSilence: Phase=${state.phase}, SilenceCount=${state.silenceCount}`);

    // Generate response based on brain state
    console.log('[Chained] Handling silence, generating re-engagement...');
    const response = await generateResponse(session, null);
    console.log(`[Chained] Re-engagement: "${response.substring(0, 100)}..."`);

    // Convert to speech
    const audioResponse = await textToSpeech(response, session.config.voiceId);

    return { response, audioBuffer: audioResponse };
  } finally {
    session.isProcessing = false;
  }
}
