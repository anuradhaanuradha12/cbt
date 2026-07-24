import { json } from '../middleware/responses';
import type { Env } from '../types';

export async function imagesRouter(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith('/images/')) return null;

  const key = decodeURIComponent(pathname.slice('/images/'.length));
  if (!key) return json({ error: 'Key required' }, 400);

  if (request.method === 'GET') {
    try {
      const object = await env.CBT_R2.get(key);

      if (object === null) {
        console.error(`[images] R2 key not found: "${key}"`);
        return new Response(JSON.stringify({ error: 'Image not found', key }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', 'X-Debug-Key': key },
        });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('etag', object.httpEtag);
      headers.set('Cache-Control', 'public, max-age=31536000');
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
