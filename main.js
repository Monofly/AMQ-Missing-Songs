// ==== CONFIG ====
const CONFIG = {
    OWNER: 'Monofly',
    REPO: 'AMQ-Missing-Songs',
    BRANCH: 'main',
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
    saveBtn: document.getElementById('saveBtn')
};

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

function uniqueYears(items) { return Array.from(new Set(items.map(x => x.year))).filter(Boolean).sort((a, b) => b - a); }
function normalize(str) { return (str || '').toString().toLowerCase(); }
function isEmpty(s) { return !s || !String(s).trim(); }
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

// Consistent “complete” definition used by filters and tags
function isComplete(it) {
    const hasArtist = !isEmpty(it.artist_romaji) || !isEmpty(it.artist_original);
    const hasAnn = !!it.ann_url;
    const hasMal = !!it.mal_url;
    const hasIssues = Array.isArray(it.issues) && it.issues.length > 0;
    const cleanOK = it.clean_available !== false;
    const unidentified = !!it.unidentified;
    return hasArtist && hasAnn && hasMal && cleanOK && !hasIssues && !unidentified;
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
    if (!item.ann_url) tags.push({ cls: 'warn', text: 'Missing ANN' });
    if (!item.mal_url) tags.push({ cls: 'warn', text: 'Missing MAL' });

    if (isEmpty(item.artist_romaji) && isEmpty(item.artist_original)) {
        tags.push({ cls: 'warn', text: 'Missing artist' });
    }

    if (Array.isArray(item.issues) && item.issues.length) tags.push({ cls: 'warn', text: 'Other issues' });
    if (isComplete(item) && !tags.length) tags.push({ cls: 'ok', text: 'Complete' });
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

function applyFilters() {
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
                if (status === 'missing_ann' && !!it.ann_url) return false;
                if (status === 'missing_mal' && !!it.mal_url) return false;
                if (status === 'has_issues' && !(Array.isArray(it.issues) && it.issues.length)) return false;
                if (status === 'complete' && !isComplete(it)) return false;  // NEW
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

    renderRows(filtered);
}

function renderRows(items) {
    const adminClass = isAdmin ? 'admin-on' : '';
    document.body.classList.toggle('admin-on', isAdmin);
    els.count.textContent = `${items.length} result${items.length === 1 ? '' : 's'} • ${DATA.length} total`;
    els.rows.innerHTML = items.map(it => {
        const tags = statusTags(it).map(t => `<span class="pill ${t.cls}">${t.text}</span>`).join(' ');
        const issues = (Array.isArray(it.issues) && it.issues.length) ? `<div class="mono">Issues: ${it.issues.map(escapeHtml).join(', ')}</div>` : '';
        const ep = isEmpty(it.episode) ? '—' : escapeHtml(String(it.episode));
        const time = timeRange(it.time_start, it.time_end);
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
            <div class="mono">${time}</div>
            ${rowActionsAnime}
          </td>
          <td>
            ${displayTitle(it.song_title_romaji, it.song_title_original)}
            <div class="mono">${tags}</div>
            ${rowActionsSong}
          </td>
          <td>${personBlock(it)}${it.notes ? `<div class="mono">Notes: ${escapeHtml(it.notes)}</div>` : ''}${issues}</td>
          <td><span class="pill type">${escapeHtml(it.type || '—')}</span></td>
          <td>${linkOrDash(it.ann_url, 'ANN')} · ${linkOrDash(it.mal_url, 'MAL')}</td>
        </tr>`;
    }).join('');

    if (isAdmin) {
        els.rows.querySelectorAll('[data-edit]').forEach(btn => {
            btn.addEventListener('click', () => openEditor(Number(btn.getAttribute('data-edit'))));
        });
        els.rows.querySelectorAll('[data-delete]').forEach(btn => {
            btn.addEventListener('click', () => confirmDelete(Number(btn.getAttribute('data-delete'))));
        });
        els.rows.querySelectorAll('[data-add-from]').forEach(btn => {
            btn.addEventListener('click', () => {
                const i = Number(btn.getAttribute('data-add-from'));
                openEditor(null, buildPresetFromShow(DATA[i]));
            });
        });
    }
}

function populateYearOptions(items) {
    const years = uniqueYears(items);
    document.getElementById('year').innerHTML =
        `<option value="all">All years</option>` +
        years.map(y => `<option value="${y}">${y}</option>`).join('');
}

async function init() {
    try {
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
        [els.q, els.year, els.season, els.type, els.status].forEach(el => el.addEventListener('input', applyFilters));
        wireAdminBar();
        await restoreSession();
        await ensureCsrf();
        applyFilters();
        // After first render, measure toolbar to set sticky header offset
        setToolbarHeight();
        window.addEventListener('resize', setToolbarHeight);
    } catch (e) {
        els.count.textContent = 'Could not load data/anime_songs.json';
    }
}

// ===== Admin UI and GitHub API =====

function wireAdminBar() {
    els.loginBtn.addEventListener('click', loginWithGitHub);
    els.logoutBtn.addEventListener('click', async () => {
        await fetch(api('/logout'), {
            method: 'POST',
            credentials: 'include'
        });
        currentUser = null;
        isAdmin = false;
        updateAdminVisibility();
        applyFilters();
    });
    els.addBtn.addEventListener('click', () => openEditor(null));
}

function updateAdminVisibility() {
    if (currentUser && isAdmin) {
        els.loginStatus.textContent = `Signed in as ${currentUser.login}`;
        els.loginBtn.style.display = 'none';
        els.logoutBtn.style.display = '';
        els.addBtn.style.display = '';
    } else if (currentUser && !isAdmin) {
        els.loginStatus.textContent = `Signed in as ${currentUser.login} (no write access)`;
        els.loginBtn.style.display = 'none';
        els.logoutBtn.style.display = '';
        els.addBtn.style.display = 'none';
    } else {
        els.loginStatus.textContent = 'Not signed in';
        els.loginBtn.style.display = '';
        els.logoutBtn.style.display = 'none';
        els.addBtn.style.display = 'none';
    }
    // Recalculate sticky offset if the toolbar height changed
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
            CSRF = j.csrf || '';
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
        } else {
            currentUser = null;
            isAdmin = false;
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

function b64EncodeUnicode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

async function commitJson(newArray, commitMessage) {
    els.saveBtn.disabled = true;
    els.saveNotice.style.display = '';
    els.saveNotice.textContent = 'Saving…';

    try {
        await ensureCsrf();
        // Strip UI-only fields
        const payloadArray = newArray.map(({ _index, ...rest }) => rest);

        const res = await fetch(api('/commit'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-CSRF-Token': CSRF
            },
            credentials: 'include',
            body: JSON.stringify({ content: payloadArray, message: commitMessage })
        });

        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(`Save failed: ${res.status} ${txt}`);
        }

        // Update local DATA and UI from our payload (sorted and re-indexed)
        const payload = JSON.stringify(payloadArray, null, 2) + '\n';
        DATA = JSON.parse(payload).map((x, i) => ({ ...x, _index: i }));
        DATA.sort(compareItems);
        DATA = DATA.map((item, i) => ({ ...item, _index: i }));

        els.saveNotice.textContent = 'Saved.';
        setTimeout(() => { els.saveNotice.style.display = 'none'; }, 2000);
        populateYearOptions(DATA);
        applyFilters();

    } catch (e) {
        els.saveNotice.textContent = 'Save failed. ' + e.message;
    } finally {
        els.saveBtn.disabled = false;
    }
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
        unidentified: false,
        clean_available: true,
        ann_url: it.ann_url || '',
        mal_url: it.mal_url || '',
        issues: [],
        notes: ''
    };
}

function openEditor(index, preset) {
    els.modalNotice.textContent = '';
    els.editForm.reset();
    const isNew = (index === null || index === undefined);
    els.modalTitle.textContent = isNew ? 'Add entry' : 'Edit entry';

    if (!isNew) {
        const it = DATA[index];
        fillForm(it);
    } else {
        const baseDefaults = {
            season: 'Winter',
            type: 'OP',
            unidentified: false,
            clean_available: true,
            issues: []
        };
        fillForm({ ...baseDefaults, ...(preset || {}) });
    }

    els.modalBackdrop.style.display = 'flex';
    els.modalBackdrop.setAttribute('aria-hidden', 'false');
}

function closeEditor() {
    els.modalBackdrop.style.display = 'none';
    els.modalBackdrop.setAttribute('aria-hidden', 'true');
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

    f.elements.unidentified.value = String(!!it.unidentified);
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
    const unidentified = f.elements.unidentified.value === 'true';
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
        unidentified,
        clean_available,
        ann_url: f.elements.ann_url.value.trim(),
        mal_url: f.elements.mal_url.value.trim(),
        issues,
        notes: f.elements.notes.value.trim()
    };
    const idxStr = f.elements._index.value;
    const index = idxStr === '' ? null : Number(idxStr);
    return { out, index };
}

els.cancelBtn.addEventListener('click', () => closeEditor());
els.modalBackdrop.addEventListener('click', (e) => {
    if (e.target === els.modalBackdrop) closeEditor();
});

els.editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!isAdmin) {
        els.modalNotice.textContent = 'You are not authorized to save.';
        return;
    }
    const { out, index } = readForm();

    // Validate minimal things
    if (out.year !== '' && (!Number.isFinite(out.year) || String(out.year).length !== 4)) {
        els.modalNotice.textContent = 'Year must be 4 digits (or leave blank).';
        return;
    }

    let newArray = DATA.map(x => ({ ...x }));
    if (index === null) {
        // add
        newArray.push(out);
    } else {
        newArray[index] = { ...newArray[index], ...out };
    }

    const msg = index === null ? 'Add entry' : `Edit entry at index ${index}`;
    await commitJson(newArray, msg);
    closeEditor();
});

async function confirmDelete(index) {
    if (!isAdmin) return alert('You are not authorized to delete.');
    const it = DATA[index];
    const title = it?.song_title_romaji || it?.song_title_original || '(untitled)';
    if (!confirm(`Delete this entry?\n\nAnime: ${it?.anime_en || it?.anime_romaji || '(unknown)'}\nSong: ${title}`)) return;

    const newArray = DATA.filter((_, i) => i !== index);
    await commitJson(newArray, `Delete entry at index ${index}`);
}

// Start
init();
