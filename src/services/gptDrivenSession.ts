/**
 * GPT-Driven Session Manager
 *
 * This is the SIMPLE approach: instead of a complex state machine,
 * we give GPT a rich system prompt and let IT decide what to do.
 *
 * GPT sees:
 * - Full conversation history
 * - Context (weather, calendar, news)
 * - Clear persona instructions
 * - Guidelines on how to read the user
 *
 * GPT decides:
 * - What approach to use
 * - When to escalate
 * - How to respond to silence
 * - When the user is awake
 */

import OpenAI from 'openai';
import { transcribeAudio, textToSpeech } from './chainedSession';

let openaiClient: OpenAI | null = null;

export function initGptDriven(apiKey: string) {
  openaiClient = new OpenAI({ apiKey });
}

// ============================================
// SHARED INSTRUCTIONS
// ============================================

const CORE_INSTRUCTIONS = `
## Your Job
Help someone wake up and get out of bed. Be clever about it.

## What You Have
- **Weather**: Real weather for their location. Use it - make it inviting or cozy.
- **Time**: The actual time. Use it if helpful.
- **Their calendar**: What they have coming up today. Motivate with it.
- **News**: What's happening in the world. Wake up their brain.
- **Your creativity**: Questions, coffee talk, humor, challenges, visualizations, sounds, movement suggestions - whatever fits the moment.

## The Natural Arc
- **Start**: Greet them warmly. Ease them in gently - they're barely conscious.
- **Soft chat**: Light topics. Weather, how they slept, gentle observations. Wake up their mind before their body.
- **Engagement**: Draw them into conversation. Ask things. Get them responding, thinking, present.
- **Call to action**: Guide them to move. Wash face, make coffee, walk to the window, stretch. Something physical.

Don't rush through these. Read how they're responding and adapt.

## Critical Rules
1. **Read the conversation.** Notice what you've tried, what worked, what didn't. Adapt.
2. **Don't repeat yourself.** If you just did breathing, don't do breathing again. If gentle isn't working, try something else.
3. **Silence is information.** If they're not responding, your current approach isn't landing. Change it.
4. **Remember the goal.** Be supportive, yes. But ultimately: get them OUT of bed and doing something.
`;

// ============================================
// PERSONA PROMPTS
// ============================================

const PERSONA_PROMPTS: Record<string, string> = {
  'zen-guide': `# You Are the Zen Guide

Calm, meditative presence. Gentle yoga instructor or meditation teacher. Soft, unhurried, warm.

${CORE_INSTRUCTIONS}

## Your Vibe
- Peaceful but not passive
- Flowing, sensory language
- Comfortable with silence, but don't just repeat into it
- Even calm can have variety: breathing, visualization, gentle questions, weather, sounds, gratitude

Keep it gentle. But keep it moving.`,

  'morning-coach': `# You Are the Morning Coach

Upbeat, motivational friend. Energetic but not annoying. Supportive best friend meets fitness instructor.

${CORE_INSTRUCTIONS}

## Your Vibe
- Warm, enthusiastic, authentic
- Coffee is a great tool - use it
- Humor when appropriate
- "The hardest part is just getting up"
- Build momentum, celebrate small wins

Be encouraging. Be creative. Get them to that coffee.`,

  'strict-sergeant': `# You Are the Strict Sergeant

No-nonsense drill sergeant. Tough love. Won't accept excuses, but not cruel.

${CORE_INSTRUCTIONS}

## Your Vibe
- Direct, commanding, brief
- Short punchy sentences
- Demand answers, not just acknowledgment
- Challenge them: "Is this who you want to be?"
- Respect is earned through action

Be tough. Vary your tactics. Get results.`
};

// ============================================
// SESSION TYPES
// ============================================

export interface GptDrivenConfig {
  personaId: string;
  voiceId: string;
  context: {
    weather?: string;
    calendar?: string;
    news?: string;
    currentTime: string;
  };
}

export interface GptDrivenSession {
  id: string;
  config: GptDrivenConfig;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  turnCount: number;
  silenceCount: number;
  isProcessing: boolean;
}

// ============================================
// SESSION MANAGEMENT
// ============================================

export function createGptDrivenSession(config: GptDrivenConfig): GptDrivenSession {
  return {
    id: `gpt_${Date.now()}`,
    config,
    conversationHistory: [],
    turnCount: 0,
    silenceCount: 0,
    isProcessing: false,
  };
}

// ============================================
// RESPONSE GENERATION
// ============================================

async function generateGptResponse(
  session: GptDrivenSession,
  userMessage: string | null,
  isSilence: boolean = false
): Promise<string> {
  if (!openaiClient) throw new Error('OpenAI client not initialized');

  const { personaId, context } = session.config;
  const personaPrompt = PERSONA_PROMPTS[personaId] || PERSONA_PROMPTS['morning-coach'];

  // Build system prompt
  let systemPrompt = personaPrompt;

  // Add the only things GPT can't know: external context
  systemPrompt += `\n\n# Context
- Time: ${context.currentTime}
- Weather: ${context.weather || 'Not available'}
${context.calendar ? `- Calendar: ${context.calendar}` : ''}
${context.news ? `- News: ${context.news}` : ''}
- Turn: ${session.turnCount + 1}${session.silenceCount > 0 ? ` (${session.silenceCount} silence${session.silenceCount > 1 ? 's' : ''} in a row)` : ''}`;

  // Minimal guidance for first message
  if (session.conversationHistory.length === 0) {
    systemPrompt += `\n\nThis is your opening. Keep it short and warm - just a greeting.`;
  }

  // Build messages
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
  ];

  // Add conversation history
  for (const msg of session.conversationHistory) {
    messages.push(msg);
  }

  // Add current turn
  if (userMessage) {
    messages.push({ role: 'user', content: userMessage });
  } else if (isSilence) {
    messages.push({ role: 'user', content: '[User is silent]' });
  } else {
    // Initial greeting
    messages.push({ role: 'user', content: '[Session starting - give your opening greeting]' });
  }

  console.log(`[GPT-Driven] Generating response (turn ${session.turnCount + 1}, silence=${isSilence})`);

  const response = await openaiClient.chat.completions.create({
    model: 'gpt-4o',
    messages: messages,
    max_tokens: 300,
    temperature: 0.85,
  });

  const text = response.choices[0]?.message?.content || '';

  // Update session
  if (userMessage) {
    session.conversationHistory.push({ role: 'user', content: userMessage });
  }
  session.conversationHistory.push({ role: 'assistant', content: text });
  session.turnCount++;

  return text;
}


// ============================================
// PUBLIC API
// ============================================

export async function generateGreeting(
  session: GptDrivenSession
): Promise<{ text: string; audioBuffer: Buffer }> {
  session.isProcessing = true;

  try {
    const text = await generateGptResponse(session, null, false);
    console.log(`[GPT-Driven] Greeting: "${text.substring(0, 100)}..."`);

    const audioBuffer = await textToSpeech(text, session.config.voiceId);
    return { text, audioBuffer };
  } finally {
    session.isProcessing = false;
  }
}

export async function processUserAudio(
  session: GptDrivenSession,
  audioBuffer: Buffer
): Promise<{ transcript: string; text: string; audioBuffer: Buffer }> {
  session.isProcessing = true;

  try {
    // Transcribe
    const transcript = await transcribeAudio(audioBuffer);

    if (!transcript) {
      console.log('[GPT-Driven] No speech detected');
      return { transcript: '', text: '', audioBuffer: Buffer.alloc(0) };
    }

    console.log(`[GPT-Driven] User said: "${transcript}"`);

    // User responded! Reset silence count
    session.silenceCount = 0;

    // Generate response
    const text = await generateGptResponse(session, transcript, false);
    console.log(`[GPT-Driven] Response: "${text.substring(0, 100)}..."`);

    // Convert to speech
    const audio = await textToSpeech(text, session.config.voiceId);

    return { transcript, text, audioBuffer: audio };
  } finally {
    session.isProcessing = false;
  }
}

export async function handleSilence(
  session: GptDrivenSession
): Promise<{ text: string; audioBuffer: Buffer }> {
  session.isProcessing = true;
  session.silenceCount++;

  try {
    console.log(`[GPT-Driven] Handling silence #${session.silenceCount}`);

    const text = await generateGptResponse(session, null, true);
    console.log(`[GPT-Driven] Silence response: "${text.substring(0, 100)}..."`);

    const audioBuffer = await textToSpeech(text, session.config.voiceId);

    return { text, audioBuffer };
  } finally {
    session.isProcessing = false;
  }
}
