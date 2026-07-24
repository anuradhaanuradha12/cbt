// ─── Worker Entry Point ───────────────────────────────────────────────────────
// Lightweight manual router — no frameworks, no Node.js modules.
// Pattern: URL pathname matched against route handlers in priority order.

import { authRouter } from './routes/auth';
import { questionsRouter } from './routes/questions';
import { examsRouter } from './routes/exams';
import { attemptsRouter } from './routes/attempts';
import { submissionsRouter } from './routes/submissions';
import { handleOptions, json404 } from './middleware/responses';
import type { Env } from './types';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // ── CORS preflight ─────────────────────────────────────────
    if (request.method === 'OPTIONS') return handleOptions();

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/$/, '') || '/'; // strip trailing slash

    // ── Route dispatch (order matters — specific before general) ──
    let response: Response | null = null;

    response ??= await authRouter(request, env, pathname);
    response ??= await questionsRouter(request, env, pathname);
    response ??= await examsRouter(request, env, pathname);
    response ??= await attemptsRouter(request, env, pathname);
    response ??= await submissionsRouter(request, env, ctx, pathname);

    // ── Health check ───────────────────────────────────────────
    if (!response && pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', ts: Date.now() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return response ?? json404(`No route for ${request.method} ${pathname}`);
  },
};
