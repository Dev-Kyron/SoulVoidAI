/**
 * Static URL endpoints for the tool/agent layer. Centralised here so a third-
 * party API moving paths (Tavily v2, Stability swapping `/v2beta` for `/v3`,
 * DuckDuckGo's HTML host changing) is a one-line fix instead of a hunt
 * across `actions.ts` + `search.ts` + their tests.
 *
 * Provider AI endpoints (OpenAI, Anthropic, Gemini) live with their provider
 * metadata in `services/ai/types.ts` so they can carry override URLs per user
 * config — that's a different shape from these "always-the-same" tool URLs.
 */
export const ENDPOINTS = {
  /** Tavily ranked search API. Paid + free tier, opt-in via Integrations key. */
  tavilySearch: 'https://api.tavily.com/search',
  /** DuckDuckGo HTML-only endpoint — server-rendered, easier to scrape than
   *  the JS-driven main page. Keyless default for `web_search`. */
  duckduckgoHtml: 'https://html.duckduckgo.com/html/',
  /** Pollinations.ai image generation. URL-as-API: prompt in the path,
   *  dimensions in the query string. Free, no signup. */
  pollinationsImage: 'https://image.pollinations.ai/prompt/',
  /** Stability AI Stable Diffusion 3 Core endpoint. Paid, opt-in. */
  stabilityImage: 'https://api.stability.ai/v2beta/stable-image/generate/core',
  /** Google Imagen 3 — paid, uses the user's Gemini key. */
  geminiImagen:
    'https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict'
} as const
