/**
 * Grok News Service
 *
 * Fetches real-time news using Grok API (X/Twitter).
 * Grok has access to current events via X platform data.
 */

export interface NewsHeadline {
  title: string;
  source?: string;
  category?: string;
}

export interface NewsResult {
  headlines: NewsHeadline[];
  fetchedAt: Date;
  source: 'grok' | 'fallback';
}

// Available news themes users can choose from
export const NEWS_THEMES = [
  { id: 'technology', label: 'Technology', emoji: '💻' },
  { id: 'business', label: 'Business & Finance', emoji: '📈' },
  { id: 'world', label: 'World News', emoji: '🌍' },
  { id: 'sports', label: 'Sports', emoji: '⚽' },
  { id: 'entertainment', label: 'Entertainment', emoji: '🎬' },
  { id: 'science', label: 'Science', emoji: '🔬' },
  { id: 'health', label: 'Health & Wellness', emoji: '🏥' },
  { id: 'culture', label: 'Culture & Arts', emoji: '🎨' },
] as const;

export type NewsThemeId = typeof NEWS_THEMES[number]['id'];

/**
 * Fetch real news headlines from Grok API
 * Grok uses a chat completion interface and has real-time access to X/Twitter data
 */
export async function fetchNewsHeadlines(
  apiKey: string,
  themes: string[] = ['technology', 'world'],
  count: number = 4
): Promise<NewsResult> {
  try {
    console.log(`[GrokNews] Fetching news for themes: ${themes.join(', ')}`);

    const themesText = themes.length > 0
      ? `Focus on these topics: ${themes.join(', ')}.`
      : 'Cover a variety of topics.';

    // Log the current date being used
    const currentDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    console.log(`[GrokNews] 📅 Current date for prompt: ${currentDate}`);

    // Build the system prompt
    const systemPrompt = `You are a news briefing assistant. Today's date is ${currentDate}. Provide ${count} current, real news headlines from today or the past 24 hours. ${themesText}

Format your response as JSON array:
[
  {"title": "Headline text", "category": "category_name"},
  ...
]

Rules:
- Only real, current news - nothing made up
- Keep headlines concise (under 15 words)
- Include category from: technology, business, world, sports, entertainment, science, health, culture
- Return ONLY the JSON array, no other text`;
    
    console.log(`[GrokNews] 📝 System prompt (first 200 chars): ${systemPrompt.substring(0, 200)}...`);
    console.log(`[GrokNews] 🔍 Enabling live_search for real-time news`);

    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'grok-3',
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: `What are the top ${count} news headlines right now?`
          }
        ],
        temperature: 0.3,  // Lower temperature for factual content
        tools: [
          {
            type: 'live_search'
          }
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[GrokNews] ❌ API error: ${response.status} - ${errorText}`);
      throw new Error(`Grok API error: ${response.status}`);
    }

    const data = await response.json() as {
      choices: Array<{
        message: {
          content: string;
        };
      }>;
    };

    const content = data.choices[0]?.message?.content || '';
    console.log(`[GrokNews] 📨 Full Grok response: ${content}`);

    // Parse the JSON response
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('[GrokNews] ❌ Could not parse JSON from response');
      throw new Error('Invalid response format');
    }

    const headlines: NewsHeadline[] = JSON.parse(jsonMatch[0]);

    console.log(`[GrokNews] ✅ Successfully fetched ${headlines.length} headlines`);
    headlines.forEach((h, i) => {
      console.log(`[GrokNews]   ${i + 1}. ${h.title} (${h.category})`);
    });

    return {
      headlines: headlines.slice(0, count),
      fetchedAt: new Date(),
      source: 'grok',
    };
  } catch (error) {
    console.error('[GrokNews] ❌ Failed to fetch from Grok API:', error);
    console.log('[GrokNews] 🔄 Falling back to placeholder headlines');
    return {
      headlines: await getFallbackHeadlines(count),
      fetchedAt: new Date(),
      source: 'fallback',
    };
  }
}

/**
 * Fallback headlines when API is unavailable
 */
async function getFallbackHeadlines(count: number): Promise<NewsHeadline[]> {
  const placeholders: NewsHeadline[] = [
    {
      title: 'Markets showing mixed signals as investors await economic data',
      source: 'Financial News',
      category: 'business',
    },
    {
      title: 'New AI breakthroughs announced at major tech conference',
      source: 'Tech Daily',
      category: 'technology',
    },
    {
      title: 'Climate summit reaches preliminary agreement on emissions',
      source: 'World News',
      category: 'world',
    },
    {
      title: 'Championship finals set for this weekend after dramatic semifinals',
      source: 'Sports Update',
      category: 'sports',
    },
  ];

  return placeholders.slice(0, count);
}

/**
 * Format headlines for the voice agent to read naturally
 */
export function formatHeadlinesForVoice(headlines: NewsHeadline[]): string {
  if (headlines.length === 0) {
    return 'No news headlines available at the moment.';
  }

  const formatted = headlines
    .map((h, i) => `${i + 1}. ${h.title}`)
    .join('\n');

  return `Here are today's top headlines:\n${formatted}`;
}

/**
 * Get a brief news summary for the wake-up session
 */
export async function getNewsBriefing(
  apiKey: string,
  themes?: string[]
): Promise<string> {
  const result = await fetchNewsHeadlines(apiKey, themes, 3);
  return formatHeadlinesForVoice(result.headlines);
}

/**
 * Get available news themes for user preferences
 */
export function getNewsThemes() {
  return NEWS_THEMES;
}