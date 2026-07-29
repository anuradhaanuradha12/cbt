// ─── Worker Entry Point ───────────────────────────────────────────────────────
// Lightweight manual router — no frameworks, no Node.js modules.
// Pattern: URL pathname matched against route handlers in priority order.

import { authRouter } from './routes/auth';
import { questionsRouter } from './routes/questions';
import { examsRouter } from './routes/exams';
import { attemptsRouter } from './routes/attempts';
import { submissionsRouter } from './routes/submissions';
import { usersRouter } from './routes/users';
import { analyticsRouter } from './routes/analytics';
import { imagesRouter } from './routes/images';
import { forgeRouter } from './routes/forge';
import { json, json404, handleOptions } from './middleware/responses';
import type { Env } from './types';

// ── CORS Helper ──────────────────────────────────────────────────────────────

function handleCors(request: Request): Response | null {
  if (request.method === 'OPTIONS') {
    return handleOptions();
  }
  return null;
}

// ── Main Entry ───────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1. Handle CORS Preflight
    const corsResponse = handleCors(request);
    if (corsResponse) return corsResponse;

    try {
      // 2. Health check
      if (pathname === '/health' && request.method === 'GET') {
        return json({ status: 'ok', timestamp: Math.floor(Date.now() / 1000) });
      }

      // 3. Route Dispatch
      let response: Response | null = null;
      
      response ??= await authRouter(request, env, pathname);
      response ??= await usersRouter(request, env, pathname);
      response ??= await questionsRouter(request, env, pathname);
      response ??= await examsRouter(request, env, pathname);
      response ??= await attemptsRouter(request, env, pathname);
      response ??= await submissionsRouter(request, env, ctx, pathname);
      response ??= await analyticsRouter(request, env, pathname);
      response ??= await imagesRouter(request, env, pathname);
      response ??= await forgeRouter(request, env, pathname);

      if (response) return response;

      // 4. Static Asset Fallback
      if (env.ASSETS) {
        const assetResponse = await env.ASSETS.fetch(request);
        if (assetResponse.status !== 404) {
          return assetResponse;
        }
      }

      return json404(`No route for ${request.method} ${pathname}`);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env) {
    // Cron triggered every week (e.g. Sunday midnight)
    console.log(`Cron triggered at ${event.cron}`);

    // In a production app, we would fetch all students, aggregate their performance
    // over the last week, and send an email via SendGrid/AWS SES.
    
    // For this MVP, we simulate the workload:
    try {
      const result = await env.DB.prepare(`
        SELECT COUNT(*) as recent_submissions 
        FROM submissions 
        WHERE submitted_at > ?
      `).bind(Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60).first();
      
      console.log(`Found ${result?.recent_submissions || 0} recent submissions. Simulating report generation...`);
      // Here you would call your email provider's API.
    } catch (e: any) {
      console.error('Failed to generate parent reports', e.message);
    }
  }
};
