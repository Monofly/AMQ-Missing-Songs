export default {
    async fetch(req, env, ctx) {
        const url = new URL(req.url);

        // API routes we handle here; everything else goes to static assets
        const API_PATHS = new Set([
            '/csrf',
            '/oauth/device-code',
            '/oauth/poll',
            '/auth/me',
            '/logout',
            '/content',
            '/commit'
        ]);

        const isApi = API_PATHS.has(url.pathname);

        // If not an API route, serve static files (your site)
        if (!isApi && req.method !== 'OPTIONS') {
            return env.ASSETS.fetch(req);
        }

        // ==== SECURITY: allowed origins (prod, previews, and local dev) ====
        const PROD = 'https://monofly-amq.pages.dev';
        function isAllowedOriginStr(origin) {
            if (!origin) return false;
            if (origin === PROD) return true;
            if (origin.startsWith('https://') && origin.endsWith('.monofly-amq.pages.dev')) return true; // previews
            if (origin === 'http://localhost:8788' || origin === 'http://127.0.0.1:8788') return true; // pages dev
            return false;
        }

        function binderFromRequest(req) {
            const origin = req.headers.get('Origin') || '';
            if (origin) return origin;
            try { return new URL(req.url).origin; } catch { return 'no-origin'; }
        }

        function originFromRef(req) {
            const ref = req.headers.get('Referer') || '';
            try { return ref ? new URL(ref).origin : ''; } catch { return ''; }
        }

        function secFetchSameSite(req) {
            const s = (req.headers.get('Sec-Fetch-Site') || '').toLowerCase();
            return s === 'same-origin' || s === 'same-site';
        }

        function requireJson(req) {
            return (req.headers.get('Content-Type') || '').toLowerCase().includes('application/json');
        }

        function getCookie(req, name) {
            const cookie = req.headers.get('Cookie') || '';
            const escaped = name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
            const m = cookie.match(new RegExp('(?:^|;\\s*)' + escaped + '=([^;]*)'));
            return m ? m[1] : null;
        }

        function setCookie(headers, name, value, maxAgeSeconds, opts = {}) {
            const parts = [
                `${name}=${value}`,
                'Path=/',
                'Secure',
                // Same origin now — use Strict for stronger CSRF protection
                'SameSite=Strict'
            ];
            if (opts.httpOnly !== false) parts.push('HttpOnly');
            if (typeof maxAgeSeconds === 'number') parts.push(`Max-Age=${maxAgeSeconds}`);
            headers.append('Set-Cookie', parts.join('; '));
        }

        function clearCookie(headers, name) {
            headers.append('Set-Cookie', `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
        }

        function b64EncodeUnicode(str) {
            const bytes = new TextEncoder().encode(str);
            let bin = '';
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            return btoa(bin);
        }

        function b64url(buf) {
            const bin = String.fromCharCode(...new Uint8Array(buf));
            return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        }

        async function deriveCsrfFromToken(ghToken, binder) {
            const enc = new TextEncoder().encode(`${ghToken}|${binder}`);
            const digest = await crypto.subtle.digest('SHA-256', enc);
            return b64url(digest);
        }

        async function requireCsrfDerived(req) {
            const gh = getCookie(req, '__Host-gh_at');
            if (!gh) return false;
            const header = req.headers.get('X-CSRF-Token') || '';
            if (!header) return false;

            const binder = binderFromRequest(req);
            const expected = await deriveCsrfFromToken(gh, binder);
            if (header === expected) return true;

            // optional compatibility
            const expectedNoOrigin = await deriveCsrfFromToken(gh, 'no-origin');
            return header === expectedNoOrigin;
        }

        const reqOrigin = req.headers.get('Origin') || '';
        const corsBase = {
            // Reflect trusted origin; otherwise fall back to prod
            'Access-Control-Allow-Origin': isAllowedOriginStr(reqOrigin) ? reqOrigin : PROD,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
            'Access-Control-Allow-Headers': 'content-type, accept, x-csrf-token, X-CSRF-Token',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Max-Age': '86400',
            'Vary': 'Origin'
        };

        function keyFor(req, path) {
            const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';
            return `${path}|${ip}`;
        }

        const RATE_LIMITS = {
            '/oauth/device-code': { limit: 20, windowMs: 60_000 },
            '/oauth/poll': { limit: 60, windowMs: 60_000 },
            '/commit': { limit: 30, windowMs: 60_000 }
        };
        const buckets = globalThis.__buckets ??= new Map();

        function rateLimit(req, path) {
            const cfg = RATE_LIMITS[path];
            if (!cfg) return { ok: true };
            const k = keyFor(req, path);
            const now = Date.now();
            let b = buckets.get(k);
            if (!b || now > b.resetAt) {
                b = { count: 0, resetAt: now + cfg.windowMs };
            }
            b.count++;
            buckets.set(k, b);
            if (b.count > cfg.limit) {
                return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
            }
            return { ok: true };
        }

        // Handle preflight for API routes
        if (req.method === 'OPTIONS' && isApi) {
            return new Response(null, { status: 204, headers: corsBase });
        }

        // Reject other origins for state-changing or cookie-bearing requests
        const SAFE_GETS = new Set(['/content', '/auth/me', '/csrf']);
        const isSafeRead = req.method === 'GET' && SAFE_GETS.has(url.pathname);
        const hasCookie = !!req.headers.get('Cookie');

        // Treat requests as allowed if:
        // - Origin is explicitly trusted
        // - or Referer origin is trusted
        // - or the browser says it's same-origin/site (Sec-Fetch-Site)
        function isFromAllowedSite(req) {
            const origin = req.headers.get('Origin') || '';
            if (origin) return isAllowedOriginStr(origin);
            const refOrigin = originFromRef(req);
            if (refOrigin) return isAllowedOriginStr(refOrigin);
            if (secFetchSameSite(req)) return true;
            return false;
        }

        if (!isSafeRead && ((req.method !== 'GET' && req.method !== 'HEAD') || hasCookie)) {
            if (!isFromAllowedSite(req)) {
                return json({ error: 'Forbidden origin' }, 403, corsBase);
            }
        }

        if (req.method === 'POST' && !requireJson(req)) {
            return json({ error: 'Unsupported content type' }, 415, corsBase);
        }

        // App config (optionally make these environment variables in Pages settings)
        const OWNER = env.OWNER || 'Monofly';
        const REPO = env.REPO || 'AMQ-Missing-Songs';
        const BRANCH = env.BRANCH || 'main';
        const CONTENT_PATH = env.CONTENT_PATH || 'data/anime_songs.json';

        try {
            if (req.method === 'GET' && url.pathname === '/csrf') {
                return csrfEndpoint(req, corsBase);
            }
            if (req.method === 'POST' && url.pathname === '/oauth/device-code') {
                const rl = rateLimit(req, '/oauth/device-code');
                if (!rl.ok) return json({ error: 'rate_limited' }, 429, corsBase, { 'Retry-After': String(rl.retryAfter) });
                return deviceCode(req, corsBase);
            }
            if (req.method === 'POST' && url.pathname === '/oauth/poll') {
                const rl = rateLimit(req, '/oauth/poll');
                if (!rl.ok) return json({ status: 'slow_down' }, 429, corsBase, { 'Retry-After': String(rl.retryAfter) });
                return oauthPoll(req, corsBase);
            }
            if (req.method === 'GET' && url.pathname === '/auth/me') {
                return authMe(req, corsBase, OWNER, REPO);
            }
            if (req.method === 'POST' && url.pathname === '/logout') {
                if (!(await requireCsrfDerived(req))) {
                    return json({ error: 'CSRF check failed' }, 403, corsBase);
                }
                return logout(corsBase);
            }
            if (req.method === 'GET' && url.pathname === '/content') {
                return getContent(corsBase, OWNER, REPO, BRANCH, CONTENT_PATH);
            }
            if (req.method === 'POST' && url.pathname === '/commit') {
                const rl = rateLimit(req, '/commit');
                if (!rl.ok) return json({ error: 'rate_limited' }, 429, corsBase, { 'Retry-After': String(rl.retryAfter) });
                if (!(await requireCsrfDerived(req))) {
                    return json({ error: 'CSRF check failed' }, 403, corsBase);
                }
                return commitContent(req, corsBase, OWNER, REPO, BRANCH, CONTENT_PATH);
            }

            // Fallback to static asset if path not matched (safety net)
            return env.ASSETS.fetch(req);

        } catch (e) {
            return json({ error: String(e.message || e) }, 500, corsBase);
        }

        // ===== helpers below =====

        function json(obj, status = 200, headers = {}, extraHeaders = {}) {
            const security = {
                'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'no-referrer',
                'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
                'X-Frame-Options': 'DENY',
                'Cross-Origin-Resource-Policy': 'same-site'
            };
            return new Response(JSON.stringify(obj), {
                status,
                headers: { 'Content-Type': 'application/json', ...security, ...headers, ...extraHeaders }
            });
        }

        async function csrfEndpoint(req, cors) {
            const gh = getCookie(req, '__Host-gh_at');
            if (!gh) return json({ error: 'Unauthorized' }, 401, cors);
            const binder = binderFromRequest(req);
            const csrf = await deriveCsrfFromToken(gh, binder);
            return json({ csrf }, 200, cors);
        }

        async function ghFetch(url, opts = {}) {
            const headers = new Headers(opts.headers || {});
            headers.set('User-Agent', 'monofly-anime-songs-worker');
            if (!headers.has('Accept')) headers.set('Accept', 'application/vnd.github+json');
            const res = await fetch(url, { ...opts, headers });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`GitHub ${res.status}: ${text}`);
            }
            return res;
        }

        async function deviceCode(req, cors) {
            const body = await req.json().catch(() => ({}));
            const { client_id, scope } = body || {};
            if (!client_id) return json({ error: 'Missing client_id' }, 400, cors);

            const gh = await ghFetch('https://github.com/login/device/code', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                },
                body: new URLSearchParams({ client_id, scope: scope || '' }).toString()
            }).then(r => r.json());

            return json(gh, 200, cors);
        }

        async function oauthPoll(req, cors) {
            const body = await req.json().catch(() => ({}));
            const { client_id, device_code } = body || {};
            if (!client_id || !device_code) return json({ error: 'Missing params' }, 400, cors);

            const gh = await ghFetch('https://github.com/login/oauth/access_token', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    client_id,
                    device_code,
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
                }).toString()
            }).then(r => r.json());

            if (gh.error) {
                if (gh.error === 'authorization_pending') return json({ status: 'pending' }, 200, cors);
                if (gh.error === 'slow_down') return json({ status: 'slow_down' }, 200, cors);
                if (gh.error === 'expired_token') return json({ error: 'expired' }, 400, cors);
                return json({ error: gh.error }, 400, cors);
            }

            const token = gh.access_token;
            if (!token) return json({ error: 'No access_token' }, 400, cors);

            const headers = new Headers(cors);
            setCookie(headers, '__Host-gh_at', token, 86400);

            const user = await ghFetch('https://api.github.com/user', {
                headers: { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${token}` }
            }).then(r => r.json());

            const origin = req.headers.get('Origin') || originFromRef(req) || '';
            const csrf = await deriveCsrfFromToken(token, binderFromRequest(req));

            return new Response(JSON.stringify({ ok: true, user, csrf }), { status: 200, headers });
        }

        async function authMe(req, cors, OWNER, REPO) {
            const token = getCookie(req, '__Host-gh_at');
            if (!token) return json({ loggedIn: false }, 200, cors);

            const headers = { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${token}` };
            const user = await ghFetch('https://api.github.com/user', { headers }).then(r => r.json());
            const repo = await ghFetch(`https://api.github.com/repos/${OWNER}/${REPO}`, { headers }).then(r => r.json());
            const canPush = !!(repo?.permissions?.push);
            const isOwner = user?.login && user.login.toLowerCase() === OWNER.toLowerCase();
            return json({ loggedIn: true, user, canPush: canPush || isOwner }, 200, cors);
        }

        async function logout(cors) {
            const headers = new Headers(cors);
            clearCookie(headers, '__Host-gh_at');
            return new Response(null, { status: 204, headers });
        }

        async function getContent(cors, OWNER, REPO, BRANCH, CONTENT_PATH) {
            const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(CONTENT_PATH)}?ref=${BRANCH}`;

            // 0) In-memory helpers (per runtime instance)
            const etagStore = (globalThis.__etagStore ??= new Map());
            const bodyStore = (globalThis.__bodyStore ??= new Map());

            // 1) Try CDN cache first (fast path)
            const cacheKey = new Request(new URL('/content', 'https://dummy').href, { method: 'GET' });
            const cached = await caches.default.match(cacheKey);
            if (cached) {
                const body = await cached.text();
                return json(JSON.parse(body), 200, cors, {
                    'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800'
                });
            }

            // 2) Conditional request to GitHub with ETag
            const prevEtag = etagStore.get(apiUrl);
            // build headers for GitHub read
            const headers = new Headers({
                'Accept': 'application/vnd.github.v3.raw',
                'User-Agent': 'monofly-anime-songs-worker'
            });
            if (prevEtag) headers.set('If-None-Match', prevEtag);
            // Use a read-only token if set in Pages environment
            if (env.GH_READ_TOKEN) headers.set('Authorization', `Bearer ${env.GH_READ_TOKEN}`);

            const res = await fetch(apiUrl, { headers, cache: 'no-store' });

            // 304 = Not Modified. Use cache/memory fallback; if empty, do one unconditional fetch.
            if (res.status === 304) {
                // 2a) Try CDN cache again (another POP might have warmed it)
                const stale = await caches.default.match(cacheKey);
                if (stale) {
                    const body = await stale.text();
                    return json(JSON.parse(body), 200, cors, { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800' });
                }

                // 2b) Try in-memory backup
                if (bodyStore.has(apiUrl)) {
                    const mem = bodyStore.get(apiUrl);
                    return json(mem, 200, cors, { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800' });
                }

                // 2c) Last-resort: refetch without If-None-Match to get the body
                const res2 = await fetch(apiUrl, {
                    headers: new Headers({
                        'Accept': 'application/vnd.github.v3.raw',
                        'User-Agent': 'monofly-anime-songs-worker'
                    }),
                    cache: 'no-store'
                });
                if (!res2.ok) {
                    const text2 = await res2.text().catch(() => '');
                    return json({ error: 'Failed to load content: GitHub ' + res2.status + ': ' + text2 }, 500, cors);
                }

                const text2 = await res2.text();
                let parsed2 = [];
                try { parsed2 = JSON.parse(text2); } catch { parsed2 = []; }

                const newEtag2 = res2.headers.get('ETag');
                if (newEtag2) etagStore.set(apiUrl, newEtag2);

                // store in memory and CDN cache
                bodyStore.set(apiUrl, parsed2);
                const toCache2 = new Response(JSON.stringify(parsed2), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800'
                    }
                });
                await caches.default.put(cacheKey, toCache2.clone());

                return json(parsed2, 200, cors, { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800' });
            }

            // Any non-2xx, non-304 => error
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return json({ error: 'Failed to load content: GitHub ' + res.status + ': ' + text }, 500, cors);
            }

            // 200 OK with fresh content
            const text = await res.text();
            let parsed = [];
            try { parsed = JSON.parse(text); } catch { parsed = []; }

            // Update ETag and memory backup
            const newEtag = res.headers.get('ETag');
            if (newEtag) etagStore.set(apiUrl, newEtag);
            bodyStore.set(apiUrl, parsed);

            // Put into CDN cache (serve stale up to 5 min)
            const toCache = new Response(JSON.stringify(parsed), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800'
                }
            });
            await caches.default.put(cacheKey, toCache.clone());

            return json(parsed, 200, cors, { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800' });
        }

        function isAllowedUrl(s, hosts) {
            try {
                const u = new URL(s);
                return (u.protocol === 'https:') && hosts.includes(u.host);
            } catch { return false; }
        }

        async function commitContent(req, cors, OWNER, REPO, BRANCH, CONTENT_PATH) {
            const token = getCookie(req, '__Host-gh_at');
            if (!token) return json({ error: 'Unauthorized' }, 401, cors);

            const body = await req.json().catch(() => ({}));
            const { content, message } = body || {};
            if (!Array.isArray(content)) return json({ error: 'Invalid content (expected array)' }, 400, cors);

            for (const item of content) {
                if (item.ann_url && !isAllowedUrl(item.ann_url, ['www.animenewsnetwork.com', 'animenewsnetwork.com'])) {
                    return json({ error: 'Invalid ann_url' }, 400, cors);
                }
                if (item.mal_url && !isAllowedUrl(item.mal_url, ['myanimelist.net'])) {
                    return json({ error: 'Invalid mal_url' }, 400, cors);
                }
            }
            if (!message) return json({ error: 'Missing commit message' }, 400, cors);

            const headers = { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${token}` };

            const meta = await ghFetch(
                `https://api.github.com/repos/${OWNER}/${REPO}/contents/${CONTENT_PATH}?ref=${BRANCH}`,
                { headers }
            ).then(r => r.json());

            const payloadStr = JSON.stringify(content, null, 2) + '\n';
            if (payloadStr.length > 500_000) {
                return json({ error: 'Payload too large' }, 413, cors);
            }

            const update = await ghFetch(
                `https://api.github.com/repos/${OWNER}/${REPO}/contents/${CONTENT_PATH}`,
                {
                    method: 'PUT',
                    headers,
                    body: JSON.stringify({
                        message,
                        content: b64EncodeUnicode(payloadStr),
                        sha: meta.sha,
                        branch: BRANCH
                    })
                }
            ).then(r => r.json());

            // Purge CDN cache for /content so changes show immediately
            try {
                const cacheKey = new Request(new URL('/content', 'https://dummy').href, { method: 'GET' });
                await caches.default.delete(cacheKey);
            } catch { }
            // Also clear in-memory ETag/body so next read refetches
            try {
                const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(CONTENT_PATH)}?ref=${BRANCH}`;
                const etagStore = (globalThis.__etagStore ??= new Map());
                const bodyStore = (globalThis.__bodyStore ??= new Map());
                etagStore.delete(apiUrl);
                bodyStore.delete(apiUrl);
            } catch { }
            return json({ ok: true, content: update?.content }, 200, cors);
        }
    }
};
