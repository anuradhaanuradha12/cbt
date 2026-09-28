import { json, json400, json403 } from '../middleware/responses';
import type { Env } from '../types';

export async function imagesRouter(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith('/images/')) return null;

  // ── Dev-only ingest: PUT /images/ingest/<key> ────────────────
  // Lets a local script populate the R2 binding without Cloudflare auth
  // (miniflare stores locally). Guarded by an INGEST_SECRET in .dev.vars,
  // which only exists in local dev — on a deployed Worker the secret is
  // never set, so this route 403s everywhere else.
  const ingestMatch = pathname.match(/^\/images\/ingest\/(.+)$/);
  if (ingestMatch && request.method === 'PUT') {
    const secret = (env as any).INGEST_SECRET as string | undefined;
    if (!secret) return json403('Ingest disabled');
    if (request.headers.get('X-Ingest-Secret') !== secret) return json403('Invalid ingest secret');

    const key = decodeURIComponent(ingestMatch[1]);
    if (!key || key.includes('..')) return json400('Invalid key');

    const body = await request.arrayBuffer();
    if (body.byteLength === 0) return json400('Empty body');

    await env.CBT_R2.put(key, body, {
      httpMetadata: {
        contentType: request.headers.get('Content-Type') ?? 'application/octet-stream',
      },
    });
    return json({ key, size: body.byteLength });
  }

  const key = decodeURIComponent(pathname.slice('/images/'.length));
  if (!key) return json({ error: 'Key required' }, 400);

  if (request.method === 'GET') {
    try {
      const object = await env.CBT_R2.get(key);

      if (object === null) {
        console.error(`[images] R2 key not found: "${key}"`);
        return new Response(JSON.stringify({ error: 'Image not found', key }), {
          status: 404,
          headers: {
            'Content-Type': 'application/json',
            'X-Debug-Key': key,
            'Cache-Control': 'no-store', // never cache a miss — keys can appear later
          },
        });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('etag', object.httpEtag);
      // 1 day (not 1 year): the pipeline rewrites bytes under the same keys
      // during watermark cleanup / regeneration — a year-long cache would
      // pin stale or mid-write responses in browsers.
      headers.set('Cache-Control', 'public, max-age=86400');
      headers.set('Access-Control-Allow-Origin', '*');

      if (!headers.has('Content-Type')) {
        if (key.endsWith('.webp')) headers.set('Content-Type', 'image/webp');
        else if (key.endsWith('.png')) headers.set('Content-Type', 'image/png');
        else if (key.endsWith('.jpg') || key.endsWith('.jpeg')) headers.set('Content-Type', 'image/jpeg');
      }

      return new Response(object.body, { headers });
    } catch (e: any) {
      console.error(`[images] Error fetching key "${key}":`, e.message);
      return json({ error: e.message }, 500);
    }
  }

  return null;
}
