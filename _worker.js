export default {
    async fetch(req, env, ctx) {
        const url = new URL(req.url);

        // Routes handled by the worker; everything else is static assets
        const API_PATHS = new Set([
                    '/csrf',
                    '/oauth/device-code',
                    '/oauth/poll',
                    '/auth/me',
                    '/logout',
                    '/content',
                    '/content/meta',
                    '/commit'
                ]);

        const isApi = API_PATHS.has(url.pathname);

        // Serve static assets with security headers if not an API call
        if (!isApi && req.method !== 'OPTIONS') {
            const assetRes = await env.ASSETS.fetch(req);
            return withSecurityHeadersForAssets(assetRes);
        }

        // CORS and origin policy
        const PROD = 'https://monofly-amq.pages.dev';
        function isAllowedOriginStr(origin) {
            if (!origin)
                return false;
            try {
                const u = new URL(origin);
                const host = u.host;
                const isHttps = u.protocol === 'https:';
                const isLocal = (u.protocol === 'http:' && (host === 'localhost:8788' || host === '127.0.0.1:8788'));

                if (!isHttps && !isLocal)
                    return false;

                if (host === 'monofly-amq.pages.dev')
                    return true;

                // Preview domains for this project: monofly-amq-<hash>.pages.dev
                if (host.endsWith('.pages.dev') && host.startsWith('monofly-amq-'))
                    return true;

                if (host === 'localhost:8788' || host === '127.0.0.1:8788')
                    return true;

                return false;
            } catch {
                return false;
            }
        }

        // Used to bind the CSRF derivation to an origin-like value
        function binderFromRequest(req) {
            const origin = req.headers.get('Origin') || '';
            if (origin)
                return origin;
            try {
                return new URL(req.url).origin;
            } catch {
                return 'no-origin';
            }
        }

        function originFromRef(req) {
            const ref = req.headers.get('Referer') || '';
            try {
                return ref ? new URL(ref).origin : '';
            } catch {
                return '';
            }
        }

        function secFetchSameSite(req) {
            const s = (req.headers.get('Sec-Fetch-Site') || '').toLowerCase();
            return s === 'same-origin' || s === 'same-site';
        }

        // Very small helper to insist on JSON requests for JSON POST routes
        function requireJson(req) {
            return (req.headers.get('Content-Type') || '').toLowerCase().includes('application/json');
        }

        // Cookie helpers
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
                'SameSite=Strict'
            ];
            if (opts.httpOnly !== false)
                parts.push('HttpOnly');
            if (typeof maxAgeSeconds === 'number')
                parts.push(`Max-Age=${maxAgeSeconds}`);
            headers.append('Set-Cookie', parts.join('; '));
        }
        function clearCookie(headers, name) {
            headers.append('Set-Cookie', `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
        }

        // Base64 helpers (UTF-8 safe)
        function b64EncodeUnicode(str) {
            const bytes = new TextEncoder().encode(str);
            let bin = '';
            for (let i = 0; i < bytes.length; i++)
                bin += String.fromCharCode(bytes[i]);
            return btoa(bin);
        }
        function b64DecodeUnicode(str) {
            const bin = atob(str);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return new TextDecoder().decode(bytes);
        }
        function b64url(buf) {
            const bin = String.fromCharCode(...new Uint8Array(buf));
            return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        }

        // CSRF derived from GitHub token + request binder (origin)
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
            // Fallback for clients that cannot send the true origin
            const expectedNoOrigin = await deriveCsrfFromToken(gh, 'no-origin');
            return header === expectedNoOrigin;
        }

        // Base CORS headers (reflected origin if allowed)
        const reqOrigin = req.headers.get('Origin') || '';
        const corsBase = {
            'Access-Control-Allow-Origin': isAllowedOriginStr(reqOrigin) ? reqOrigin : PROD,
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
            'Access-Control-Allow-Headers': 'content-type, accept, x-csrf-token, X-CSRF-Token',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Max-Age': '86400',
            'Vary': 'Origin'
        };

        // Simple IP-based rate limiting buckets
        function keyFor(req, path) {
            const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';
            return `${path}|${ip}`;
        }
        const RATE_LIMITS = {
            '/oauth/device-code': { limit: 20, windowMs: 60_000 },
            '/oauth/poll':       { limit: 60, windowMs: 60_000 },
            '/commit':           { limit: 30, windowMs: 60_000 }
        };
        const buckets = globalThis.__buckets ??= new Map();

        // Add strong security headers to static assets
        async function withSecurityHeadersForAssets(res) {
            const csp = [
                "default-src 'self'",
                "script-src 'self' https://static.cloudflareinsights.com",
                "style-src 'self'",
                "img-src 'self'",
                "connect-src 'self' https://static.cloudflareinsights.com",
                "font-src 'self'",
                "object-src 'none'",
                "base-uri 'none'",
                "form-action 'self'",
                "frame-ancestors 'none'"
            ].join('; ');
            const headers = new Headers(res.headers);
            headers.set('Content-Security-Policy', csp);
            headers.set('X-Content-Type-Options', 'nosniff');
            headers.set('Referrer-Policy', 'no-referrer');
            headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
            headers.set('X-Frame-Options', 'DENY');
            headers.set('Cross-Origin-Resource-Policy', 'same-site');
            return new Response(res.body, { status: res.status, headers });
        }

        // Token bucket limiter per (path, ip)
        function rateLimit(req, path) {
            const cfg = RATE_LIMITS[path];
            if (!cfg) return { ok: true };
            const k = keyFor(req, path);
            const now = Date.now();
            let b = buckets.get(k);
            if (!b || now > b.resetAt) b = { count: 0, resetAt: now + cfg.windowMs };
            b.count++; buckets.set(k, b);
            if (b.count > cfg.limit) return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
            return { ok: true };
        }

        // CORS preflight for API
        if (req.method === 'OPTIONS' && isApi) {
            return new Response(null, { status: 204, headers: corsBase });
        }

        // Gate state-changing or cookie-bearing requests by origin policy
        const SAFE_GETS = new Set(['/content', '/auth/me', '/csrf']);
        const isSafeRead = req.method === 'GET' && SAFE_GETS.has(url.pathname);
        const hasCookie = !!req.headers.get('Cookie');
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

        // Require JSON for JSON POST endpoints
        const JSON_POSTS = new Set(['/oauth/device-code', '/oauth/poll', '/commit']);
        if (req.method === 'POST' && JSON_POSTS.has(url.pathname) && !requireJson(req)) {
            return json({ error: 'Unsupported content type' }, 415, corsBase);
        }

        // GitHub target repo config
        const OWNER = env.OWNER || 'Monofly';
        const REPO = env.REPO || 'AMQ-Missing-Songs-Data';
        const BRANCH = env.BRANCH || 'main';
        const CONTENT_PATH = env.CONTENT_PATH || 'data/anime_songs.json';

        try {
            // --- Routing ---
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
                if (!(await requireCsrfDerived(req))) return json({ error: 'CSRF check failed' }, 403, corsBase);
                return logout(corsBase);
            }
            if (req.method === 'GET' && url.pathname === '/content') {
                return getContent(corsBase, OWNER, REPO, BRANCH, CONTENT_PATH);
            }
            if (req.method === 'GET' && url.pathname === '/content/meta') {
                // Lightweight SHA fetch (uses memory cache if warmed by /content)
                const OWNER = env.OWNER || 'Monofly';
                const REPO = env.REPO || 'AMQ-Missing-Songs-Data';
                const BRANCH = env.BRANCH || 'main';
                const CONTENT_PATH = env.CONTENT_PATH || 'data/anime_songs.json';
                const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(CONTENT_PATH)}?ref=${BRANCH}`;

                const etagStore = (globalThis.__etagStore ??= new Map());
                const bodyStore = (globalThis.__bodyStore ??= new Map());
                const cachedBody = bodyStore.get(apiUrl);
                if (cachedBody && typeof cachedBody.sha === 'string' && cachedBody.sha.length > 0) {
                    return json({ sha: cachedBody.sha }, 200, corsBase, { 'Cache-Control': 'no-store' });
                }

                const headers = new Headers({ 'Accept': 'application/vnd.github+json', 'User-Agent': 'monofly-anime-songs-worker' });
                if (env.GH_READ_TOKEN) headers.set('Authorization', `Bearer ${env.GH_READ_TOKEN}`);

                let res;
                try {
                    res = await fetch(apiUrl, { headers, cache: 'no-store' });
                } catch {
                    // Try warming via full content fetch as fallback
                    try {
                        const contentRes = await fetch(api('/content'), { method: 'GET', headers: { 'Accept': 'application/json' }, cache: 'no-store' });
                        if (contentRes.ok) {
                            const j = await contentRes.json().catch(() => ({}));
                            const sha = j?.sha || '';
                            if (sha) return json({ sha }, 200, corsBase, { 'Cache-Control': 'no-store' });
                        }
                    } catch {}
                    return json({ error: 'Failed to load meta', source: 'network' }, 500, corsBase);
                }

                if (!res.ok) {
                    // Recover SHA by fetching full content
                    try {
                        const contentRes = await fetch(api('/content'), { method: 'GET', headers: { 'Accept': 'application/json' }, cache: 'no-store' });
                        if (contentRes.ok) {
                            const j = await contentRes.json().catch(() => ({}));
                            const sha = j?.sha || '';
                            if (sha) return json({ sha }, 200, corsBase, { 'Cache-Control': 'no-store' });
                        }
                    } catch {}
                    const text = await res.text().catch(() => '');
                    return json({ error: 'Failed to load meta', source: 'github', status: res.status, detail: text || '' }, 500, corsBase);
                }

                const meta = await res.json().catch(() => ({}));
                const sha = meta?.sha || '';
                return json({ sha }, 200, corsBase, { 'Cache-Control': 'no-store' });
            }
            if (req.method === 'POST' && url.pathname === '/commit') {
                const rl = rateLimit(req, '/commit');
                if (!rl.ok) return json({ error: 'rate_limited' }, 429, corsBase, { 'Retry-After': String(rl.retryAfter) });
                if (!(await requireCsrfDerived(req))) return json({ error: 'CSRF check failed' }, 403, corsBase);
                return commitContent(req, corsBase, OWNER, REPO, BRANCH, CONTENT_PATH);
            }

            // Fallback to static assets
            return env.ASSETS.fetch(req);

        } catch (e) {
            return json({ error: String(e.message || e) }, 500, corsBase);
        }

        // --- Small helpers ---
        function json(obj, status = 200, headers = {}, extraHeaders = {}) {
            const security = {
                'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'no-referrer',
                'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
                'X-Frame-Options': 'DENY',
                'Cross-Origin-Resource-Policy': 'same-site'
            };
            return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...security, ...headers, ...extraHeaders } });
        }

        async function csrfEndpoint(req, cors) {
            const gh = getCookie(req, '__Host-gh_at');
            if (!gh) return json({ error: 'Unauthorized' }, 401, cors, { 'Cache-Control': 'no-store' });
            const binder = binderFromRequest(req);
            const csrf = await deriveCsrfFromToken(gh, binder);
            return json({ csrf }, 200, cors, { 'Cache-Control': 'no-store' });
        }

        // Thin GitHub fetch wrapper with UA + default Accept
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

        // Device code start
        async function deviceCode(req, cors) {
            const body = await req.json().catch(() => ({}));
            const { client_id, scope } = body || {};
            if (!client_id) return json({ error: 'Missing client_id' }, 400, cors);
            const gh = await ghFetch('https://github.com/login/device/code', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
                body: new URLSearchParams({ client_id, scope: scope || '' }).toString()
            }).then(r => r.json());
            return json(gh, 200, cors, { 'Cache-Control': 'no-store' });
        }

        // Poll for device login completion
        async function oauthPoll(req, cors) {
            const body = await req.json().catch(() => ({}));
            const { client_id, device_code } = body || {};
            if (!client_id || !device_code) return json({ error: 'Missing params' }, 400, cors);
            const gh = await ghFetch('https://github.com/login/oauth/access_token', {
                method: 'POST',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_id, device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }).toString()
            }).then(r => r.json());
            if (gh.error) {
                if (gh.error === 'authorization_pending') return json({ status: 'pending' }, 200, cors);
                if (gh.error === 'slow_down') return json({ status: 'slow_down' }, 200, cors);
                if (gh.error === 'expired_token') return json({ error: 'expired' }, 400, cors);
                return json({ error: gh.error }, 400, cors);
            }
            const token = gh.access_token; if (!token) return json({ error: 'No access_token' }, 400, cors);
            const headers = new Headers(cors);
            setCookie(headers, '__Host-gh_at', token, 86400);
            const user = await ghFetch('https://api.github.com/user', { headers: { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${token}` } }).then(r => r.json());
            const csrf = await deriveCsrfFromToken(token, binderFromRequest(req));
            headers.set('Cache-Control', 'no-store');
            return new Response(JSON.stringify({ ok: true, user, csrf }), { status: 200, headers });
        }

        // Return session and permissions
        async function authMe(req, cors, OWNER, REPO) {
            const token = getCookie(req, '__Host-gh_at');
            if (!token) return json({ loggedIn: false }, 200, cors, { 'Cache-Control': 'no-store' });
            const headers = { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${token}` };
            
            // Fetch user info
            let user;
            try {
                user = await ghFetch('https://api.github.com/user', { headers }).then(r => r.json());
            } catch (e) {
                // Token might be invalid/expired
                return json({ loggedIn: false }, 200, cors, { 'Cache-Control': 'no-store' });
            }
            
            // Check if user is the repo owner (case-insensitive)
            const isOwner = user?.login && user.login.toLowerCase() === OWNER.toLowerCase();
            
            // Try to fetch repo permissions - this may fail for private repos if user lacks access
            let canPush = false;
            try {
                const repoRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, {
                    headers: new Headers({
                        'Accept': 'application/vnd.github+json',
                        'Authorization': `Bearer ${token}`,
                        'User-Agent': 'monofly-anime-songs-worker'
                    })
                });
                if (repoRes.ok) {
                    const repo = await repoRes.json();
                    canPush = !!(repo?.permissions?.push);
                }
            } catch {
                // Repo fetch failed - permissions remain false unless user is owner
            }
            
            return json({ loggedIn: true, user, canPush: canPush || isOwner }, 200, cors, { 'Cache-Control': 'no-store' });
        }

        // Clear auth cookie
        async function logout(cors) {
            const headers = new Headers(cors);
            clearCookie(headers, '__Host-gh_at');
            headers.set('Cache-Control', 'no-store');
            return new Response(null, { status: 204, headers });
        }

        // Load JSON content with CDN + ETag + in-memory caching
        async function getContent(cors, OWNER, REPO, BRANCH, CONTENT_PATH) {
            const cacheKey = new Request(new URL('/content', 'https://dummy').href, { method: 'GET' });
            const isFresh = (new URL(req.url).searchParams.get('fresh') === '1');
            const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(CONTENT_PATH)}?ref=${BRANCH}`;
            const etagStore = (globalThis.__etagStore ??= new Map());
            const bodyStore = (globalThis.__bodyStore ??= new Map());

            // 1) CDN cache first (fast path)
            if (!isFresh) {
                const cached = await caches.default.match(cacheKey);
                if (cached) {
                    const body = await cached.text();
                    return json(JSON.parse(body), 200, cors, { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800' });
                }
            }

            // 2) Conditional GitHub request using If-None-Match
            const prevEtag = !isFresh ? etagStore.get(apiUrl) : undefined;
            const headers = new Headers({ 'Accept': 'application/vnd.github+json', 'User-Agent': 'monofly-anime-songs-worker' });
            if (prevEtag) headers.set('If-None-Match', prevEtag);
            if (env.GH_READ_TOKEN) headers.set('Authorization', `Bearer ${env.GH_READ_TOKEN}`);
            const res = await fetch(apiUrl, { headers, cache: 'no-store' });

            // 304: fall back to CDN or in-memory, else refetch without ETag
            if (!isFresh && res.status === 304) {
                const stale = await caches.default.match(cacheKey);
                if (stale) {
                    const body = await stale.text();
                    return json(JSON.parse(body), 200, cors, { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800' });
                }
                if (bodyStore.has(apiUrl)) {
                    const mem = bodyStore.get(apiUrl);
                    return json(mem, 200, cors, { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800' });
                }
                const res2 = await fetch(apiUrl, { headers: new Headers({ 'Accept': 'application/vnd.github+json', 'User-Agent': 'monofly-anime-songs-worker' }), cache: 'no-store' });
                if (!res2.ok) {
                    const text2 = await res2.text().catch(() => '');
                    return json({ error: 'Failed to load content', source: 'github-refetch', status: res2.status, detail: text2 || '' }, 500, cors);
                }
                const text2 = await res2.text();
                let parsed2 = []; let sha2 = '';
                let data2 = { content: [], sha: '' };
                try {
                    const meta2 = JSON.parse(text2);
                    sha2 = meta2.sha;
                    const decodedContent2 = b64DecodeUnicode(meta2.content);
                    parsed2 = JSON.parse(decodedContent2);
                } catch { parsed2 = []; }
                data2 = { content: parsed2, sha: sha2 };

                if (!isFresh) {
                    const newEtag2 = res2.headers.get('ETag');
                    if (newEtag2) etagStore.set(apiUrl, newEtag2);
                    bodyStore.set(apiUrl, data2);
                    const toCache = new Response(JSON.stringify(data2), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800' } });
                    await caches.default.put(cacheKey, toCache.clone());
                }
                return json(data2, 200, cors, isFresh ? { 'Cache-Control': 'no-store' } : { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800' });
            }

            // Any other GitHub error
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return json({ error: 'Failed to load content', source: 'github', status: res.status, detail: text || '' }, 500, cors);
            }

            // 200 OK: parse and cache
            const text = await res.text();
            let parsed = []; let sha = '';
            let data = { content: [], sha: '' };
            try {
                const meta = JSON.parse(text);
                sha = meta.sha;
                const decodedContent = b64DecodeUnicode(meta.content);
                parsed = JSON.parse(decodedContent);
            } catch { parsed = []; }
            data = { content: parsed, sha };

            if (!isFresh) {
                const newEtag = res.headers.get('ETag');
                if (newEtag) etagStore.set(apiUrl, newEtag);
                bodyStore.set(apiUrl, data);
                const toCache = new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800' } });
                await caches.default.put(cacheKey, toCache.clone());
            }

            return json(data, 200, cors, isFresh ? { 'Cache-Control': 'no-store' } : { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=1800' });
        }

        // Allow-list URLs for ANN/MAL validation before commit
        function isAllowedUrl(s, hosts) {
            try { const u = new URL(s); return (u.protocol === 'https:') && hosts.includes(u.host); }
            catch { return false; }
        }

        // Apply a single change (add/edit/delete) and push to GitHub
        async function commitContent(req, cors, OWNER, REPO, BRANCH, CONTENT_PATH) {
            const token = getCookie(req, '__Host-gh_at');
            if (!token) return json({ error: 'Unauthorized' }, 401, cors);

            const body = await req.json().catch(() => ({}));
            const { change, target, message, baseSha, bulkUpdate } = body || {};
            if (!message) return json({ error: 'Missing commit message' }, 400, cors);

            const headers = { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${token}` };
            const meta = await ghFetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${CONTENT_PATH}?ref=${BRANCH}`, { headers }).then(r => r.json());

            // Load current JSON
            let currentData = [];
            try { const decodedContent = b64DecodeUnicode(meta.content); currentData = JSON.parse(decodedContent); }
            catch { return json({ error: 'Failed to parse current GitHub data' }, 500, cors); }

            // Mutate copy
            let working = currentData.slice();
            if (bulkUpdate) {
                working = bulkUpdate;
            } else if (target && target.id) {
                if (change === null) {
                    const beforeLength = working.length;
                    working = working.filter(x => x.id !== target.id);
                    if (beforeLength === working.length) return json({ error: 'Item not found for deletion.' }, 404, cors);
                } else {
                    let idx = working.findIndex(x => x.id === target.id);
                    if (idx < 0 && target.fallbackKey) {
                        idx = working.findIndex(x => {
                            const xKey = [
                                (x.anime_en || x.anime_romaji || '').toLowerCase(),
                                String(x.year || ''),
                                String(x.season || ''),
                                String(x.type || ''),
                                (x.song_title_romaji || x.song_title_original || '').toLowerCase(),
                                String(x.episode || ''),
                                String(x.time_start || '')
                            ].join('|');
                            return xKey === target.fallbackKey;
                        });
                    }
                    if (idx < 0) {
                        const availableIds = working.map(x => x.id).filter(Boolean).slice(0, 10);
                        return json({ error: 'Item not found for edit.', targetId: target.id, sampleIds: availableIds, totalItems: working.length }, 404, cors);
                    }
                    const existingId = working[idx].id || target.id;
                    working[idx] = { ...working[idx], ...change, id: existingId };
                }
            } else {
                if (change === null) return json({ error: 'Cannot delete a new unsaved entry.' }, 400, cors);
                const newItem = { ...change };
                if (!newItem.id || newItem.id.trim() === '') {
                    const rand = Math.random().toString(16).slice(2, 10);
                    newItem.id = `${Date.now()}-${rand}`;
                }
                working.push(newItem);
            }

            // Validate outbound links
            for (const item of working) {
                if (item.ann_url && !isAllowedUrl(item.ann_url, ['www.animenewsnetwork.com', 'animenewsnetwork.com']))
                    return json({ error: 'Invalid ann_url' }, 400, cors);
                if (item.mal_url && !isAllowedUrl(item.mal_url, ['myanimelist.net']))
                    return json({ error: 'Invalid mal_url' }, 400, cors);
            }

            // Size guard (keep the JSON small enough)
            const payloadStr = JSON.stringify(working, null, 2) + '\n';
            if (payloadStr.length > 500_000) return json({ error: 'Payload too large' }, 413, cors);

            // Try PUT with current meta; if stale, re-read and retry once
            async function tryUpdateWithMeta(currentMeta) {
                return await ghFetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${CONTENT_PATH}`, {
                    method: 'PUT',
                    headers,
                    body: JSON.stringify({ message, content: b64EncodeUnicode(payloadStr), sha: currentMeta.sha, branch: BRANCH })
                }).then(r => r.json());
            }
            let update;
            try { update = await tryUpdateWithMeta(meta); }
            catch { const meta2 = await ghFetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${CONTENT_PATH}?ref=${BRANCH}`, { headers }).then(r => r.json()); update = await tryUpdateWithMeta(meta2); }

            // Invalidate CDN + memory caches for /content
            try { const cacheKey = new Request(new URL('/content', 'https://dummy').href, { method: 'GET' }); await caches.default.delete(cacheKey); } catch {}
            try { const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(CONTENT_PATH)}?ref=${BRANCH}`; const etagStore = (globalThis.__etagStore ??= new Map()); const bodyStore = (globalThis.__bodyStore ??= new Map()); etagStore.delete(apiUrl); bodyStore.delete(apiUrl); } catch {}
            return json({ ok: true, sha: update?.content?.sha }, 200, cors);
        }
    }
};