/**
 * Grok News Service
 *
 * Fetches news headlines using the Grok API (X/Twitter).
 * Falls back to a simple summary if API is unavailable.
 */

import fetch from 'node-fetch';

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

/**
 * Fetch news headlines from Grok API
 *
 * Note: Grok API integration requires X API credentials.
 * This is a placeholder that will be implemented once we have API access.
 */
export async function fetchNewsHeadlines(
  apiKey: string,
  count: number = 4
): Promise<NewsResult> {
  // TODO: Implement actual Grok API call
  // The Grok API endpoint and format may vary - this is a placeholder

  try {
    // Placeholder for Grok API call
    // const response = await fetch('https://api.x.ai/v1/grok/news', {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': `Bearer ${apiKey}`,
    //     'Content-Type': 'application/json',
    //   },
    //   body: JSON.stringify({
    //     query: 'top news headlines today',
    //     count: count,
    //   }),
    // });

    // For now, return placeholder headlines
    // In production, this will be replaced with actual Grok API response
    console.log('[GrokNews] API key provided, but using placeholder until integration is complete');

    return {
      headlines: await getFallbackHeadlines(count),
      fetchedAt: new Date(),
      source: 'fallback',
    };
  } catch (error) {
    console.error('[GrokNews] Failed to fetch from Grok API:', error);
    return {
      headlines: await getFallbackHeadlines(count),
      fetchedAt: new Date(),
      source: 'fallback',
    };
  }
}

/**
 * Fallback headlines when API is unavailable
 * In production, these could come from a backup news API
 */
async function getFallbackHeadlines(count: number): Promise<NewsHeadline[]> {
  // These are placeholder headlines
  // In production, we'd use a backup news API like NewsAPI.org
  const placeholders: NewsHeadline[] = [
    {
      title: 'Markets open mixed as investors await economic data',
      source: 'Financial News',
      category: 'business',
    },
    {
      title: 'Tech companies announce new AI initiatives',
      source: 'Tech Daily',
      category: 'technology',
    },
    {
      title: 'Climate summit reaches preliminary agreement',
      source: 'World News',
      category: 'world',
    },
    {
      title: 'Sports: Championship games set for this weekend',
      source: 'Sports Update',
      category: 'sports',
    },
  ];

  return placeholders.slice(0, count);
}

/**
 * Format headlines for the voice agent to read
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
export async function getNewsBriefing(apiKey: string): Promise<string> {
  const result = await fetchNewsHeadlines(apiKey, 3);
  return formatHeadlinesForVoice(result.headlines);
}
