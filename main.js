// ==== CONFIG ====
const CONFIG = {
    CLIENT_ID: 'Ov23ctADgidCYeXxj8mv'
};
// ===============

const els = {
    q: document.getElementById('q'),
    year: document.getElementById('year'),
    season: document.getElementById('season'),
    type: document.getElementById('type'),
    status: document.getElementById('status'),
    rows: document.getElementById('rows'),
    count: document.getElementById('countText'),
    adminBar: document.getElementById('adminBar'),
    loginBtn: document.getElementById('loginBtn'),
    logoutBtn: document.getElementById('logoutBtn'),
    loginStatus: document.getElementById('loginStatus'),
    addBtn: document.getElementById('addBtn'),
    saveNotice: document.getElementById('saveNotice'),
    modalBackdrop: document.getElementById('modalBackdrop'),
    editForm: document.getElementById('editForm'),
    modalTitle: document.getElementById('modalTitle'),
    modalNotice: document.getElementById('modalNotice'),
    cancelBtn: document.getElementById('cancelBtn'),
    saveBtn: document.getElementById('saveBtn'),
    pager: document.getElementById('pager'),
    prevPageBtn: document.getElementById('prevPageBtn'),
    nextPageBtn: document.getElementById('nextPageBtn'),
    pageInput: document.getElementById('pageInput'),
    pageTotal: document.getElementById('pageTotal'),
    pageInfo: document.getElementById('pageInfo'),
    topPager: document.getElementById('topPager'),
    topPrevPageBtn: document.getElementById('topPrevPageBtn'),
    topNextPageBtn: document.getElementById('topNextPageBtn'),
    topPageInput: document.getElementById('topPageInput'),
    topPageTotal: document.getElementById('topPageTotal')
};

function show(el) { if (el) el.hidden = false; }
function hide(el) { if (el) el.hidden = true; }

function setToolbarHeight() {
    const toolbar = document.getElementById('toolbar');
    if (!toolbar) return;
    // Use offsetHeight (includes padding/borders)
    const h = toolbar.offsetHeight || 0;
    document.documentElement.style.setProperty('--toolbar-height', `${h}px`);
}

// Helper to build same-origin API URLs
const api = (p) => p;

let DATA = [];
let isAdmin = false;
let currentUser = null;
let CSRF = '';
const CONTENT_PATH = 'data/anime_songs.json';

const PAGE_SIZE = 50;
let currentPage = 1;
let lastFiltered = [];

let SAVE_QUEUE_BUSY = false;

// Persisted filter state
const FILTER_KEYS = ['q', 'year', 'season', 'type', 'status'];
function getFilterState() {
    return {
        q: els.q.value,
        year: els.year.value,
        season: els.season.value,
        type: els.type.value,
        status: els.status.value
    };
}
function setFilterState(state) {
    if (!state) return;
    if (typeof state.q === 'string') els.q.value = state.q;
    if (state.year) els.year.value = state.year;
    if (state.season) els.season.value = state.season;
    if (state.type) els.type.value = state.type;
    if (state.status) els.status.value = state.status;
}
function saveFilterState() {
    const s = getFilterState();
    try { localStorage.setItem('filters', JSON.stringify(s)); } catch { }
}
function loadFilterState() {
    try {
        const raw = localStorage.getItem('filters');
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function watchToolbarHeight() {
    const toolbar = document.getElementById('toolbar');
    if (!toolbar) return;

    // Set immediately
    setToolbarHeight();

    // Update whenever the toolbar’s size changes
    const ro = new ResizeObserver(() => setToolbarHeight());
    ro.observe(toolbar);

    // Fonts loading can change line-heights → update again when ready
    if (document.fonts && typeof document.fonts.ready?.then === 'function') {
        document.fonts.ready.then(() => setToolbarHeight()).catch(() => { });
    }

    // Also run on orientation changes (mobile)
    window.addEventListener('orientationchange', () => setToolbarHeight());
    window.addEventListener('resize', () => setToolbarHeight());
}

function uniqueYears(items) { return Array.from(new Set(items.map(x => x.year))).filter(Boolean).sort((a, b) => b - a); }
function normalize(str) { return (str || '').toString().toLowerCase(); }
function isEmpty(s) { return !s || !String(s).trim(); }
function computeUnidentified(obj) {
    return isEmpty(obj.song_title_romaji) && isEmpty(obj.song_title_original);
}
function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }

function parseEpisodeStart(ep) {
    if (isEmpty(ep)) return Number.POSITIVE_INFINITY;
    const m = String(ep).match(/^(\d+)/);
    return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

function parseTimeToSeconds(t) {
    if (!t || !String(t).trim()) return Number.POSITIVE_INFINITY;
    const parts = String(t).split(':').map(Number);
    if (parts.some(n => Number.isNaN(n))) return Number.POSITIVE_INFINITY;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
    return Number.POSITIVE_INFINITY;
}

function durationSeconds(start, end) {
    const s = parseTimeToSeconds(start);
    const e = parseTimeToSeconds(end);
    // Only compute if both times are valid and end >= start.
    if (!Number.isFinite(s) || !Number.isFinite(e)) return '';
    const d = e - s;
    if (!Number.isFinite(d) || d < 0) return '';
    return `${d}s`;
}

// Consistent “complete” definition used by filters and tags
function isComplete(it) {
    const hasArtist = !isEmpty(it.artist_romaji) || !isEmpty(it.artist_original);
    const hasMal = !!it.mal_url;
    const hasIssues = Array.isArray(it.issues) && it.issues.length > 0;
    const cleanOK = it.clean_available !== false;
    const unidentified = !!it.unidentified;
    return hasArtist && hasMal && cleanOK && !hasIssues && !unidentified;
}

// Multi-key comparator: anime title -> episode -> start time
function compareItems(a, b) {
    const aTitle = (a.anime_en?.trim() || a.anime_romaji?.trim() || '').toLowerCase();
    const bTitle = (b.anime_en?.trim() || b.anime_romaji?.trim() || '').toLowerCase();
    const byTitle = aTitle.localeCompare(bTitle);
    if (byTitle !== 0) return byTitle;

    const aEp = parseEpisodeStart(a.episode);
    const bEp = parseEpisodeStart(b.episode);
    if (aEp !== bEp) return aEp - bEp;

    const aStart = parseTimeToSeconds(a.time_start);
    const bStart = parseTimeToSeconds(b.time_start);
    return aStart - bStart;
}

function statusTags(item) {
    const tags = [];
    if (item.unidentified) tags.push({ cls: 'bad', text: 'Unidentified' });
    if (item.clean_available === false) tags.push({ cls: 'warn', text: 'Missing clean' });
    if (!item.mal_url) tags.push({ cls: 'warn', text: 'Missing MAL' });

    if (isEmpty(item.artist_romaji) && isEmpty(item.artist_original)) {
        tags.push({ cls: 'warn', text: 'Missing artist' });
    }

    if (Array.isArray(item.issues) && item.issues.length) tags.push({ cls: 'warn', text: 'Other issues' });
    if (isComplete(item) && !tags.length) tags.push({ cls: 'ok', text: 'No issues' });
    return tags;
}

function displayTitle(primary, secondary) {
    const a = (primary || '').trim();
    const b = (secondary || '').trim();
    if (isEmpty(a) && isEmpty(b)) return '—';
    if (isEmpty(b)) return escapeHtml(a);      // only primary present
    if (isEmpty(a)) return escapeHtml(b);      // only secondary present -> show as primary
    if (normalize(a) === normalize(b)) return escapeHtml(a);
    return `<div class="two-line">
    <div>${escapeHtml(a)}</div>
    <div class="muted">${escapeHtml(b)}</div>
  </div>`;
}

function displayName(label, romaji, original) {
    const content = displayTitle(romaji, original);
    return `<div><span class="label">${label}:</span> ${content}</div>`;
}

function personBlock(item) {
    return [
        displayName('Artist', item.artist_romaji, item.artist_original),
        displayName('Composer', item.composer_romaji, item.composer_original),
        displayName('Arranger', item.arranger_romaji, item.arranger_original)
    ].join('');
}

function timeRange(start, end) {
    if (isEmpty(start) && isEmpty(end)) return '—';
    if (isEmpty(end)) return `${escapeHtml(start)}–?`;
    if (isEmpty(start)) return `?–${escapeHtml(end)}`;
    return `${escapeHtml(start)}–${escapeHtml(end)}`;
}

function applyFilters({ resetPage = false } = {}) {
    const q = normalize(els.q.value);
    const year = els.year.value;
    const season = els.season.value;
    const type = els.type.value;
    const status = els.status.value;

    const filtered = DATA
        .filter(it => {
            if (year !== 'all' && String(it.year) !== year) return false;
            if (season !== 'all' && it.season !== season) return false;
            if (type !== 'all' && it.type !== type) return false;

            if (status !== 'all') {
                if (status === 'unidentified' && !it.unidentified) return false;
                if (status === 'missing_clean' && it.clean_available !== false) return false;
                if (status === 'missing_artist' && !(isEmpty(it.artist_romaji) && isEmpty(it.artist_original))) return false;
                if (status === 'missing_mal' && !!it.mal_url) return false;
                if (status === 'has_issues' && !(Array.isArray(it.issues) && it.issues.length)) return false;
                if (status === 'no_issues' && !isComplete(it)) return false;
            }

            if (q) {
                const hay = [
                    it.anime_en, it.anime_romaji,
                    it.song_title_romaji, it.song_title_original,
                    it.artist_romaji, it.artist_original,
                    it.composer_romaji, it.composer_original,
                    it.arranger_romaji, it.arranger_original,
                    it.episode, it.notes,
                    ...(Array.isArray(it.issues) ? it.issues : [])
                ].map(normalize).join(' ');
                if (!hay.includes(q)) return false;
            }
            return true;
        })
        .sort(compareItems);

    lastFiltered = filtered;
    if (resetPage) currentPage = 1; // only reset if explicitly asked
    renderPage();
    saveFilterState();
}

function renderRows(items, totalFilteredCount = items.length) {
    document.body.classList.toggle('admin-on', isAdmin);

    // Show the filtered count, not just current page count:
    els.count.textContent = `${totalFilteredCount} result${totalFilteredCount === 1 ? '' : 's'} • ${DATA.length} total`;

    els.rows.innerHTML = items.map(it => {
        const tags = statusTags(it).map(t => `<span class="pill ${t.cls}">${t.text}</span>`).join(' ');
        const issues = (Array.isArray(it.issues) && it.issues.length) ? `<div class="mono">Issues: ${it.issues.map(escapeHtml).join(', ')}</div>` : '';
        const ep = isEmpty(it.episode) ? '—' : escapeHtml(String(it.episode));
        const time = timeRange(it.time_start, it.time_end);
        const dur = durationSeconds(it.time_start, it.time_end);
        const idx = it._index; // stable index we attach during normalization
        const rowActionsAnime = isAdmin ? `
          <div class="row-actions">
            <button class="btn" data-add-from="${idx}">Add Entry From This Show</button>
          </div>` : '';

        const rowActionsSong = isAdmin ? `
          <div class="row-actions">
            <button class="btn secondary" data-edit="${idx}">Edit</button>
            <button class="btn danger" data-delete="${idx}">Delete</button>
          </div>` : '';

        return `<tr>
          <td>
            ${displayTitle(it.anime_en, it.anime_romaji)}
            <div class="mono">${it.season || '—'} ${it.year || '—'} • Ep ${ep}</div>
            <div class="mono">${time}${dur ? `, ${dur}` : ''}</div>
            ${rowActionsAnime}
          </td>
          <td>
            ${displayTitle(it.song_title_romaji, it.song_title_original)}
            <div class="mono">${tags}</div>
            ${rowActionsSong}
          </td>
          <td>${personBlock(it)}${it.notes ? `<div class="mono preline">Notes: ${escapeHtml(it.notes)}</div>` : ''}${issues}</td>
          <td><span class="pill type">${escapeHtml(it.type || '—')}</span></td>
          <td>${linkOrDash(it.ann_url, 'ANN')} · ${linkOrDash(it.mal_url, 'MAL')}</td>
        </tr>`;
    }).join('');

    if (isAdmin) {
        els.rows.querySelectorAll('[data-edit]').forEach(btn => {
            btn.addEventListener('click', async () => {
                await restoreSession();
                if (!isAdmin) { alert('You are not authorized to edit.'); return; }
                openEditor(Number(btn.getAttribute('data-edit')));
            });
        });
        els.rows.querySelectorAll('[data-delete]').forEach(btn => {
            btn.addEventListener('click', () => confirmDelete(Number(btn.getAttribute('data-delete'))));
        });
        els.rows.querySelectorAll('[data-add-from]').forEach(btn => {
            btn.addEventListener('click', async () => {
                await restoreSession();
                if (!isAdmin) { alert('You are not authorized to add.'); return; }
                const i = Number(btn.getAttribute('data-add-from'));
                openEditor(null, buildPresetFromShow(DATA[i]));
            });
        });
    }
}

function totalPages() {
    return Math.max(1, Math.ceil((lastFiltered.length || 0) / PAGE_SIZE));
}

function clampPage(n) {
    return Math.min(totalPages(), Math.max(1, n || 1));
}

function updatePagerUI() {
    const tp = totalPages();
    const hasMany = lastFiltered.length > PAGE_SIZE;

    // Helper to update one pager set
    const setPager = (which) => {
        if (!which) return;
        const { wrapper, prev, next, input, total, info } = which;

        if (wrapper) wrapper.hidden = !hasMany;
        if (!hasMany) {
            if (info) info.textContent = '';
            return;
        }

        if (total) total.textContent = String(tp);
        if (input) input.value = String(currentPage);
        if (prev) prev.disabled = currentPage <= 1;
        if (next) next.disabled = currentPage >= tp;

        if (info) {
            const start = (currentPage - 1) * PAGE_SIZE + 1;
            const end = Math.min(currentPage * PAGE_SIZE, lastFiltered.length);
            info.textContent = `Showing ${start}–${end} of ${lastFiltered.length}`;
        }
    };

    // Bottom pager
    setPager({
        wrapper: els.pager,
        prev: els.prevPageBtn,
        next: els.nextPageBtn,
        input: els.pageInput,
        total: els.pageTotal,
        info: els.pageInfo
    });

    // Top pager (no info line)
    setPager({
        wrapper: els.topPager,
        prev: els.topPrevPageBtn,
        next: els.topNextPageBtn,
        input: els.topPageInput,
        total: els.topPageTotal,
        info: null
    });
}

function renderPage() {
    const tp = totalPages();
    currentPage = clampPage(currentPage);
    const startIdx = (currentPage - 1) * PAGE_SIZE;
    const pageItems = lastFiltered.slice(startIdx, startIdx + PAGE_SIZE);
    renderRows(pageItems, lastFiltered.length);
    updatePagerUI();
}

function goToPage(n) {
    currentPage = clampPage(n);
    renderPage();
}

function populateYearOptions(items) {
    const years = uniqueYears(items);
    const select = document.getElementById('year');
    const previous = select.value || 'all';
    select.innerHTML =
        `<option value="all">All years</option>` +
        years.map(y => `<option value="${y}">${y}</option>`).join('');
    // Restore previous selection if still available
    const restore = years.includes(Number(previous)) ? previous : 'all';
    select.value = restore;
}

async function init() {
    try {
        watchToolbarHeight();
        const res = await fetch(api('/content'), {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            credentials: 'include', // include cookies (not strictly required for GET /content)
            cache: 'no-store'
        });
        if (!res.ok) throw new Error(`Load error ${res.status}`);
        const raw = await res.json();

        DATA = (raw || []).map((x, i) => ({
            anime_en: '', anime_romaji: '',
            year: '', season: 'Winter',
            type: 'OP',
            song_title_romaji: '', song_title_original: '',
            artist_romaji: '', artist_original: '',
            composer_romaji: '', composer_original: '',
            arranger_romaji: '', arranger_original: '',
            episode: '', time_start: '', time_end: '',
            unidentified: false,
            clean_available: true,
            ann_url: '', mal_url: '',
            issues: [],
            notes: '',
            ...x,
            _index: i
        }));

        DATA.sort(compareItems);
        DATA = DATA.map((item, i) => ({ ...item, _index: i }));

        populateYearOptions(DATA);
        // Restore filters from localStorage before wiring events
        const saved = loadFilterState();
        setFilterState(saved);
        [els.q, els.year, els.season, els.type, els.status].forEach(el => {
            el.addEventListener('input', () => applyFilters({ resetPage: true }));
        });
        wireAdminBar();

        // Pager controls
        if (els.prevPageBtn && els.nextPageBtn && els.pageInput) {
            els.prevPageBtn.addEventListener('click', () => goToPage(currentPage - 1));
            els.nextPageBtn.addEventListener('click', () => goToPage(currentPage + 1));

            const tryInputPage = () => {
                const n = Number.parseInt(els.pageInput.value, 10);
                if (!Number.isFinite(n)) return;
                goToPage(n); // clampPage will fix <=0 => 1 and >max => max
            };
            els.pageInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') tryInputPage();
            });
            els.pageInput.addEventListener('blur', tryInputPage);
        }

        // Top pager controls
        if (els.topPrevPageBtn && els.topNextPageBtn && els.topPageInput) {
            els.topPrevPageBtn.addEventListener('click', () => goToPage(currentPage - 1));
            els.topNextPageBtn.addEventListener('click', () => goToPage(currentPage + 1));

            const tryTopInputPage = () => {
                const n = Number.parseInt(els.topPageInput.value, 10);
                if (!Number.isFinite(n)) return;
                goToPage(n); // clampPage ensures bounds
            };
            els.topPageInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') tryTopInputPage();
            });
            els.topPageInput.addEventListener('blur', tryTopInputPage);
        }

        // Make sure toolbar matches the default (not signed in) state immediately:
        updateAdminVisibility();

        if (localStorage.getItem('wasAdminOrUser') === '1') {
            await restoreSession();
            await ensureCsrf();
        }
        applyFilters({ resetPage: true });
        setToolbarHeight();
    } catch (e) {
        els.count.textContent = 'Could not load data/anime_songs.json';
    }
}

// ===== Admin UI and GitHub API =====

function wireAdminBar() {
    els.loginBtn.addEventListener('click', async () => {
        await loginWithGitHub();
    });
    els.logoutBtn.addEventListener('click', async () => {
        await ensureCsrf();
        await fetch(api('/logout'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': CSRF,
                'Accept': 'application/json'
            },
            body: '{}',
            credentials: 'include'
        });
        // Clear local state fully
        CSRF = '';
        currentUser = null;
        isAdmin = false;
        localStorage.removeItem('wasAdminOrUser');
        updateAdminVisibility();
        applyFilters();
        // Reload to be 100% sure no stale state lingers
        location.reload();
    });
    els.addBtn.addEventListener('click', async () => {
        await restoreSession();
        if (!isAdmin) { alert('You are not authorized to add.'); return; }
        openEditor(null);
    });
}

function updateAdminVisibility() {
    if (currentUser && isAdmin) {
        els.loginStatus.textContent = `Signed in as ${currentUser.login}`;
        hide(els.loginBtn);
        show(els.logoutBtn);
        show(els.addBtn);
    } else if (currentUser && !isAdmin) {
        els.loginStatus.textContent = `Signed in as ${currentUser.login} (no write access)`;
        hide(els.loginBtn);
        show(els.logoutBtn);
        hide(els.addBtn);
    } else {
        els.loginStatus.textContent = 'Not signed in';
        show(els.loginBtn);
        hide(els.logoutBtn);
        hide(els.addBtn);
    }
    setToolbarHeight();
}

async function ensureCsrf() {
    if (CSRF) return CSRF;
    try {
        const r = await fetch(api('/csrf'), {
            method: 'GET',
            credentials: 'include',
            headers: { 'Accept': 'application/json' }
        });
        if (r.ok) {
            const j = await r.json();
            if (j.csrf) CSRF = j.csrf;
        }
    } catch { }
    return CSRF;
}

function safeHref(href, allowedHosts = []) {
    try {
        const u = new URL(href);
        const okScheme = u.protocol === 'https:';
        const okHost = allowedHosts.length ? allowedHosts.includes(u.host) : true;
        return okScheme && okHost ? u.href : null;
    } catch { return null; }
}

function linkOrDash(href, label) {
    const safe = safeHref(href, [
        'animenewsnetwork.com',
        'www.animenewsnetwork.com',
        'myanimelist.net'
    ]);
    return safe ? `<a class="link" target="_blank" rel="noopener noreferrer" href="${safe}">${label}</a>` : '—';
}

async function restoreSession() {
    // Ask worker who we are (uses cookie)
    try {
        const res = await fetch(api('/auth/me'), {
            headers: { 'Accept': 'application/json' },
            credentials: 'include'
        });
        if (!res.ok) throw new Error('auth/me failed');
        const info = await res.json();
        if (info.loggedIn) {
            currentUser = info.user;
            isAdmin = !!info.canPush;
            localStorage.setItem('wasAdminOrUser', '1');
        } else {
            currentUser = null;
            isAdmin = false;
            localStorage.removeItem('wasAdminOrUser');
        }
    } catch {
        currentUser = null;
        isAdmin = false;
    }
    updateAdminVisibility();
}

async function loginWithGitHub() {
    // 1) Start device flow via Worker
    const start = await fetch(api('/oauth/device-code'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ client_id: CONFIG.CLIENT_ID, scope: 'public_repo' })
    }).then(r => r.json()).catch(() => null);

    if (!start || !start.device_code) {
        alert('GitHub login failed to start.');
        return;
    }

    const { device_code, user_code, verification_uri, expires_in, interval } = start;

    const msg = `1) Visit: ${verification_uri}\n2) Enter code: ${user_code}\n\nKeep this tab open; we’ll finish automatically.`;
    if (!confirm(msg + '\n\nClick OK after you’ve entered the code.')) {
        return;
    }

    // 2) Poll via Worker (cookie will be set server-side when ready)
    const began = Date.now();
    const pollMs = Math.max((interval || 5), 3) * 1000;

    while (Date.now() - began < (expires_in * 1000)) {
        await new Promise(r => setTimeout(r, pollMs));
        const resp = await fetch(api('/oauth/poll'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ client_id: CONFIG.CLIENT_ID, device_code })
        }).then(r => r.json()).catch(() => ({}));

        if (resp.status === 'pending') continue;
        if (resp.status === 'slow_down') {
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }
        if (resp.error) {
            alert('GitHub login error: ' + resp.error);
            return;
        }
        if (resp.ok) {
            // Cookie is set; we also got user info back
            currentUser = resp.user;
            if (resp.csrf) CSRF = resp.csrf;
            // Double-check push permission
            await restoreSession();
            if (!isAdmin) alert('Signed in but you do not have write access to this repo.');
            applyFilters();
            return;
        }
    }

    alert('GitHub login timed out. Please try again.');
}

async function verifyAdmin() {
    await restoreSession();
    return isAdmin;
}

// Build a stable-ish key to find matching entries across refreshes
function entryKey(it) {
    return [
        normalize(it.anime_en || it.anime_romaji || ''),
        String(it.year || ''),
        String(it.season || ''),
        String(it.type || ''),
        normalize(it.song_title_romaji || it.song_title_original || ''),
        normalize(it.artist_romaji || it.artist_original || ''),
        String(it.episode || ''),
        String(it.time_start || '')
    ].join('|');
}

// Merge new change into the freshest data from server
async function commitJsonWithRefresh(changeObj, index, commitMessage) {
    els.saveBtn.disabled = true;
    show(els.saveNotice);
    els.saveNotice.textContent = 'Saving…';
    try {
        await ensureCsrf();

        const freshRes = await fetch(api('/content'), {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            credentials: 'include',
            cache: 'no-store'
        });
        if (!freshRes.ok) throw new Error(`Refresh failed ${freshRes.status}`);
        const freshArray = await freshRes.json();

        const freshWithIndex = freshArray.map((x, i) => ({ ...x, _index: i }));
        const freshKeys = new Map(freshWithIndex.map(x => [entryKey(x), x._index]));

        let targetKey;
        if (index === null) {
            targetKey = changeObj ? entryKey(changeObj) : null; // null when deleting new → not allowed
        } else {
            const currentIt = DATA[index];
            targetKey = entryKey(currentIt);
        }

        let newArray = freshArray.slice();

        // Handle add/edit/delete distinctly
        if (index === null) {
            if (changeObj === null) {
                throw new Error('Cannot delete a new unsaved entry.');
            }
            // Add
            newArray.push(changeObj);
        } else {
            const matchIdx = freshKeys.has(targetKey) ? freshKeys.get(targetKey) : null;
            if (changeObj === null) {
                // Delete
                if (matchIdx === null || matchIdx === undefined) {
                    // If not found in fresh, nothing to delete
                } else {
                    newArray.splice(matchIdx, 1);
                }
            } else {
                // Edit
                if (matchIdx === null || matchIdx === undefined) {
                    // If not found, treat as add to avoid losing data
                    newArray.push(changeObj);
                } else {
                    newArray[matchIdx] = { ...newArray[matchIdx], ...changeObj };
                }
            }
        }

        const payloadArray = newArray.map(({ _index, ...rest }) => rest);
        const res = await fetch(api('/commit'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-CSRF-Token': CSRF
            },
            credentials: 'include',
            body: JSON.stringify({ content: payloadArray, message: commitMessage, baseSha: await getCurrentSha() })
        });

        if (res.status === 409) {
            const j = await res.json().catch(() => ({}));
            const freshRes2 = await fetch(api('/content'), {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                credentials: 'include',
                cache: 'no-store'
            });
            if (!freshRes2.ok) throw new Error(`Refresh failed ${freshRes2.status}`);
            const freshArray2 = await freshRes2.json();

            const fresh2WithIndex = freshArray2.map((x, i) => ({ ...x, _index: i }));
            const fresh2Keys = new Map(fresh2WithIndex.map(x => [entryKey(x), x._index]));
            let newArray2 = freshArray2.slice();

            const matchIdx2 = index === null ? null : (fresh2Keys.has(targetKey) ? fresh2Keys.get(targetKey) : null);

            if (index === null) {
                if (changeObj === null) {
                    throw new Error('Cannot delete a new unsaved entry.');
                }
                newArray2.push(changeObj);
            } else {
                if (changeObj === null) {
                    if (matchIdx2 === null || matchIdx2 === undefined) {
                        // nothing to delete
                    } else {
                        newArray2.splice(matchIdx2, 1);
                    }
                } else {
                    if (matchIdx2 === null || matchIdx2 === undefined) {
                        newArray2.push(changeObj);
                    } else {
                        newArray2[matchIdx2] = { ...newArray2[matchIdx2], ...changeObj };
                    }
                }
            }

            const payloadArray2 = newArray2.map(({ _index, ...rest }) => rest);
            const res2 = await fetch(api('/commit'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-CSRF-Token': CSRF
                },
                credentials: 'include',
                body: JSON.stringify({ content: payloadArray2, message: commitMessage, baseSha: j.currentSha || await getCurrentSha() })
            });

            if (!res2.ok) {
                const txt2 = await res2.text().catch(() => '');
                throw new Error(`Save failed (retry): ${res2.status} ${txt2}`);
            }

            await afterCommitUpdateLocal(payloadArray2);
            els.saveNotice.textContent = 'Saved.';
            setTimeout(() => { hide(els.saveNotice); setToolbarHeight(); }, 2000);
            return;
        }

        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(`Save failed: ${res.status} ${txt}`);
        }

        await afterCommitUpdateLocal(payloadArray);
        els.saveNotice.textContent = 'Saved.';
        setTimeout(() => { hide(els.saveNotice); setToolbarHeight(); }, 2000);

    } finally {
        els.saveBtn.disabled = false;
    }
}

// Get current SHA by asking the repo metadata via a lightweight HEAD-like call
// We reuse the worker to expose SHA by doing a meta fetch inside commit flow.
// For simplicity here, we call the GitHub contents API via the worker by piggybacking:
// the worker already reads meta in commit; we don't have a separate endpoint,
// so we fetch /content and rely on 2nd commit to provide currentSha after conflict.
// Fallback: return empty string if unavailable.
async function getCurrentSha() {
    // No dedicated endpoint; return empty string and let server accept if no baseSha provided
    return '';
}

// After a successful commit, refresh DATA locally without losing filters or page
async function afterCommitUpdateLocal(payloadArray) {
    // Rebuild DATA once, then sort, then re-index once
    DATA = payloadArray.slice();
    DATA.sort(compareItems);
    DATA = DATA.map((item, i) => ({ ...item, _index: i }));

    const saved = loadFilterState();
    populateYearOptions(DATA);
    setFilterState(saved);

    applyFilters({ resetPage: false });
}

// ===== Editor modal =====

function buildPresetFromShow(it) {
    return {
        anime_en: it.anime_en || '',
        anime_romaji: it.anime_romaji || '',
        year: it.year || '',
        season: it.season || 'Winter',
        type: 'OP', // default; can be changed in the form
        song_title_romaji: '',
        song_title_original: '',
        artist_romaji: '',
        artist_original: '',
        composer_romaji: '',
        composer_original: '',
        arranger_romaji: '',
        arranger_original: '',
        episode: '',
        time_start: '',
        time_end: '',
        clean_available: false,
        ann_url: it.ann_url || '',
        mal_url: it.mal_url || '',
        issues: [],
        notes: ''
    };
}

function openEditor(index, preset) {
    els.modalNotice.textContent = '';
    const isNew = (index === null || index === undefined);
    const indexOrNew = isNew ? null : index;
    els.modalTitle.textContent = isNew ? 'Add entry' : 'Edit entry';

    // Prefer draft if available, otherwise preset/data
    const draft = loadDraft(indexOrNew);

    if (draft) {
        fillForm({ ...draft, _index: isNew ? '' : index });
    } else if (!isNew) {
        const it = DATA[index];
        fillForm(it);
    } else {
        const baseDefaults = { season: 'Winter', type: 'OP', clean_available: false, issues: [] };
        fillForm({ ...baseDefaults, ...(preset || {}) });
    }

    // Show the modal
    els.modalBackdrop.hidden = false;
    els.modalBackdrop.setAttribute('aria-hidden', 'false');

    // Auto-save draft on any input change
    const f = els.editForm;
    const onChange = () => saveDraft(indexOrNew);
    const clearError = () => {
        els.modalNotice.textContent = '';
        els.modalNotice.classList.remove('error');
    };
    Array.from(f.elements).forEach(el => {
        if (el.name) el.addEventListener('input', clearError, { passive: true });
    });
    Array.from(f.elements).forEach(el => {
        if (el.name) el.addEventListener('input', onChange, { passive: true });
        if (el.name) el.addEventListener('change', onChange, { passive: true });
    });
}

function closeEditor() {
    els.modalBackdrop.hidden = true;
    els.modalBackdrop.setAttribute('aria-hidden', 'true');
    // Do NOT clear the form or draft here (only on Save/Cancel)
}

function fillForm(it) {
    const f = els.editForm;
    f.elements.anime_en.value = it.anime_en || '';
    f.elements.anime_romaji.value = it.anime_romaji || '';
    f.elements.year.value = it.year || '';
    f.elements.season.value = it.season || 'Winter';
    f.elements.type.value = it.type || 'OP';
    f.elements.episode.value = (it.episode ?? '');
    f.elements.time_start.value = it.time_start || '';
    f.elements.time_end.value = it.time_end || '';

    f.elements.song_title_romaji.value = it.song_title_romaji || '';
    f.elements.song_title_original.value = it.song_title_original || '';

    f.elements.artist_romaji.value = it.artist_romaji || '';
    f.elements.artist_original.value = it.artist_original || '';

    f.elements.composer_romaji.value = it.composer_romaji || '';
    f.elements.composer_original.value = it.composer_original || '';

    f.elements.arranger_romaji.value = it.arranger_romaji || '';
    f.elements.arranger_original.value = it.arranger_original || '';

    f.elements.clean_available.value = String(!(it.clean_available === false));

    f.elements.ann_url.value = it.ann_url || '';
    f.elements.mal_url.value = it.mal_url || '';

    f.elements.issues.value = Array.isArray(it.issues) ? it.issues.join(', ') : '';
    f.elements.notes.value = it.notes || '';

    f.elements._index.value = (it._index ?? '');
}

function readForm() {
    const f = els.editForm;
    // Coerce types where appropriate
    const yearRaw = f.elements.year.value.trim();
    const year = yearRaw ? Number(yearRaw) : '';
    const clean_available = f.elements.clean_available.value === 'true';
    const issues = f.elements.issues.value.split(',').map(s => s.trim()).filter(Boolean);

    const out = {
        anime_en: f.elements.anime_en.value.trim(),
        anime_romaji: f.elements.anime_romaji.value.trim(),
        year: Number.isFinite(year) && String(year).length === 4 ? year : '',
        season: f.elements.season.value,
        type: f.elements.type.value,
        song_title_romaji: f.elements.song_title_romaji.value.trim(),
        song_title_original: f.elements.song_title_original.value.trim(),
        artist_romaji: f.elements.artist_romaji.value.trim(),
        artist_original: f.elements.artist_original.value.trim(),
        composer_romaji: f.elements.composer_romaji.value.trim(),
        composer_original: f.elements.composer_original.value.trim(),
        arranger_romaji: f.elements.arranger_romaji.value.trim(),
        arranger_original: f.elements.arranger_original.value.trim(),
        episode: f.elements.episode.value.trim(),
        time_start: f.elements.time_start.value.trim(),
        time_end: f.elements.time_end.value.trim(),
        // Auto-compute
        unidentified: false, // set below
        clean_available,
        ann_url: f.elements.ann_url.value.trim(),
        mal_url: f.elements.mal_url.value.trim(),
        issues,
        notes: f.elements.notes.value.trim()
    };

    out.unidentified = computeUnidentified(out);

    const idxStr = f.elements._index.value;
    const index = idxStr === '' ? null : Number(idxStr);
    return { out, index };
}

// Per-entry draft storage (session) so accidental close doesn't lose data
function draftKeyFor(indexOrNew) {
    return indexOrNew === null ? 'draft:new' : `draft:${indexOrNew}`;
}
function saveDraft(indexOrNew) {
    try {
        const { out } = readForm();
        sessionStorage.setItem(draftKeyFor(indexOrNew), JSON.stringify(out));
    } catch {}
}
function loadDraft(indexOrNew) {
    try {
        const raw = sessionStorage.getItem(draftKeyFor(indexOrNew));
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}
function clearDraft(indexOrNew) {
    try { sessionStorage.removeItem(draftKeyFor(indexOrNew)); } catch {}
}

els.cancelBtn.addEventListener('click', () => {
    // Determine which draft to clear
    const idxStr = els.editForm.elements._index.value;
    const indexOrNew = idxStr === '' ? null : Number(idxStr);
    clearDraft(indexOrNew);
    // Reset form on explicit Cancel
    els.editForm.reset();
    closeEditor();
});

els.editForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Always re-verify session just before saving
    await restoreSession();
    if (!isAdmin) {
        els.modalNotice.textContent = 'You are not authorized to save.';
        els.modalNotice.classList.add('error');
        return;
    }

    els.modalNotice.textContent = '';
    els.modalNotice.classList.remove('error');

    const { out, index } = readForm();

    // Validate minimal things
    if (out.year !== '' && (!Number.isFinite(out.year) || String(out.year).length !== 4)) {
        els.modalNotice.textContent = 'Year must be 4 digits (or leave blank).';
        els.modalNotice.classList.add('error');
        return;
    }

    if (SAVE_QUEUE_BUSY) {
        els.modalNotice.textContent = 'A save is already in progress. Please wait.';
        els.modalNotice.classList.add('error');
        return;
    }
    SAVE_QUEUE_BUSY = true;

    try {
        const msg = index === null ? 'Add entry' : `Edit entry at index ${index}`;
        await commitJsonWithRefresh(out, index, msg);
        clearDraft(index === null ? null : index);
        els.editForm.reset();
        closeEditor();
    } catch (err) {
        els.modalNotice.textContent = String(err.message || err);
        els.modalNotice.classList.add('error');
    } finally {
        SAVE_QUEUE_BUSY = false; // ensure reset always
    }
});

async function confirmDelete(index) {
    if (!isAdmin) {
        alert('You are not authorized to delete.');
        return;
    }
    const it = DATA[index];
    const title = it?.song_title_romaji || it?.song_title_original || '(untitled)';
    const anime = it?.anime_en || it?.anime_romaji || '(unknown)';
    if (!confirm(`Delete this entry?\n\nAnime: ${anime}\nSong: ${title}`)) return;

    if (SAVE_QUEUE_BUSY) {
        alert('A save is already in progress. Please wait.');
        return;
    }
    SAVE_QUEUE_BUSY = true;

    try {
        const msg = `Delete entry at index ${index}`;
        await commitJsonWithRefresh(null, index, msg);

        clearDraft(index);
    } catch (err) {
        alert(`Delete failed: ${err.message || err}`);
    } finally {
        SAVE_QUEUE_BUSY = false;
    }
}

document.addEventListener('DOMContentLoaded', () => setToolbarHeight());

// Start
init();
