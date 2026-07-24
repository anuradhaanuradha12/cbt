import { json, json404 } from '../middleware/responses';
import type { Env } from '../types';

export async function imagesRouter(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith('/images/')) return null;

  const key = pathname.replace('/images/', '');
  if (!key) return json({ error: 'Key required' }, 400);

  if (request.method === 'GET') {
    try {
      const object = await env.CBT_R2.get(key);
      
      if (object === null) {
        return json404('Image not found');
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('etag', object.httpEtag);
      headers.set('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year

      // Determine content type by extension if not set
      if (!headers.has('Content-Type')) {
        if (key.endsWith('.webp')) headers.set('Content-Type', 'image/webp');
        else if (key.endsWith('.png')) headers.set('Content-Type', 'image/png');
        else if (key.endsWith('.jpg') || key.endsWith('.jpeg')) headers.set('Content-Type', 'image/jpeg');
      }

      return new Response(object.body, {
        headers,
      });
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  return null;
}
