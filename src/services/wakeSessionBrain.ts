/**
 * Wake Session Brain
 *
 * This is the "intelligence" behind the wake-up agent. It tracks:
 * - What phase of the wake-up we're in
 * - What approaches have been tried
 * - How responsive the user is being
 * - What to try next
 *
 * The brain provides structured guidance to the voice agent,
 * ensuring it follows a logical progression rather than random attempts.
 */

// ============================================
// SESSION PHASES (redesigned for natural wake-up flow)
// ============================================
export type SessionPhase =
  | 'brain_wakeup'  // First few minutes: JUST stimulate the brain. Weather, facts, gentle chat. NO pressure.
  | 'soft_chat'     // User showing signs of life: continue gentle conversation, maybe mention coffee
  | 'encouragement' // User is engaging OR enough time passed: start encouraging movement, coffee motivation
  | 'movement'      // Time to actually get up: coffee walk, sit up, stand up requests
  | 'verification'  // Confirming user is actually awake and moving
  | 'complete';     // Session successful

// ============================================
// ENGAGEMENT TOOLS (things the agent can try)
// ============================================
export type EngagementTool =
  | 'greeting'           // Initial hello
  | 'how_did_you_sleep'  // Ask about their sleep
  | 'weather'            // Share weather info
  | 'calendar'           // Mention their schedule
  | 'news'               // Share headlines
  | 'gratitude'          // Ask what they're grateful for
  | 'plans_today'        // Ask about their plans
  | 'interesting_fact'   // Share something interesting
  | 'gentle_story'       // Immersive calming visualization
  | 'body_awareness'     // Guide them to notice their body
  | 'breathing'          // Invite a deep breath
  | 'direct_question'    // Ask a direct engaging question
  | 'humor'              // Try to make them smile
  | 'coffee_mention'     // Mention coffee/tea as motivation
  | 'first_step_insight' // "The hardest part is getting up"
  | 'accountability'     // Remind them why they set alarm
  | 'guilt'              // Light guilt about sleeping in
  | 'challenge'          // Challenge their identity/commitment
  | 'sit_up_request'     // Ask them to sit up
  | 'stand_up_request'   // Ask them to stand
  | 'walk_request'       // Ask them to walk somewhere
  | 'coffee_walk'        // Walk to kitchen for coffee
  | 'movement_verify';   // Verify they actually moved

// ============================================
// USER RESPONSIVENESS LEVELS
// ============================================
export type ResponsivenessLevel =
  | 'silent'      // No response at all
  | 'mumbling'    // Barely audible, one-word responses
  | 'minimal'     // Short responses but engaged
  | 'conversing'  // Actually having a conversation
  | 'alert';      // Clearly awake and engaged

// ============================================
// SESSION STATE
// ============================================
export interface WakeSessionState {
  phase: SessionPhase;
  startTime: Date;

  // What we've tried
  toolsUsed: EngagementTool[];
  toolsAvailable: EngagementTool[];

  // User behavior
  responsiveness: ResponsivenessLevel;
  silenceCount: number;           // How many times user was silent after agent spoke
  responseCount: number;          // How many times user responded
  lastUserResponse: string | null;

  // Escalation tracking
  escalationLevel: number;        // 0-4, increases with each failed attempt

  // Content preferences (can be updated by voice commands)
  preferences: {
    includeNews: boolean;
    includeWeather: boolean;
    includeCalendar: boolean;
    includeStories: boolean;
  };

  // Context data
  context: {
    weather?: string;
    calendar?: string;
    news?: string;
    currentTime: string;
  };
}

// ============================================
// TOOL PRIORITY BY PHASE AND PERSONA
// ============================================
const TOOL_PRIORITY: Record<string, Record<SessionPhase, EngagementTool[]>> = {
  'zen-guide': {
    // Phase 1: Gentle brain stimulation - breathing, body awareness, NO weather yet
    brain_wakeup: ['greeting', 'breathing', 'body_awareness', 'how_did_you_sleep', 'gentle_story'],
    // Phase 2: Weather comes here as a rich, immersive moment
    soft_chat: ['weather', 'body_awareness', 'gentle_story', 'gratitude', 'breathing'],
    encouragement: ['first_step_insight', 'body_awareness', 'sit_up_request', 'plans_today'],
    movement: ['sit_up_request', 'stand_up_request', 'walk_request'],
    verification: ['movement_verify', 'direct_question'],
    complete: [],
  },
  'morning-coach': {
    // Phase 1: JUST stimulate the brain. NO weather, NO calendar, NO pressure.
    brain_wakeup: ['greeting', 'how_did_you_sleep', 'interesting_fact', 'news'],
    // Phase 2: Weather comes here as a rich description. Still gentle. Mention coffee.
    soft_chat: ['weather', 'coffee_mention', 'interesting_fact', 'humor', 'first_step_insight'],
    // Phase 3: User engaging OR enough time. NOW can mention calendar. Encourage movement with coffee.
    encouragement: ['coffee_mention', 'first_step_insight', 'calendar', 'plans_today', 'accountability'],
    // Phase 4: Time to move. Coffee walk, get up requests.
    movement: ['coffee_walk', 'first_step_insight', 'sit_up_request', 'stand_up_request', 'walk_request'],
    // Phase 5: Verify they're up
    verification: ['movement_verify', 'coffee_mention'],
    complete: [],
  },
  'strict-sergeant': {
    // Phase 1: Quick greeting, news to wake brain
    brain_wakeup: ['greeting', 'news'],
    // Phase 2: Weather (brief for sergeant), calendar, accountability
    soft_chat: ['weather', 'calendar', 'direct_question', 'accountability'],
    encouragement: ['challenge', 'guilt', 'accountability', 'sit_up_request'],
    movement: ['stand_up_request', 'walk_request', 'challenge'],
    verification: ['movement_verify', 'challenge'],
    complete: [],
  },
};

// ============================================
// BRAIN CLASS
// ============================================
export class WakeSessionBrain {
  private state: WakeSessionState;
  private personaId: string;

  constructor(
    personaId: string,
    preferences: WakeSessionState['preferences'],
    context: WakeSessionState['context']
  ) {
    this.personaId = personaId;
    this.state = {
      phase: 'brain_wakeup',
      startTime: new Date(),
      toolsUsed: [],
      toolsAvailable: this.getAvailableTools(preferences),
      responsiveness: 'silent',
      silenceCount: 0,
      responseCount: 0,
      lastUserResponse: null,
      escalationLevel: 0,
      preferences,
      context,
    };
  }

  /**
   * Get available tools based on user preferences
   */
  private getAvailableTools(preferences: WakeSessionState['preferences']): EngagementTool[] {
    const tools: EngagementTool[] = [
      'greeting', 'how_did_you_sleep', 'gratitude', 'plans_today',
      'interesting_fact', 'gentle_story', 'body_awareness', 'breathing', 'direct_question',
      'humor', 'coffee_mention', 'first_step_insight', 'accountability', 'guilt', 'challenge',
      'sit_up_request', 'stand_up_request', 'walk_request', 'coffee_walk', 'movement_verify'
    ];

    if (preferences.includeWeather) tools.push('weather');
    if (preferences.includeCalendar) tools.push('calendar');
    if (preferences.includeNews) tools.push('news');
    if (preferences.includeStories) tools.push('gentle_story');

    return tools;
  }

  /**
   * Record that the user responded
   * Key insight: Quality of response matters for progression
   */
  recordUserResponse(transcript: string): void {
    this.state.responseCount++;
    this.state.lastUserResponse = transcript;

    // Classify response quality - not just word count, but CONTENT
    const lower = transcript.trim().toLowerCase();
    const wordCount = transcript.trim().split(/\s+/).length;

    // Lazy/minimal responses - single acknowledgments
    const lazyPatterns = [
      /^(ok|okay|k|yes|yeah|yea|yep|no|nope|nah|mm|mmm|mhm|hmm|uh|um|ah|oh)\.?$/i,
      /^(sure|fine|alright|right|cool)\.?$/i,
    ];
    const isLazy = lazyPatterns.some(pattern => pattern.test(lower));

    // Determine responsiveness
    if (isLazy) {
      this.state.responsiveness = 'minimal';
    } else if (wordCount <= 3) {
      // Short but real response (e.g., "Good morning", "Hello there", "I'm awake")
      this.state.responsiveness = 'conversing';
    } else if (wordCount <= 6) {
      this.state.responsiveness = 'conversing';
    } else {
      this.state.responsiveness = 'alert';
    }

    console.log(`[Brain] Response classified: "${transcript}" -> ${this.state.responsiveness} (${wordCount} words, lazy=${isLazy})`);

    // DIFFERENT BEHAVIOR BASED ON RESPONSE QUALITY
    if (this.state.responsiveness === 'conversing' || this.state.responsiveness === 'alert') {
      // REAL engagement - reset silence, can advance phases
      this.state.silenceCount = 0;
      this.state.escalationLevel = Math.max(0, this.state.escalationLevel - 1);

      if (this.state.phase === 'brain_wakeup') {
        // They're engaging! Move to soft chat
        console.log(`[Brain] Phase advance: brain_wakeup -> soft_chat (user engaged)`);
        this.state.phase = 'soft_chat';
      } else if (this.state.phase === 'soft_chat' && this.state.responseCount >= 2) {
        // Good conversation going - can start encouragement
        console.log(`[Brain] Phase advance: soft_chat -> encouragement (responseCount=${this.state.responseCount})`);
        this.state.phase = 'encouragement';
      } else if (this.state.phase === 'encouragement' && this.state.responseCount >= 4) {
        // Ready for movement
        console.log(`[Brain] Phase advance: encouragement -> movement (responseCount=${this.state.responseCount})`);
        this.state.phase = 'movement';
      }
    } else if (this.state.responsiveness === 'minimal') {
      // LAZY response (like "Ok", "Yeah", "Mmm")
      // They're there but groggy - don't fully reset silence count
      // This allows silence-based progression to continue working
      this.state.silenceCount = Math.max(0, this.state.silenceCount - 2);
      this.state.escalationLevel = Math.max(0, this.state.escalationLevel - 1);
      // NO phase advancement for lazy responses
    }

    // Check for voice commands
    this.checkVoiceCommands(transcript);
  }

  /**
   * Record that the user was silent
   * Key insight: Silence is NORMAL when waking up. Don't escalate too fast.
   * Keep stimulating their brain gently, not pressuring them.
   */
  recordSilence(): void {
    this.state.silenceCount++;
    this.state.responsiveness = 'silent';

    // SLOW ESCALATION - silence is expected when waking up
    // Phase progression based on silence count, but GENTLE
    if (this.state.phase === 'brain_wakeup') {
      // Stay in brain_wakeup for a while - this is normal
      // Only move to soft_chat after several silences
      if (this.state.silenceCount >= 4) {
        this.state.phase = 'soft_chat';
        this.state.escalationLevel = 1;
      }
    } else if (this.state.phase === 'soft_chat') {
      // Still gentle, just trying different approaches
      if (this.state.silenceCount >= 3) {
        this.state.escalationLevel = Math.min(2, this.state.escalationLevel + 1);
      }
      if (this.state.silenceCount >= 6) {
        this.state.phase = 'encouragement';
      }
    } else if (this.state.phase === 'encouragement') {
      // Now we can start being more direct
      this.state.escalationLevel = Math.min(3, this.state.escalationLevel + 1);
      if (this.state.silenceCount >= 8) {
        this.state.phase = 'movement';
      }
    } else if (this.state.phase === 'movement') {
      // Keep trying movement prompts
      this.state.escalationLevel = Math.min(4, this.state.escalationLevel + 1);
    }
  }

  /**
   * Check for voice commands in user speech
   */
  private checkVoiceCommands(transcript: string): void {
    const lower = transcript.toLowerCase();

    if (lower.includes('skip news') || lower.includes('no news')) {
      this.state.preferences.includeNews = false;
    }
    if (lower.includes('skip weather') || lower.includes('no weather')) {
      this.state.preferences.includeWeather = false;
    }
    if (lower.includes("i'm awake") || lower.includes('i am awake') || lower.includes("i'm up")) {
      this.state.phase = 'verification';
    }
  }

  /**
   * Mark a tool as used
   */
  markToolUsed(tool: EngagementTool): void {
    if (!this.state.toolsUsed.includes(tool)) {
      this.state.toolsUsed.push(tool);
    }
  }

  /**
   * Get the next recommended tool to try
   */
  getNextTool(): EngagementTool | null {
    const priority = TOOL_PRIORITY[this.personaId]?.[this.state.phase]
      || TOOL_PRIORITY['morning-coach'][this.state.phase];

    // Find first tool in priority list that:
    // 1. Hasn't been used yet
    // 2. Is available (based on preferences)
    for (const tool of priority) {
      if (!this.state.toolsUsed.includes(tool) && this.state.toolsAvailable.includes(tool)) {
        return tool;
      }
    }

    // If all priority tools used, rotate through repeatables based on silence count
    // Different repeatables for different phases and personas
    const movementRepeatables: EngagementTool[] = [
      'walk_request', 'stand_up_request', 'sit_up_request', 'coffee_walk',
      'first_step_insight', 'direct_question', 'accountability'
    ];

    // Zen-guide specific repeatables (calming, meditative)
    const zenRepeatables: EngagementTool[] = [
      'breathing', 'body_awareness', 'gentle_story', 'gratitude', 'direct_question'
    ];

    // General repeatables for other personas
    const generalRepeatables: EngagementTool[] = [
      'direct_question', 'coffee_mention', 'first_step_insight', 'interesting_fact',
      'accountability', 'challenge', 'breathing', 'humor'
    ];

    // Choose repeatables based on phase and persona
    let repeatableTools: EngagementTool[];
    if (this.state.phase === 'movement') {
      repeatableTools = movementRepeatables;
    } else if (this.personaId === 'zen-guide') {
      repeatableTools = zenRepeatables;
    } else {
      repeatableTools = generalRepeatables;
    }

    // Filter to only tools that are in the current phase's priority
    const validRepeatables = repeatableTools.filter(tool => priority.includes(tool));

    if (validRepeatables.length > 0) {
      // Use silenceCount to rotate through the list
      const index = this.state.silenceCount % validRepeatables.length;
      console.log(`[Brain] Rotating repeatables: index=${index}, tools=[${validRepeatables.join(', ')}]`);
      return validRepeatables[index];
    }

    // If no valid repeatables match priority, just use the repeatables directly
    // This handles cases where the phase tools have all been used
    if (repeatableTools.length > 0) {
      const index = this.state.silenceCount % repeatableTools.length;
      console.log(`[Brain] Fallback repeatables: index=${index}, tools=[${repeatableTools.join(', ')}]`);
      return repeatableTools[index];
    }

    return null;
  }

  /**
   * Generate instruction for the agent based on current state
   */
  generateInstruction(): string {
    const nextTool = this.getNextTool();
    const phase = this.state.phase;
    const escalation = this.state.escalationLevel;
    const silenceCount = this.state.silenceCount;

    let instruction = '';

    // Only add the "USER IS SILENT" header if this is NOT the initial greeting
    // (if no tools used and phase is brain_wakeup, this is likely the greeting)
    const isInitialGreeting = this.state.toolsUsed.length === 0 && phase === 'brain_wakeup';

    if (!isInitialGreeting) {
      // Short reminder (detailed rules are in the persona system prompt)
      instruction += `# USER IS SILENT - THEY SAID NOTHING\n`;
      instruction += `Do NOT respond as if they spoke. No "That's great!" or positive acknowledgments.\n\n`;
    }

    // Phase-specific guidance
    instruction += `# CURRENT PHASE: ${phase.toUpperCase()}\n`;
    if (phase === 'brain_wakeup') {
      instruction += `This is the GENTLE brain wake-up phase. The user is groggy - this is NORMAL.\n`;
      instruction += `- Just stimulate their brain: weather, interesting facts, light chat\n`;
      instruction += `- Do NOT mention calendar or responsibilities yet - too early!\n`;
      instruction += `- Do NOT push for movement yet\n`;
      instruction += `- Silence is expected - keep chatting gently\n\n`;
    } else if (phase === 'soft_chat') {
      instruction += `User is showing some signs of life, or time has passed.\n`;
      instruction += `- Continue gentle conversation\n`;
      instruction += `- Can mention coffee as motivation\n`;
      instruction += `- Still NO calendar pressure unless they're clearly awake\n`;
      instruction += `- "The hardest part is just getting up..."\n\n`;
    } else if (phase === 'encouragement') {
      instruction += `Time to start encouraging movement.\n`;
      instruction += `- NOW you can mention calendar/plans\n`;
      instruction += `- Use coffee as motivation: "Let's go get that coffee"\n`;
      instruction += `- "I promise once you're up, everything feels better"\n`;
      instruction += `- Gently suggest sitting up or standing\n\n`;
    } else if (phase === 'movement') {
      instruction += `Time to get them physically moving.\n`;
      instruction += `- Coffee walk: "Come on, let's go to the kitchen together"\n`;
      instruction += `- Direct but kind requests to get up\n`;
      instruction += `- "The first step is the hardest, I promise"\n\n`;
    }

    instruction += `Escalation level: ${escalation}/4 | Silent count: ${silenceCount}\n`;
    instruction += `Already tried: ${this.state.toolsUsed.slice(-5).join(', ') || 'nothing yet'}\n\n`;

    // What to do
    if (nextTool) {
      instruction += `# NEXT APPROACH: ${nextTool.replace(/_/g, ' ').toUpperCase()}\n`;
      instruction += `${this.getToolGuidance(nextTool)}\n\n`;

      // Add variation suggestions
      instruction += `# VARIATION IDEAS (pick one, or create your own)\n`;
      instruction += this.getVariationSuggestions(nextTool, silenceCount);
    }

    // What NOT to do (brief)
    instruction += `\n# DO NOT\n`;
    instruction += `- Respond as if user spoke (they didn't)\n`;
    instruction += `- Repeat exact same words/approach\n`;
    instruction += `- Give up\n`;

    // Context to use
    if (this.state.context.weather && this.state.preferences.includeWeather) {
      instruction += `\nAVAILABLE INFO - Weather: ${this.state.context.weather}`;
    }
    if (this.state.context.calendar && this.state.preferences.includeCalendar) {
      instruction += `\nAVAILABLE INFO - Calendar: ${this.state.context.calendar}`;
    }
    if (this.state.context.news && this.state.preferences.includeNews) {
      instruction += `\nAVAILABLE INFO - News: ${this.state.context.news}`;
    }

    // Mark tool as used
    if (nextTool) {
      this.markToolUsed(nextTool);
    }

    return instruction;
  }

  /**
   * Get variation suggestions for a tool to prevent repetition
   */
  private getVariationSuggestions(tool: EngagementTool, silenceCount: number): string {
    const variations: Record<string, string[]> = {
      direct_question: [
        '"Can you hear me? Just say yes or make a sound."',
        '"What\'s the first thing you see when you open your eyes?"',
        '"Tell me one word - how are you feeling right now?"',
        '"If you could have any breakfast right now, what would it be?"',
      ],
      accountability: [
        '"You set this alarm for a reason. What was it?"',
        '"Remember why you wanted to wake up early today?"',
        '"Past-you made a decision to wake up now. Honor that."',
        '"What would future-you think if you stayed in bed?"',
      ],
      challenge: [
        '"Is this the person you want to be?"',
        '"What would you tell a friend who couldn\'t get out of bed?"',
        '"You\'ve done hard things before. This is just getting up."',
        '"Every day is a choice. What are you choosing right now?"',
      ],
      breathing: [
        '"Take a deep breath with me... in... and out..."',
        '"Let\'s breathe together. In through the nose..."',
        '"One deep breath. That\'s all I\'m asking. Ready?"',
        '"Breathe in energy, breathe out sleep..."',
      ],
    };

    const toolVariations = variations[tool];
    if (toolVariations) {
      // Pick different variations based on silence count to ensure variety
      const startIdx = silenceCount % toolVariations.length;
      const selected = toolVariations.slice(startIdx, startIdx + 2);
      return selected.map(v => `- ${v}`).join('\n');
    }

    return '- Be creative and vary your approach from before';
  }

  /**
   * Get specific guidance for each tool
   */
  private getToolGuidance(tool: EngagementTool): string {
    const guidance: Record<EngagementTool, string> = {
      greeting: 'Greet them warmly. This is the first thing they hear.',
      how_did_you_sleep: 'Ask how they slept. Show genuine interest.',
      weather: 'Paint a RICH, IMMERSIVE picture of the weather and the day ahead. Don\'t just say "68 degrees partly cloudy." Instead, describe how it FEELS: "It\'s 17 degrees outside with soft clouds overhead - a cozy winter morning. Looks like it rained a little during the night, so it must smell amazing outside. Perfect day to open a window and breathe in that fresh air. Later this afternoon the clouds should clear up, and tonight it\'ll cool down to about 12 degrees." Make them WANT to experience the day.',
      calendar: 'Mention what\'s on their calendar today casually, not as pressure.',
      news: 'Share 1-2 interesting headlines to stimulate their brain.',
      gratitude: 'Ask what they\'re grateful for today. Wait for their answer.',
      plans_today: 'Ask what they want to accomplish today.',
      interesting_fact: 'Share something interesting to wake up their brain.',
      gentle_story: 'Share an IMMERSIVE visualization (forest stream, mountain sunrise, garden path, ocean shore, or cozy cabin). Make it LONG and detailed - paint a vivid mental picture. This is meditation, not a quick fact.',
      body_awareness: 'Guide them to notice their body. "Feel the weight of your head on the pillow... the warmth of the blanket... Gently wiggle your fingers and toes..." Help them reconnect with their physical form before asking them to move.',
      breathing: 'Invite them to take a deep breath with you.',
      direct_question: 'Ask them a direct question that requires a real answer.',
      humor: 'Try to make them smile or laugh.',
      coffee_mention: 'Use coffee/tea as motivation. "That coffee is waiting for you..." "Imagine that first sip..."',
      first_step_insight: 'Remind them: "The hardest part is just getting up. Once you\'re on your feet, everything feels better. I promise."',
      accountability: 'Remind them they set this alarm for a reason.',
      guilt: 'Use light guilt about sleeping in while others are productive.',
      challenge: 'Challenge their identity - are they someone who gives up?',
      sit_up_request: 'Ask them gently to sit up in bed.',
      stand_up_request: 'Ask them to stand up and stretch.',
      walk_request: 'Ask them to walk somewhere (window, bathroom) with their phone.',
      coffee_walk: 'Motivate them to walk to the kitchen for coffee. "Come on, let\'s go get that coffee together. I\'ll keep you company."',
      movement_verify: 'Confirm they actually moved. Ask what they see or if they have their coffee.',
    };

    return guidance[tool] || '';
  }

  /**
   * Get current state summary
   */
  getState(): WakeSessionState {
    return { ...this.state };
  }

  /**
   * Check if session should be considered complete
   */
  isComplete(): boolean {
    return this.state.phase === 'complete';
  }

  /**
   * Mark session as complete
   */
  markComplete(): void {
    this.state.phase = 'complete';
  }
}
