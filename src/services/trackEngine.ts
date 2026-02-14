/**
 * Track Engine
 *
 * Controls the wake-up session flow. Code manages the track,
 * GPT generates content for each segment.
 *
 * Track Engine controls:
 * - Current segment position
 * - When to advance segments
 * - Conversation mode detection
 * - Silence timing
 *
 * GPT controls:
 * - Content for each segment
 * - Tone based on persona
 * - Natural variation in wording
 */

import OpenAI from 'openai';
import { textToSpeech, transcribeAudio } from './chainedSession';

// ============================================
// TYPES
// ============================================

export type SegmentType =
  | 'greeting'
  | 'weather'
  | 'visualization'
  | 'fact'
  | 'news'
  | 'calendar'
  | 'engagement'
  | 'callToAction'
  | 'music';

export type PersonaType = 'zen-guide' | 'morning-coach' | 'strict-sergeant';

export interface SegmentConfig {
  type: SegmentType;
  enabled: boolean;
  data?: Record<string, unknown>;  // Segment-specific data (weather data, calendar events, etc.)
}

export interface TrackConfig {
  personaId: PersonaType;
  voiceId: string;
  userName: string;
  segmentOrder: SegmentConfig[];

  // External data
  weather?: WeatherData;
  calendar?: CalendarEvent[];
  news?: NewsItem[];
  facts?: string[];  // Pool of interesting facts

  // User preferences
  newsThemes?: string[];  // ['technology', 'culture', 'finance']
  spotifyPlaylistId?: string;
}

export interface WeatherData {
  currentTemp: number;
  feelsLike: number;
  conditions: string;
  windDirection: string;
  windStrength: string;
  precipChance: number;
  precipTiming?: string;
  highTemp: number;
  eveningTemp: number;
  uvIndex: number;
  airQuality?: string;  // Only if notable
  nightSummary?: string;  // "It was a rainy night..."
}

export interface CalendarEvent {
  title: string;
  time: string;
}

export interface NewsItem {
  headline: string;
  summary: string;
  theme: string;
}

export interface TrackState {
  sessionId: string;
  currentSegmentIndex: number;
  conversationMode: boolean;
  factsUsed: number;  // How many facts we've delivered

  // History for variation
  segmentHistory: {
    segment: SegmentType;
    content: string;
    timestamp: Date;
  }[];

  // Track facts that have been used (to avoid repetition)
  usedFacts: string[];

  // Full conversation history
  conversationHistory: { role: 'user' | 'assistant'; content: string }[];

  // Track recent conversation for smooth transitions
  recentConversation: { role: 'user' | 'assistant'; content: string }[];
  justExitedConversation: boolean;

  // Timing
  lastAgentSpokeAt: Date;
  isProcessing: boolean;
}

// ============================================
// PERSONA DEFINITIONS
// ============================================

const PERSONA_TONES: Record<PersonaType, string> = {
  'zen-guide': `Tone: Calm, warm, grounded. Like meditation app voice. Wise like a spiritual guru.

How you speak:
- Conversational and present
- Gentle pacing
- Soothing

Avoid:
- Emojis (this is spoken audio)
- Filler words like "Ah," "Oh," "Well,"
- Saying "friend" or "dear friend" constantly - use their name sometimes, or nothing
- Overly poetic phrases like "embrace this moment" or "let this unfold like a meditation"`,

  'morning-coach': `Tone: Warm, upbeat, friendly. Like a supportive friend who's already had their coffee.

How you speak:
- Conversational and natural
- Positive energy
- Direct and clear
- Light humor when it fits
- Light teasing when it fits

Avoid:
- Emojis (this is spoken audio)
- Filler words like "Ah," "Oh," "Well,"
- Overusing their name or "friend" - just talk naturally`,

  'strict-sergeant': `Tone: Direct, no-nonsense, a bit sarcastic. Like a friend who calls you out.

How you speak:
- Light roasting and guilt-tripping
- Challenges them

Avoid:
- Emojis (this is spoken audio)
- Filler words like "Ah," "Oh," "Well,"`,
};

// ============================================
// SEGMENT PROMPTS
// ============================================

const SEGMENT_PROMPTS: Record<SegmentType, string> = {
  greeting: `Generate the GREETING segment.

This is the START of the conversation.
- "Good morning" + their name
- Ask ONE light question about their night/sleep/dreams
- 1-2 sentences total`,

  weather: `Generate the WEATHER segment.

This is MID-CONVERSATION. Do not greet them or say hello again.

Start with a brief transition sentence, then cover:
- Current temp and feels-like
- Conditions (cloudy, sunny, etc)
- Wind
- Rain chance if notable
- High for the day
- Evening temp
- UV if notable

4-5 sentences total. Conversational, like telling a friend.`,

  visualization: `Generate the VISUALIZATION segment.

This is MID-CONVERSATION. Do not greet them or say hello again.

Start with a brief sentence to ease them into it, then paint a nature scene:
- Pick one: ocean, forest, mountain, rain, campfire, meadow
- Sensory details: see, hear, feel, smell
- 5-6 sentences
- Calm pacing`,

  fact: `Generate the FACT segment.

This is MID-CONVERSATION. Do not greet them or say hello again.

Start with a brief intro, then share ONE interesting fact.
- Surprising or curiosity-sparking
- 2-3 sentences total

At the end of your response, add a line with just the core topic of the fact in brackets, like: [octopus hearts] or [honey preservation]
This helps us track what facts have been shared.`,

  news: `Generate the NEWS segment.

This is MID-CONVERSATION. Do not greet them or say hello again.

Brief transition, then 2-3 headlines with one sentence each.
Just the facts, simple and clear.`,

  calendar: `Generate the CALENDAR segment.

This is MID-CONVERSATION. Do not greet them or say hello again.

Brief transition, then list their events:
- Time and title for each
- Simple and clear`,

  engagement: `Generate the ENGAGEMENT QUESTION segment.

This is MID-CONVERSATION. Do not greet them or say hello again.

Ask ONE question about their day ahead - what they're looking forward to, want to accomplish, or how they want to feel.`,

  callToAction: `Generate the CALL TO ACTION segment.

This is MID-CONVERSATION. Do not greet them or say hello again.

IMPORTANT: The user is IN BED. This is a wake-up alarm. They are not on a couch or chair.

Give them ONE physical action to get out of bed:
- Sit up, put feet on the floor, stand up, walk to the window, stretch, etc.

If not the first call to action, pick a DIFFERENT action. Escalate the urgency.`,

  music: `Generate the MUSIC handoff segment.

This is MID-CONVERSATION. Do not greet them or say hello again.

One sentence to hand off to music.`,
};

// ============================================
// GLOBAL FACT STORE (persists across sessions)
// ============================================

// Store used facts globally so they persist across sessions
// Map structure: fact topic (lowercase) -> timestamp when used
const globalUsedFacts = new Map<string, Date>();

// Maximum facts to remember (keep last 100 facts)
const MAX_FACTS_TO_REMEMBER = 100;

// Add used facts to global store
function addUsedFactToGlobalStore(factTopic: string) {
  const topic = factTopic.toLowerCase().trim();
  globalUsedFacts.set(topic, new Date());

  // Clean up old facts if we exceed the limit
  if (globalUsedFacts.size > MAX_FACTS_TO_REMEMBER) {
    // Convert to array and sort by date (oldest first)
    const sortedFacts = Array.from(globalUsedFacts.entries())
      .sort((a, b) => a[1].getTime() - b[1].getTime());

    // Remove oldest facts
    const toRemove = sortedFacts.slice(0, globalUsedFacts.size - MAX_FACTS_TO_REMEMBER);
    for (const [topic] of toRemove) {
      globalUsedFacts.delete(topic);
    }
  }

  console.log(`[FactStore] Stored fact: "${topic}" (total: ${globalUsedFacts.size} facts)`);
}

// Get all used facts from global store
function getAllUsedFacts(): string[] {
  return Array.from(globalUsedFacts.keys());
}

// ============================================
// TRACK ENGINE CLASS
// ============================================

let openaiClient: OpenAI | null = null;

export function initTrackEngine(apiKey: string) {
  openaiClient = new OpenAI({ apiKey });
}

export class TrackEngine {
  private config: TrackConfig;
  private state: TrackState;

  constructor(config: TrackConfig) {
    this.config = config;
    this.state = {
      sessionId: `track_${Date.now()}`,
      currentSegmentIndex: 0,
      conversationMode: false,
      factsUsed: 0,
      segmentHistory: [],
      usedFacts: [],
      conversationHistory: [],
      recentConversation: [],
      justExitedConversation: false,
      lastAgentSpokeAt: new Date(),
      isProcessing: false,
    };
  }

  // Get current segment
  getCurrentSegment(): SegmentConfig | null {
    // Prevent infinite recursion with a max depth
    return this.getCurrentSegmentWithDepth(0);
  }

  private getCurrentSegmentWithDepth(depth: number): SegmentConfig | null {
    // Safety: prevent infinite recursion
    if (depth > this.config.segmentOrder.length) {
      console.warn('[TrackEngine] Max recursion depth reached in getCurrentSegment');
      return null;
    }

    const segment = this.config.segmentOrder[this.state.currentSegmentIndex];
    if (!segment) return null;

    // Skip disabled segments
    if (!segment.enabled) {
      this.state.currentSegmentIndex++;
      return this.getCurrentSegmentWithDepth(depth + 1);
    }

    // Skip calendar if no events
    if (segment.type === 'calendar' && (!this.config.calendar || this.config.calendar.length === 0)) {
      this.state.currentSegmentIndex++;
      return this.getCurrentSegmentWithDepth(depth + 1);
    }

    // Skip news if not configured
    if (segment.type === 'news' && (!this.config.news || this.config.news.length === 0)) {
      this.state.currentSegmentIndex++;
      return this.getCurrentSegmentWithDepth(depth + 1);
    }

    return segment;
  }

  // Advance to next segment
  advanceSegment(): boolean {
    // Special case: stay on callToAction until user is awake
    const current = this.config.segmentOrder[this.state.currentSegmentIndex];
    if (current?.type === 'callToAction') {
      // Don't advance - we'll vary the call to action instead
      console.log('[TrackEngine] Staying on callToAction segment');
      return false;  // Indicate we didn't advance
    }

    this.state.currentSegmentIndex++;
    return true;  // Indicate we advanced
  }

  // Get silence duration (track mode)
  getSilenceDuration(): number {
    return 5000;  // 5 seconds
  }

  // Generate content for current segment
  async generateSegmentContent(): Promise<{ text: string; audioBuffer: Buffer }> {
    if (!openaiClient) throw new Error('OpenAI client not initialized');
    if (this.state.isProcessing) throw new Error('Already processing');

    this.state.isProcessing = true;

    try {
      const segment = this.getCurrentSegment();
      if (!segment) {
        throw new Error('No more segments');
      }

      const prompt = this.buildSegmentPrompt(segment);

      console.log(`[TrackEngine] Generating ${segment.type} segment`);

      const response = await openaiClient.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `Generate the ${segment.type} segment now.` },
        ],
        max_tokens: 500,
        temperature: 0.9,  // Higher for more variation
      });

      let text = response.choices[0]?.message?.content || '';

      // Extract and store fact topic if this is a fact segment
      if (segment.type === 'fact') {
        const factMatch = text.match(/\[([^\]]+)\]\s*$/);
        if (factMatch) {
          const factTopic = factMatch[1].toLowerCase().trim();

          // Add to session state
          this.state.usedFacts.push(factTopic);

          // Add to global persistent store
          addUsedFactToGlobalStore(factTopic);

          // Remove the tag from the spoken text
          text = text.replace(/\s*\[[^\]]+\]\s*$/, '').trim();
        }
        this.state.factsUsed++;
      }

      // Record in history
      this.state.segmentHistory.push({
        segment: segment.type,
        content: text,
        timestamp: new Date(),
      });
      this.state.conversationHistory.push({ role: 'assistant', content: text });
      this.state.lastAgentSpokeAt = new Date();

      // Convert to speech
      const audioBuffer = await textToSpeech(text, this.config.voiceId);

      return { text, audioBuffer };
    } finally {
      this.state.isProcessing = false;
    }
  }

  // Build the prompt for a segment
  private buildSegmentPrompt(segment: SegmentConfig): string {
    const persona = this.config.personaId;
    const personaTone = PERSONA_TONES[persona];
    const segmentRules = SEGMENT_PROMPTS[segment.type];

    let prompt = `# You are the ${persona.replace('-', ' ').replace(/\b\w/g, c => c.toUpperCase())}

${personaTone}

## Your Task
${segmentRules}

## User Name
${this.config.userName}
`;

    // Add segment-specific data
    if (segment.type === 'weather' && this.config.weather) {
      prompt += `
## Weather Data
${JSON.stringify(this.config.weather, null, 2)}
`;
    }

    if (segment.type === 'calendar' && this.config.calendar) {
      prompt += `
## Today's Events
${this.config.calendar.map(e => `- ${e.title} at ${e.time}`).join('\n')}
`;
    }

    if (segment.type === 'news' && this.config.news) {
      prompt += `
## News Items
${this.config.news.map(n => `- ${n.headline}: ${n.summary}`).join('\n')}
`;
    }

    // Add used facts to avoid repetition (from GLOBAL store)
    if (segment.type === 'fact') {
      const allUsedFacts = getAllUsedFacts();
      if (allUsedFacts.length > 0) {
        prompt += `
## Facts Already Used (DO NOT repeat these topics)
${allUsedFacts.map(f => `- ${f}`).join('\n')}

Pick a completely different topic. Be creative and find something totally new.
`;
      }
    }

    // Add history for variation
    const previousAttempts = this.state.segmentHistory
      .filter(h => h.segment === segment.type)
      .slice(-3)
      .map(h => h.content);

    if (previousAttempts.length > 0) {
      prompt += `
## Previous Attempts (DO NOT repeat these patterns or phrases)
${previousAttempts.map((p, i) => `${i + 1}. "${p.substring(0, 200)}..."`).join('\n')}

Generate something FRESH and DIFFERENT.
`;
    }

    // Add conversation context if just exited conversation mode
    if (this.state.justExitedConversation && this.state.recentConversation.length > 0) {
      const convoText = this.state.recentConversation
        .map(msg => `${msg.role === 'user' ? 'User' : 'You'}: "${msg.content}"`)
        .join('\n');

      prompt += `
## Recent Conversation
You just had a brief conversation with the user:
${convoText}

Now continue with the ${segment.type} segment. Transition naturally - a brief acknowledgment or smooth segue works well.
`;
    }

    return prompt;
  }

  // Handle user speech
  async handleUserSpeech(audioBuffer: Buffer): Promise<{ transcript: string; text: string; audioBuffer: Buffer } | null> {
    if (this.state.isProcessing) {
      console.log('[TrackEngine] Already processing, ignoring audio');
      return null;
    }

    this.state.isProcessing = true;

    try {
      console.log(`[TrackEngine] Transcribing ${audioBuffer.length} bytes of audio...`);
      const transcript = await transcribeAudio(audioBuffer);

      if (!transcript || transcript.trim() === '') {
        console.log('[TrackEngine] No transcript returned (silence or noise)');
        return null;
      }

      // Filter out common false positives from Whisper
      const falsePositives = [
        'okay', 'ok', 'um', 'uh', 'hmm', 'mm', 'ah', 'oh',
        'you', 'the', 'a', 'i', 'it', 'so', 'bye', 'thank you',
        'thanks for watching', 'subscribe', // YouTube artifacts Whisper sometimes hallucinates
      ];
      const cleanTranscript = transcript.trim().toLowerCase();
      if (falsePositives.includes(cleanTranscript)) {
        console.log(`[TrackEngine] Filtered out likely false positive: "${transcript}"`);
        return null;
      }

      console.log(`[TrackEngine] User said: "${transcript}"`);

      // Enter conversation mode
      this.state.conversationMode = true;
      this.state.conversationHistory.push({ role: 'user', content: transcript });

      // Generate conversational response
      const response = await this.generateConversationResponse(transcript);

      this.state.conversationHistory.push({ role: 'assistant', content: response });
      this.state.lastAgentSpokeAt = new Date();

      // Check if conversation is ending (short response from user)
      const isShortResponse = transcript.split(/\s+/).length <= 3;
      if (isShortResponse) {
        // Will exit conversation mode on next silence
      }

      const audio = await textToSpeech(response, this.config.voiceId);

      return { transcript, text: response, audioBuffer: audio };
    } finally {
      this.state.isProcessing = false;
    }
  }

  // Detect if user is trying to sleep/dismiss/snooze
  private detectSleepIntent(message: string): boolean {
    const lowerMsg = message.toLowerCase();
    const sleepPatterns = [
      'go to sleep', 'going to sleep', 'back to sleep', 'let me sleep',
      'want to sleep', 'wanna sleep', 'need sleep', 'more sleep',
      'be quiet', 'shut up', 'stop', 'go away', 'leave me alone',
      'five more minutes', '5 more minutes', 'snooze', 'later',
      'not now', 'too tired', 'so tired', 'exhausted',
      'turn off', 'stop talking', 'be silent', 'quiet',
    ];
    return sleepPatterns.some(pattern => lowerMsg.includes(pattern));
  }

  // Generate a conversational response
  private async generateConversationResponse(userMessage: string): Promise<string> {
    if (!openaiClient) throw new Error('OpenAI client not initialized');

    const persona = this.config.personaId;
    const personaTone = PERSONA_TONES[persona];
    const currentSegment = this.getCurrentSegment();

    // Check if user is trying to go back to sleep
    const isTryingToSleep = this.detectSleepIntent(userMessage);

    let systemPrompt: string;

    if (isTryingToSleep) {
      // Special prompt for accountability - don't let them off the hook
      systemPrompt = `# You are the ${persona.replace('-', ' ').replace(/\b\w/g, c => c.toUpperCase())}

${personaTone}

The user is trying to go back to sleep or dismiss you. DO NOT let them off the hook.

Remember: They set this alarm themselves because they wanted to wake up. Your job is to help them follow through.

Tell them (in your persona's style):
- You understand it's hard, but they set this alarm for a reason
- You can't stop until they actually get up
- They need to stand up and take a few steps - that's how you'll know they're awake
- Once they're up, you can wrap up

Be firm but caring. This is accountability, not cruelty.

User's name: ${this.config.userName}`;
    } else {
      // Normal conversational response
      systemPrompt = `# You are the ${persona.replace('-', ' ').replace(/\b\w/g, c => c.toUpperCase())}

${personaTone}

You're in the middle of a wake-up session. The user just said something.
Respond briefly - acknowledge what they said, answer if they asked a question.

IMPORTANT: Do NOT ask follow-up questions. Do NOT try to keep the conversation going.
Just respond and stop. The wake-up track will continue automatically.

Current segment: ${currentSegment?.type || 'unknown'}
User's name: ${this.config.userName}`;
    }

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
    ];

    // Add recent conversation history
    const recentHistory = this.state.conversationHistory.slice(-6);
    for (const msg of recentHistory) {
      messages.push(msg);
    }

    const response = await openaiClient.chat.completions.create({
      model: 'gpt-4o',
      messages,
      max_tokens: 200,
      temperature: 0.85,
    });

    return response.choices[0]?.message?.content || '';
  }

  // Handle silence - either advance segment or stay in conversation mode
  async handleSilence(): Promise<{ text: string; audioBuffer: Buffer; action: 'segment' | 'waiting' }> {
    // If in conversation mode, exit and resume track
    if (this.state.conversationMode) {
      console.log(`[TrackEngine] Exiting conversation mode, resuming track`);

      // Store recent conversation for smooth transition
      // Get the conversation exchanges that happened during conversation mode
      const recentExchanges = this.state.conversationHistory.slice(-4);  // Last 2 exchanges (user + assistant each)
      this.state.recentConversation = recentExchanges;
      this.state.justExitedConversation = true;

      this.state.conversationMode = false;
    }

    // Try to advance to next segment
    const advanced = this.advanceSegment();

    if (!advanced) {
      // We're on callToAction - generate a NEW call to action variation
      console.log('[TrackEngine] Generating new callToAction variation');
    }

    // Generate content for current segment
    const result = await this.generateSegmentContent();

    // Clear the flag after generating content
    this.state.justExitedConversation = false;
    this.state.recentConversation = [];

    return { ...result, action: 'segment' };
  }

  // Mark user as awake (called when movement is detected)
  markAwake(): void {
    // Move past callToAction to music
    while (this.getCurrentSegment()?.type === 'callToAction') {
      this.state.currentSegmentIndex++;
    }
  }

  // Getters
  getState(): TrackState {
    return { ...this.state };
  }

  isInConversationMode(): boolean {
    return this.state.conversationMode;
  }

  isComplete(): boolean {
    return this.state.currentSegmentIndex >= this.config.segmentOrder.length;
  }
}

// ============================================
// DEFAULT SEGMENT ORDER
// ============================================

export function getDefaultSegmentOrder(): SegmentConfig[] {
  return [
    { type: 'greeting', enabled: true },
    { type: 'weather', enabled: true },
    { type: 'visualization', enabled: true },
    { type: 'fact', enabled: true },
    { type: 'news', enabled: true },
    { type: 'calendar', enabled: true },
    { type: 'fact', enabled: true },  // Second fact
    { type: 'engagement', enabled: true },
    { type: 'callToAction', enabled: true },
    { type: 'music', enabled: true },
  ];
}
