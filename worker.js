/**
 * Cloudflare Worker — ultra-fast HLS/M3U8 edge proxy
 * Deploy: GitHub repo -> Cloudflare Workers & Pages -> Connect to Git
 * Usage: https://your-worker.workers.dev/?url=<raw or base64 m3u8/segment url>&ref=<referer>&origin=<origin>
 *
 * Cloudflare Workers global edge e চলে (300+ city), tai kono ekta RDP/VPS
 * theke hoste korar cheye onek fast — viewer jekhaneই hok, kachakachi
 * edge theke response pay.
 */

export default {
  async fetch(request) {
    const reqUrl = new URL(request.url);
    let target = reqUrl.searchParams.get('url');
    const referer = reqUrl.searchParams.get('ref') || '';
    const origin = reqUrl.searchParams.get('origin') || '';

    if (!target) {
      return new Response('Missing url param', { status: 400 });
    }

    // base64 or raw
    try {
      const maybeDecoded = atob(target);
      if (/^https?:\/\//.test(maybeDecoded)) target = maybeDecoded;
    } catch (e) {
      target = decodeURIComponent(target);
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch (e) {
      return new Response('Invalid url', { status: 400 });
    }

    // basic SSRF guard
    const blockedHosts = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.|localhost)/;
    if (blockedHosts.test(targetUrl.hostname)) {
      return new Response('Blocked host', { status: 403 });
    }

    const upstreamHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };
    if (referer) upstreamHeaders['Referer'] = referer;
    if (origin) upstreamHeaders['Origin'] = origin;
    const range = request.headers.get('Range');
    if (range) upstreamHeaders['Range'] = range;

    const path = targetUrl.pathname.toLowerCase();
    const looksLikePlaylistByExt = path.endsWith('.m3u8') || path === '' || !path.includes('.');

    const upstream = await fetch(targetUrl.toString(), {
      headers: upstreamHeaders,
      cf: looksLikePlaylistByExt ? {
        cacheTtl: 0,
        cacheEverything: false,
      } : {
        cacheTtl: 86400,
        cacheEverything: true,
      },
    });

    const ctype = upstream.headers.get('content-type') || '';

    // Only buffer + rewrite if it might be a playlist; otherwise stream straight through
    if (looksLikePlaylistByExt) {
      const bodyText = await upstream.text();
      const isPlaylist = bodyText.trimStart().startsWith('#EXTM3U') || ctype.includes('mpegurl');

      if (isPlaylist) {
        const baseUrl = target.substring(0, target.lastIndexOf('/') + 1);
        const selfBase = `${reqUrl.protocol}//${reqUrl.host}${reqUrl.pathname}`;

        const rewritten = bodyText
          .split('\n')
          .map((line) => {
            line = line.trimEnd();
            if (line === '' || line.startsWith('#')) {
              const m = line.match(/URI="([^"]+)"/);
              if (m) {
                const abs = /^https?:\/\//.test(m[1]) ? m[1] : baseUrl + m[1].replace(/^\//, '');
                const proxied = `${selfBase}?url=${encodeURIComponent(btoa(abs))}${refParams(referer, origin)}`;
                return line.replace(m[1], proxied);
              }
              return line;
            }
            const abs = /^https?:\/\//.test(line) ? line : baseUrl + line.replace(/^\//, '');
            return `${selfBase}?url=${encodeURIComponent(btoa(abs))}${refParams(referer, origin)}`;
          })
          .join('\n');

        return new Response(rewritten, {
          headers: {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
          },
        });
      }

      // wasn't actually a playlist — return as-is
      return new Response(bodyText, {
        status: upstream.status,
        headers: {
          'Content-Type': ctype || 'video/MP2T',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // binary segment — stream directly, no buffering (fastest path)
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': ctype || 'video/MP2T',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  },
};

function refParams(referer, origin) {
  let p = '';
  if (referer) p += `&ref=${encodeURIComponent(referer)}`;
  if (origin) p += `&origin=${encodeURIComponent(origin)}`;
  return p;
}
