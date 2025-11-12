// Core configuration (public client id only)
const CONFIG = {
    CLIENT_ID: 'Ov23ctADgidCYeXxj8mv'
};

// Cache DOM references once to avoid repeated lookups
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
    pageTotal: document.getElementById('topPageTotal'),
    pageInfo: document.getElementById('pageInfo'),
    topPager: document.getElementById('topPager'),
    topPrevPageBtn: document.getElementById('topPrevPageBtn'),
    topNextPageBtn: document.getElementById('topNextPageBtn'),
    topPageInput: document.getElementById('topPageInput'),
    topPageTotal: document.getElementById('topPageTotal')
};

// Simple helpers for visibility toggling
function show(el) { if (el) el.hidden = false; }
function hide(el) { if (el) el.hidden = true; }

// Maintain a CSS var with toolbar height so the table header can stick below it
function setToolbarHeight() {
    const toolbar = document.getElementById('toolbar');
    if (!toolbar) return;
    const h = toolbar.offsetHeight || 0;
    document.documentElement.style.setProperty('--toolbar-height', `${h}px`);
}

// API URL helpers (Pages Functions mounted at root)
const api = (p) => p;
const freshApi = (p) => `${p}?fresh=1&ts=${Date.now()}`;

// In-memory state
let DATA = [];          // full dataset loaded from JSON
let DATA_SHA = '';      // git SHA of current JSON (freshness tracking)
let CSRF = '';          // derived CSRF token tied to session
const CONTENT_PATH = 'data/anime_songs.json';

const PAGE_SIZE = 50;   // results per page
let currentPage = 1;    // current page number
let lastFiltered = [];  // last filter result list

let currentUser = null; // GitHub user info
let isAdmin = false;    // write access flag
let SAVE_QUEUE_BUSY = false; // prevent overlapping saves

// --- Filter state persistence ---
function getFilterState() {
    return {
        q: els.q.value,
        year: els.year.value,
        season: els.season.value,
        type: els.type.value,
        status: els.status.value
    }; }
function setFilterState(state) {
    if (!state) return;
    if (typeof state.q === 'string') els.q.value = state.q;
    if (state.year) els.year.value = state.year;
    if (state.season) els.season.value = state.season;
    if (state.type) els.type.value = state.type;
    if (state.status) els.status.value = state.status; }
function saveFilterState() {
    try { localStorage.setItem('filters', JSON.stringify(getFilterState())); } catch {} }
function loadFilterState() {
    try { const raw = localStorage.getItem('filters'); return raw ? JSON.parse(raw) : null; } catch { return null; } }

// Track toolbar height changes (resize, font load, etc.)
function watchToolbarHeight() {
    const toolbar = document.getElementById('toolbar');
    if (!toolbar) return;
    setToolbarHeight();
    const ro = new ResizeObserver(() => setToolbarHeight());
    ro.observe(toolbar);
    if (document.fonts?.ready?.then) {
        document.fonts.ready.then(() => setToolbarHeight()).catch(() => {});
    }
    window.addEventListener('orientationchange', setToolbarHeight);
    window.addEventListener('resize', setToolbarHeight);
}

// --- Small utility functions ---
const uniqueYears = (items) => Array.from(new Set(items.map(x => x.year))).filter(Boolean).sort((a,b)=>b-a);
const normalize = (str) => (str||'').toString().toLowerCase();
const isEmpty = (s) => !s || !String(s).trim();
const computeUnidentified = (obj) => isEmpty(obj.song_title_romaji) && isEmpty(obj.song_title_original);
function escapeHtml(s) { return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#039;'}[c])); }

// Parse first number of episode ranges (e.g. "3-4" -> 3) for sorting
function parseEpisodeStart(ep) {
    if (isEmpty(ep)) return Number.POSITIVE_INFINITY;
    const m = String(ep).match(/^(\d+)/);
    return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

// Convert HH:MM:SS or MM:SS or S to seconds for ordering
function parseTimeToSeconds(t){
    if(!t||!String(t).trim()) return Number.POSITIVE_INFINITY;
    const parts = String(t).split(':').map(Number);
    if(parts.some(n=>Number.isNaN(n))) return Number.POSITIVE_INFINITY;
    if(parts.length===3) return parts[0]*3600+parts[1]*60+parts[2];
    if(parts.length===2) return parts[0]*60+parts[1];
    if(parts.length===1) return parts[0];
    return Number.POSITIVE_INFINITY;
}

// Show duration quick hint if both timestamps valid
function durationSeconds(start,end){
    const s=parseTimeToSeconds(start); const e=parseTimeToSeconds(end);
    if(!Number.isFinite(s)||!Number.isFinite(e)) return '';
    const d=e-s; if(!Number.isFinite(d)||d<0) return ''; return `${d}s`; }

// Determine if item meets "clean/no issues" definition
function isComplete(it){
    const hasArtist=!isEmpty(it.artist_romaji)||!isEmpty(it.artist_original);
    const hasMal=!!it.mal_url;
    const hasIssues=Array.isArray(it.issues)&&it.issues.length>0;
    const cleanOK=it.clean_available!==false;
    const unidentified=!!it.unidentified;
    return hasArtist&&hasMal&&cleanOK&&!hasIssues&&!unidentified;
}

// Stable sort order: anime title -> episode -> start time
function compareItems(a,b){
    const aTitle=(a.anime_en?.trim()||a.anime_romaji?.trim()||'').toLowerCase();
    const bTitle=(b.anime_en?.trim()||b.anime_romaji?.trim()||'').toLowerCase();
    const byTitle=aTitle.localeCompare(bTitle); if(byTitle!==0) return byTitle;
    const aEp=parseEpisodeStart(a.episode); const bEp=parseEpisodeStart(b.episode); if(aEp!==bEp) return aEp-bEp;
    return parseTimeToSeconds(a.time_start)-parseTimeToSeconds(b.time_start);
}

// Tag collection based on item status
function statusTags(item){
    const tags=[];
    if(item.unidentified) tags.push({cls:'bad',text:'Unidentified'});
    if(item.clean_available===false) tags.push({cls:'warn',text:'Missing clean'});
    if(!item.mal_url) tags.push({cls:'warn',text:'Missing MAL'});
    if(isEmpty(item.artist_romaji)&&isEmpty(item.artist_original)) tags.push({cls:'warn',text:'Missing artist'});
    if(Array.isArray(item.issues)&&item.issues.length) tags.push({cls:'warn',text:'Other issues'});
    if(isComplete(item)&&!tags.length) tags.push({cls:'ok',text:'No issues'});
    return tags;
}

// Display helpers
function displayTitle(primary, secondary){
    const a=(primary||'').trim(); const b=(secondary||'').trim();
    if(isEmpty(a)&&isEmpty(b)) return '—';
    if(isEmpty(b)) return escapeHtml(a);
    if(isEmpty(a)) return escapeHtml(b);
    if(normalize(a)===normalize(b)) return escapeHtml(a);
    return `<div class="two-line"><div>${escapeHtml(a)}</div><div class="muted">${escapeHtml(b)}</div></div>`; }
function displayName(label, romaji, original){ return `<div><span class="label">${label}:</span> ${displayTitle(romaji, original)}</div>`; }
function personBlock(item){ return [displayName('Artist',item.artist_romaji,item.artist_original),displayName('Composer',item.composer_romaji,item.composer_original),displayName('Arranger',item.arranger_romaji,item.arranger_original)].join(''); }
function timeRange(start,end){ if(isEmpty(start)&&isEmpty(end)) return '—'; if(isEmpty(end)) return `${escapeHtml(start)}–?`; if(isEmpty(start)) return `?–${escapeHtml(end)}`; return `${escapeHtml(start)}–${escapeHtml(end)}`; }

// Periodic background refresh while admin is active
function startAutoRefresh(){
    if(!isAdmin) return;
    setInterval(async()=>{
        if(isAdmin && !SAVE_QUEUE_BUSY){
            try{ const remoteSha=await fetchRemoteSha(); if(remoteSha && remoteSha!==DATA_SHA){ console.log('Auto-refreshing data (remote changed)'); await reloadLatestContent(); } }
            catch(err){ console.log('Auto-refresh failed:', err); }
        }
    }, 120000);
}

// Filter + search + sort pipeline
function applyFilters({resetPage=false}={}){
    const itemsWithoutIds=DATA.filter(i=>!i.id||!i.id.trim());
    if(itemsWithoutIds.length) console.warn(`Found ${itemsWithoutIds.length} items without IDs`, itemsWithoutIds);

    const q=normalize(els.q.value);
    const year=els.year.value; const season=els.season.value; const type=els.type.value; const status=els.status.value;

    const filtered=DATA.filter(it=>{
        if(year!=='all' && String(it.year)!==year) return false;
        if(season!=='all' && it.season!==season) return false;
        if(type!=='all' && it.type!==type) return false;
        if(status!=='all'){
            if(status==='unidentified' && !it.unidentified) return false;
            if(status==='missing_clean' && it.clean_available!==false) return false;
            if(status==='missing_artist' && !(isEmpty(it.artist_romaji)&&isEmpty(it.artist_original))) return false;
            if(status==='missing_mal' && !!it.mal_url) return false;
            if(status==='has_issues' && !(Array.isArray(it.issues)&&it.issues.length)) return false;
            if(status==='no_issues' && !isComplete(it)) return false;
        }
        if(q){
            const hay=[it.anime_en,it.anime_romaji,it.song_title_romaji,it.song_title_original,it.artist_romaji,it.artist_original,it.composer_romaji,it.composer_original,it.arranger_romaji,it.arranger_original,it.episode,it.notes,...(Array.isArray(it.issues)?it.issues:[])].map(normalize).join(' ');
            if(!hay.includes(q)) return false;
        }
        return true;
    }).sort(compareItems);

    lastFiltered=filtered;
    if(resetPage) currentPage=1;
    renderPage();
    saveFilterState();
}

// Render rows for current page
function renderRows(items,totalFilteredCount=items.length){
    document.body.classList.toggle('admin-on', isAdmin);
    els.count.textContent=`${totalFilteredCount} result${totalFilteredCount===1?'':'s'} • ${DATA.length} total`;

    els.rows.innerHTML=items.map(it=>{
        const tags=statusTags(it).map(t=>`<span class="pill ${t.cls}">${t.text}</span>`).join(' ');
        const issues=(Array.isArray(it.issues)&&it.issues.length)?`<div class="mono">Issues: ${it.issues.map(escapeHtml).join(', ')}</div>`:'';
        const ep=isEmpty(it.episode)?'—':escapeHtml(String(it.episode));
        const time=timeRange(it.time_start,it.time_end);
        const dur=durationSeconds(it.time_start,it.time_end);
        const rowActionsAnime=isAdmin?`<div class="row-actions"><button class="btn" data-add-from-id="${it.id}">Add Entry From This Show</button></div>`:'';
        const rowActionsSong=isAdmin?`<div class="row-actions"><button class="btn secondary" data-edit-id="${it.id}">Edit</button><button class="btn danger" data-delete-id="${it.id}">Delete</button></div>`:'';
        return `<tr>
          <td>${displayTitle(it.anime_en,it.anime_romaji)}<div class="mono">${it.season||'—'} ${it.year||'—'} • Ep ${ep}</div><div class="mono">${time}${dur?`, ${dur}`:''}</div>${rowActionsAnime}</td>
          <td>${displayTitle(it.song_title_romaji,it.song_title_original)}<div class="mono">${tags}</div>${rowActionsSong}</td>
          <td>${personBlock(it)}${it.notes?`<div class="mono preline">Notes: ${escapeHtml(it.notes)}</div>`:''}${issues}</td>
          <td><span class="pill type">${escapeHtml(it.type||'—')}</span></td>
          <td>${linkOrDash(it.ann_url,'ANN')} · ${linkOrDash(it.mal_url,'MAL')}</td>
        </tr>`;
    }).join('');

    // Attach row-level admin buttons
    if(isAdmin){
        els.rows.querySelectorAll('[data-edit-id]').forEach(btn=>{
            btn.addEventListener('click', async()=>{
                await restoreSession(); if(!isAdmin){ alert('You are not authorized to edit.'); return; }
                const id=btn.getAttribute('data-edit-id'); const index=DATA.findIndex(x=>x.id===id); if(index<0){ alert('Item not found.'); return; } openEditor(index);
            });
        });
        els.rows.querySelectorAll('[data-delete-id]').forEach(btn=>{
            btn.addEventListener('click', async()=>{
                const id=btn.getAttribute('data-delete-id'); if(!id){ alert('Item ID not found.'); return; }
                setTimeout(()=>confirmDeleteById(id),10);
            });
        });
        els.rows.querySelectorAll('[data-add-from-id]').forEach(btn=>{
            btn.addEventListener('click', async()=>{
                await restoreSession(); if(!isAdmin){ alert('You are not authorized to add.'); return; }
                const id=btn.getAttribute('data-add-from-id'); const i=DATA.findIndex(x=>x.id===id); if(i<0){ alert('Item not found.'); return; }
                openEditor(null, buildPresetFromShow(DATA[i]));
            });
        });
    }
}

// Pagination helpers
const totalPages = () => Math.max(1, Math.ceil((lastFiltered.length||0)/PAGE_SIZE));
const clampPage = (n) => Math.min(totalPages(), Math.max(1,n||1));

function updatePagerUI(){
    const tp=totalPages(); const hasMany=lastFiltered.length>PAGE_SIZE;
    const setPager=({wrapper,prev,next,input,total,info})=>{
        if(!wrapper) return; wrapper.hidden=!hasMany; if(!hasMany){ if(info) info.textContent=''; return; }
        if(total) total.textContent=String(tp);
        if(input) input.value=String(currentPage);
        if(prev) prev.disabled=currentPage<=1;
        if(next) next.disabled=currentPage>=tp;
        if(info){ const start=(currentPage-1)*PAGE_SIZE+1; const end=Math.min(currentPage*PAGE_SIZE,lastFiltered.length); info.textContent=`Showing ${start}–${end} of ${lastFiltered.length}`; }
    };
    setPager({wrapper:els.pager,prev:els.prevPageBtn,next:els.nextPageBtn,input:els.pageInput,total:els.pageTotal,info:els.pageInfo});
    setPager({wrapper:els.topPager,prev:els.topPrevPageBtn,next:els.topNextPageBtn,input:els.topPageInput,total:els.topPageTotal,info:null});
}

function renderPage(){ currentPage=clampPage(currentPage); const startIdx=(currentPage-1)*PAGE_SIZE; const pageItems=lastFiltered.slice(startIdx,startIdx+PAGE_SIZE); renderRows(pageItems,lastFiltered.length); updatePagerUI(); }
function goToPage(n){ currentPage=clampPage(n); renderPage(); }

// Populate year select after data load
function populateYearOptions(items){
    const years=uniqueYears(items); const select=els.year; const previous=select.value||'all';
    select.innerHTML=`<option value="all">All years</option>`+years.map(y=>`<option value="${y}">${y}</option>`).join('');
    const restore=years.includes(Number(previous))?previous:'all'; select.value=restore;
}

// Initial bootstrap: load data, wire events, restore session
async function init(){
    try{
        watchToolbarHeight();
        await ensureAdminSession();
        updateAdminVisibility();

        const res=await fetch(api('/content'),{method:'GET',headers:{'Accept':'application/json'},credentials:'include',cache:'no-store'});
        if(!res.ok) throw new Error(`Load error ${res.status}`);
        const data=await res.json(); const raw=data.content; DATA_SHA=data.sha;

        // Background SHA mismatch hint triggers silent refresh soon after
        try{ const remoteSha=await fetchRemoteSha(); if(remoteSha && remoteSha!==DATA_SHA){ console.log('Local SHA differs; scheduling fresh reload'); setTimeout(()=>reloadLatestContent().catch(e=>console.warn('Background refresh failed',e)),100); } }catch(e){ console.warn('SHA check failed:', e); }

        // Normalize items + ensure id
        DATA=(raw||[]).map((x,i)=>{ const item={anime_en:'',anime_romaji:'',year:'',season:'Winter',type:'OP',song_title_romaji:'',song_title_original:'',artist_romaji:'',artist_original:'',composer_romaji:'',composer_original:'',arranger_romaji:'',arranger_original:'',episode:'',time_start:'',time_end:'',unidentified:false,clean_available:true,ann_url:'',mal_url:'',issues:[],notes:'',...x,_index:i}; if(!item.id||!item.id.trim()){ const rand=Math.random().toString(16).slice(2,10); item.id=`${Date.now()}-${rand}`; } return item; });
        DATA=DATA.map(it=>{ ensurePersistentId(it); return it; });
        DATA.sort(compareItems);
        DATA=DATA.map((item,i)=>({...item,_index:i,_uid:uidFor(item,i)}));

        populateYearOptions(DATA);
        setFilterState(loadFilterState());

        // Debounced filters on change
        let _filterDebounceTimer=null;
        const applyFiltersDebounced=(opts={resetPage:true})=>{ clearTimeout(_filterDebounceTimer); _filterDebounceTimer=setTimeout(()=>applyFilters(opts),180); };
        [els.q,els.year,els.season,els.type,els.status].forEach(el=>{
            el.addEventListener('input',()=>applyFiltersDebounced({resetPage:true}));
            el.addEventListener('change',()=>applyFiltersDebounced({resetPage:true}));
        });

        wireAdminBar();

        // Bottom pager wiring
        if(els.prevPageBtn && els.nextPageBtn && els.pageInput){
            els.prevPageBtn.addEventListener('click',()=>goToPage(currentPage-1));
            els.nextPageBtn.addEventListener('click',()=>goToPage(currentPage+1));
            const tryInputPage=()=>{ const n=parseInt(els.pageInput.value,10); if(Number.isFinite(n)) goToPage(n); };
            els.pageInput.addEventListener('keydown',e=>{ if(e.key==='Enter') tryInputPage(); });
            els.pageInput.addEventListener('blur',tryInputPage);
        }
        // Top mini pager wiring
        if(els.topPrevPageBtn && els.topNextPageBtn && els.topPageInput){
            els.topPrevPageBtn.addEventListener('click',()=>goToPage(currentPage-1));
            els.topNextPageBtn.addEventListener('click',()=>goToPage(currentPage+1));
            const tryTopInputPage=()=>{ const n=parseInt(els.topPageInput.value,10); if(Number.isFinite(n)) goToPage(n); };
            els.topPageInput.addEventListener('keydown',e=>{ if(e.key==='Enter') tryTopInputPage(); });
            els.topPageInput.addEventListener('blur',tryTopInputPage);
        }

        updateAdminVisibility();
        applyFilters({resetPage:true});
        setToolbarHeight();
    }catch(e){
        // Fallback: attempt fresh cache-bypass load
        console.error('Initial load failed; trying fresh', e);
        try{
            const res2=await fetch(freshApi('/content'),{method:'GET',headers:{'Accept':'application/json'},credentials:'include',cache:'no-store'});
            if(!res2.ok) throw new Error(`Fresh load error ${res2.status}`);
            const data2=await res2.json(); const raw2=data2.content; DATA_SHA=data2.sha;
            DATA=(raw2||[]).map((x,i)=>({anime_en:'',anime_romaji:'',year:'',season:'Winter',type:'OP',song_title_romaji:'',song_title_original:'',artist_romaji:'',artist_original:'',composer_romaji:'',composer_original:'',arranger_romaji:'',arranger_original:'',episode:'',time_start:'',time_end:'',unidentified:false,clean_available:true,ann_url:'',mal_url:'',issues:[],notes:'',...x,_index:i}));
            DATA=DATA.map(it=>{ ensurePersistentId(it); return it; });
            DATA.sort(compareItems);
            DATA=DATA.map((item,i)=>({...item,_index:i,_uid:uidFor(item,i)}));
            populateYearOptions(DATA);
            setFilterState(loadFilterState());
            wireAdminBar();
            updateAdminVisibility();
            applyFilters({resetPage:true});
            setToolbarHeight();
        }catch(freshErr){
            // Hard failure - show retry UI
            console.error('All load attempts failed', freshErr);
            els.count.textContent='Could not load data';
            els.rows.innerHTML=`<tr><td colspan="5"><div class="mono"><span class="notice error">Failed to load data.</span><div class="retry-row"><button class="btn" id="retryBtn">Retry</button><span class="notice">Server may be unavailable.</span></div></div></td></tr>`;
            const retry=document.getElementById('retryBtn'); if(retry) retry.addEventListener('click',()=>location.reload());
            updateAdminVisibility(); updatePagerUI();
        }
    }
    startAutoRefresh();
}

// --- Admin bar wiring ---
function wireAdminBar(){
    els.loginBtn.addEventListener('click', async()=>{ await loginWithGitHub(); });
    els.logoutBtn.addEventListener('click', async()=>{
        await ensureCsrf();
        await fetch(api('/logout'),{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':CSRF,'Accept':'application/json'},body:'{}',credentials:'include'});
        CSRF=''; currentUser=null; isAdmin=false; localStorage.removeItem('wasAdminOrUser'); updateAdminVisibility(); applyFilters(); location.reload();
    });
    els.addBtn.addEventListener('click', async()=>{ await restoreSession(); if(!isAdmin){ alert('You are not authorized to add.'); return; } openEditor(null); });
}

// Reflect session state in toolbar
function updateAdminVisibility(){
    if(currentUser && isAdmin){ els.loginStatus.textContent=`Signed in as ${currentUser.login}`; hide(els.loginBtn); show(els.logoutBtn); show(els.addBtn); }
    else if(currentUser && !isAdmin){ els.loginStatus.textContent=`Signed in as ${currentUser.login} (no write access)`; hide(els.loginBtn); show(els.logoutBtn); hide(els.addBtn); }
    else { els.loginStatus.textContent='Not signed in'; show(els.loginBtn); hide(els.logoutBtn); hide(els.addBtn); }
    setToolbarHeight();
}

// Fetch CSRF token (derived from session cookie and origin)
async function ensureCsrf(){
    if(CSRF) return CSRF;
    try{ const r=await fetch(api('/csrf'),{method:'GET',credentials:'include',headers:{'Accept':'application/json'}}); if(r.ok){ const j=await r.json(); if(j.csrf) CSRF=j.csrf; } }catch{}
    return CSRF;
}

// Safe link helpers
function safeHref(href, allowedHosts=[]){ try{ const u=new URL(href); const okScheme=u.protocol==='https:'; const okHost=allowedHosts.length?allowedHosts.includes(u.host):true; return okScheme && okHost ? u.href : null; }catch{ return null; } }
function linkOrDash(href,label){ const safe=safeHref(href,['animenewsnetwork.com','www.animenewsnetwork.com','myanimelist.net']); return safe?`<a class="link" target="_blank" rel="noopener noreferrer" href="${safe}">${label}</a>`:'—'; }

// Remote SHA (GitHub) for freshness checks
async function fetchRemoteSha(){
    const localSha=(typeof DATA_SHA==='string' && DATA_SHA.length>0)?DATA_SHA:null;
    try{ const res=await fetch(api('/content/meta'),{method:'GET',headers:{'Accept':'application/json'},credentials:'include',cache:'no-store'}); if(!res.ok) return localSha; const meta=await res.json(); const sha=(typeof meta.sha==='string' && meta.sha.length>0)?meta.sha:null; return sha || localSha; }catch{ return localSha; }
}

// Poll remote SHA until changed or timeout
async function waitForRemoteShaChange(previousSha,{expectedSha='',timeoutMs=15000,intervalMs=1200}={}){
    const deadline=Date.now()+timeoutMs; let lastSha=null;
    while(Date.now()<deadline){
        const sha=await fetchRemoteSha();
        if(typeof sha==='string' && sha.length){ lastSha=sha; if(sha!==previousSha || (expectedSha && sha===expectedSha)) return sha; }
        await new Promise(r=>setTimeout(r,intervalMs));
    }
    return lastSha;
}

// Explicit reload ignoring caches / invalidating local memory stores
async function reloadLatestContent(){
    try{ const cacheKey=new Request(new URL('/content','https://dummy').href,{method:'GET'}); await caches.default.delete(cacheKey); }catch{}
    try{ const apiUrl=`https://api.github.com/repos/${env.OWNER||'Monofly'}/${env.REPO||'AMQ-Missing-Songs-Data'}/contents/${encodeURIComponent(env.CONTENT_PATH||'data/anime_songs.json')}?ref=${env.BRANCH||'main'}`; const etagStore=(globalThis.__etagStore??=new Map()); const bodyStore=(globalThis.__bodyStore??=new Map()); etagStore.delete(apiUrl); bodyStore.delete(apiUrl); }catch{}
    try{
        const res=await fetch(freshApi('/content'),{method:'GET',headers:{'Accept':'application/json'},credentials:'include',cache:'no-store'}); if(!res.ok) throw new Error(`Refresh load error ${res.status}`); const data=await res.json(); const raw=data.content; DATA_SHA=data.sha;
        DATA=(raw||[]).map((x,i)=>({anime_en:'',anime_romaji:'',year:'',season:'Winter',type:'OP',song_title_romaji:'',song_title_original:'',artist_romaji:'',artist_original:'',composer_romaji:'',composer_original:'',arranger_romaji:'',arranger_original:'',episode:'',time_start:'',time_end:'',unidentified:false,clean_available:true,ann_url:'',mal_url:'',issues:[],notes:'',...x,_index:i}));
        DATA=DATA.map(it=>{ ensurePersistentId(it); return it; });
        DATA.sort(compareItems);
        DATA=DATA.map((item,i)=>({...item,_index:i,_uid:uidFor(item,i)}));
        populateYearOptions(DATA); applyFilters({resetPage:false}); setToolbarHeight(); return true;
    }catch(err){ console.error('Failed to reload latest content:', err); return false; }
}

// Local vs remote SHA status
async function isFreshAgainstRemoteSha(){
    const remote=await fetchRemoteSha();
    if(!remote && !DATA_SHA) return {ok:false,reason:'no_local_sha'};
    if(!remote && DATA_SHA) return {ok:true,warning:'cannot_verify_freshness'};
    if(!DATA_SHA) return {ok:false,reason:'no_local_sha'};
    if(remote!==DATA_SHA) return {ok:false,reason:'stale'};
    return {ok:true};
}

// Restore session user + permissions from server
async function restoreSession(){
    try{ const res=await fetch(api('/auth/me'),{headers:{'Accept':'application/json'},credentials:'include'}); if(!res.ok) throw new Error('auth/me failed'); const info=await res.json(); if(info.loggedIn){ currentUser=info.user; isAdmin=!!info.canPush; localStorage.setItem('wasAdminOrUser','1'); } else { currentUser=null; isAdmin=false; localStorage.removeItem('wasAdminOrUser'); } updateAdminVisibility(); }
    catch(err){ console.error('Session restore failed:', err); currentUser=null; isAdmin=false; localStorage.removeItem('wasAdminOrUser'); updateAdminVisibility(); }
}
const ensureAdminSession = async()=>{ await restoreSession(); return isAdmin; };

// Guard before mutating content (checks admin + freshness)
async function requireFreshAndAdmin({maxRetries=1}={}){
    await restoreSession(); if(!isAdmin) return {ok:false,reason:'not_admin'};
    let retries=0; while(retries<=maxRetries){
        try{ const remoteSha=await fetchRemoteSha(); if(!remoteSha && DATA_SHA) return {ok:true,warning:'cannot_verify_freshness'}; if(remoteSha && DATA_SHA && remoteSha===DATA_SHA) return {ok:true}; if(retries<maxRetries){ const refreshed=await reloadLatestContent(); retries++; if(refreshed) continue; } return {ok:false,reason:'stale_json',message:'Your data is outdated. Please refresh.'}; }
        catch(error){ if(retries<maxRetries){ retries++; await new Promise(r=>setTimeout(r,1000)); continue; } return {ok:false,reason:'check_failed',message:'Could not verify freshness.'}; }
    }
    return {ok:false,reason:'max_retries_exceeded'};
}

// GitHub device flow login (poll loop)
async function loginWithGitHub(){
    const start=await fetch(api('/oauth/device-code'),{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},credentials:'include',body:JSON.stringify({client_id:CONFIG.CLIENT_ID,scope:'public_repo'})}).then(r=>r.json()).catch(()=>null);
    if(!start||!start.device_code){ alert('GitHub login failed to start.'); return; }
    const {device_code,user_code,verification_uri,expires_in,interval}=start;
    const msg=`1) Visit: ${verification_uri}\n2) Enter code: ${user_code}\n\nLeave this tab open.`;
    if(!confirm(msg+'\n\nClick OK after entering the code.')) return;
    const began=Date.now(); const pollMs=Math.max((interval||5),3)*1000;
    while(Date.now()-began < (expires_in*1000)){
        await new Promise(r=>setTimeout(r,pollMs));
        const resp=await fetch(api('/oauth/poll'),{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},credentials:'include',body:JSON.stringify({client_id:CONFIG.CLIENT_ID,device_code})}).then(r=>r.json()).catch(()=>({}));
        if(resp.status==='pending') continue;
        if(resp.status==='slow_down'){ await new Promise(r=>setTimeout(r,5000)); continue; }
        if(resp.error){ alert('GitHub login error: '+resp.error); return; }
        if(resp.ok){ currentUser=resp.user; if(resp.csrf) CSRF=resp.csrf; await restoreSession(); if(!isAdmin) alert('Signed in (read-only).'); else await reloadLatestContent(); applyFilters(); return; }
    }
    alert('GitHub login timed out.');
}
const verifyAdmin = async()=>{ await restoreSession(); return isAdmin; };

// Build a quasi-unique key for items (used in fallback identification)
function entryKey(it){
    return [normalize(it.anime_en||it.anime_romaji||''),String(it.year||''),String(it.season||''),String(it.type||''),normalize(it.song_title_romaji||it.song_title_original||''),normalize(it.artist_romaji||it.artist_original||''),String(it.episode||''),String(it.time_start||'')].join('|'); }
function uidFor(it,fallbackIndex){ return entryKey(it)+'|'+String(fallbackIndex??''); }

// Guarantee a persistent ID; generate if absent
function ensurePersistentId(it){
    if(typeof it.id==='string' && it.id.trim()) return it.id;
    const baseString=[it.anime_en||it.anime_romaji||'',it.song_title_romaji||it.song_title_original||'',it.episode||'',it.time_start||''].join('|');
    let hash=0; for(let i=0;i<baseString.length;i++){ hash=((hash<<5)-hash)+baseString.charCodeAt(i); hash &= hash; }
    const rand=Math.random().toString(16).slice(2,6); const id=`${Date.now()}-${Math.abs(hash).toString(16)}-${rand}`; it.id=id; return id;
}

// Attempt auto-fix for missing IDs if admin
async function fixMissingIdsIfAdmin(){
    const itemsWithoutIds=DATA.filter(item=>!item.id||!item.id.trim()); if(!itemsWithoutIds.length) return;
    console.log(`Found ${itemsWithoutIds.length} items without IDs`);
    await ensureAdminSession(); if(!isAdmin){ console.log('Not admin - skipping ID fix'); return; }
    let needsCommit=false; DATA.forEach(item=>{ const oldId=item.id; ensurePersistentId(item); if(!oldId||!oldId.trim()) needsCommit=true; });
    if(!needsCommit) return;
    try{
        const allItems=DATA.map(({_index,_uid,...rest})=>rest); await ensureCsrf();
        const res=await fetch(api('/commit'),{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','X-CSRF-Token':CSRF},credentials:'include',body:JSON.stringify({bulkUpdate:allItems,message:`Auto-fix: Add IDs to ${itemsWithoutIds.length} items`,baseSha:DATA_SHA})});
        if(!res.ok){ console.error('Failed to save IDs automatically:', res.status, await res.text().catch(()=>'')); return; }
        const result=await res.json().catch(()=>({})); if(result.sha) DATA_SHA=result.sha; console.log(`Added IDs to ${itemsWithoutIds.length} items`); await reloadLatestContent();
    }catch(err){ console.error('Failed to fix missing IDs automatically:', err); }
}

const indexById = (id)=> id ? DATA.findIndex(x=>x && x.id===id) : -1;

// Commit single change or deletion; refetch data after
async function commitJsonWithRefresh(changeObj,target,commitMessage,originalItemForKey){
    if(els.saveBtn) els.saveBtn.disabled=true; show(els.saveNotice); els.saveNotice.textContent=changeObj===null?'Deleting…':'Saving…'; els.saveNotice.classList.add('saving');
    try{
        await ensureCsrf();
        const change=changeObj===null?null:(()=>{ const {_index,_uid,...rest}=changeObj; return rest; })();
        const res=await fetch(api('/commit'),{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','X-CSRF-Token':CSRF},credentials:'include',body:JSON.stringify({change,target,message:commitMessage,baseSha:DATA_SHA})});
        if(res.status===409) throw new Error('Save conflict. Data changed upstream.');
        if(res.status===404){ await reloadLatestContent(); if(changeObj===null && originalItemForKey){ const stillExists=DATA.some(item=> item.anime_en===originalItemForKey.anime_en && item.anime_romaji===originalItemForKey.anime_romaji && item.song_title_romaji===originalItemForKey.song_title_romaji && item.episode===originalItemForKey.episode); if(!stillExists) throw new Error('Item already deleted.'); } throw new Error('Item not found after refresh.'); }
        if(!res.ok) throw new Error(`Save failed: ${res.status} ${await res.text().catch(()=> '')}`);
        const commitData=await res.json(); if(commitData.sha) DATA_SHA=commitData.sha;
        els.saveNotice.classList.remove('saving'); els.saveNotice.textContent=changeObj===null?'Deleted.':'Saved.';
        setTimeout(()=>{ hide(els.saveNotice); setToolbarHeight(); },1200);
        let newSha=null; try{ newSha=await waitForRemoteShaChange(DATA_SHA,{expectedSha:commitData.sha||'',timeoutMs:15000,intervalMs:1200}); }catch{}
        if(typeof newSha==='string' && newSha && newSha!==DATA_SHA) DATA_SHA=newSha;
        try{ await reloadLatestContent(); }catch(e){ console.warn('Reload after commit failed:', e); }
        return {success:true};
    }catch(err){ els.saveNotice.classList.remove('saving'); els.saveNotice.textContent='Error: '+(err.message||err); els.saveNotice.classList.add('error'); throw err; }
    finally{ if(els.saveBtn) els.saveBtn.disabled=false; }
}

// Build preset when adding similar song from same anime
function buildPresetFromShow(it){ return {anime_en:it.anime_en||'',anime_romaji:it.anime_romaji||'',year:it.year||'',season:it.season||'Winter',type:'OP',song_title_romaji:'',song_title_original:'',artist_romaji:'',artist_original:'',composer_romaji:'',composer_original:'',arranger_romaji:'',arranger_original:'',episode:'',time_start:'',time_end:'',clean_available:false,ann_url:it.ann_url||'',mal_url:it.mal_url||'',issues:[],notes:''}; }

// Open editor (new or edit existing); loads draft if present
async function openEditor(index,preset){
    await restoreSession(); const freshCheck=await isFreshAgainstRemoteSha(); if(!freshCheck.ok){ if(confirm('Data is outdated. Refresh now?')) location.href=location.origin+'/?r='+Date.now(); return; }
    if(!isAdmin){ alert('Not signed in with write access.'); return; }
    if(index!==null && (!DATA[index]||!DATA[index].id||!DATA[index].id.trim())){ alert('This item has no ID. Refresh to fix.'); return; }
    els.modalNotice.textContent=''; const isNew=(index===null||index===undefined); const indexOrNew=isNew?null:index; els.modalTitle.textContent=isNew?'Add entry':'Edit entry';
    const draft=loadDraft(indexOrNew);
    if(draft) fillForm({...draft,_index:isNew?'':index});
    else if(!isNew) fillForm(DATA[index]);
    else fillForm({season:'Winter',type:'OP',clean_available:false,issues:[],...(preset||{})});
    els.modalBackdrop.hidden=false; els.modalBackdrop.setAttribute('aria-hidden','false');
    setTimeout(()=>{ const first=els.editForm.querySelector('input,select,textarea'); if(first) first.focus(); },100);
    const f=els.editForm; const onChange=()=>saveDraft(indexOrNew); const clearError=()=>{ els.modalNotice.textContent=''; els.modalNotice.classList.remove('error'); };
    Array.from(f.elements).forEach(el=>{ if(el.name) el.addEventListener('input',clearError,{passive:true}); });
    Array.from(f.elements).forEach(el=>{ if(el.name){ el.addEventListener('input',onChange,{passive:true}); el.addEventListener('change',onChange,{passive:true}); } });
}

// Close editor & clear draft
function closeEditor(){ els.modalBackdrop.hidden=true; els.modalBackdrop.setAttribute('aria-hidden','true'); const idxStr=els.editForm.elements._index.value; const indexOrNew=idxStr===''?null:Number(idxStr); clearDraft(indexOrNew); els.editForm.reset(); (isAdmin&&els.addBtn?els.addBtn:els.q).focus(); }

// Populate form fields from item/draft
function fillForm(it){ const f=els.editForm; f.elements.anime_en.value=it.anime_en||''; f.elements.anime_romaji.value=it.anime_romaji||''; f.elements.year.value=it.year||''; f.elements.season.value=it.season||'Winter'; f.elements.type.value=it.type||'OP'; f.elements.episode.value=(it.episode??''); f.elements.time_start.value=it.time_start||''; f.elements.time_end.value=it.time_end||''; f.elements.song_title_romaji.value=it.song_title_romaji||''; f.elements.song_title_original.value=it.song_title_original||''; f.elements.artist_romaji.value=it.artist_romaji||''; f.elements.artist_original.value=it.artist_original||''; f.elements.composer_romaji.value=it.composer_romaji||''; f.elements.composer_original.value=it.composer_original||''; f.elements.arranger_romaji.value=it.arranger_romaji||''; f.elements.arranger_original.value=it.arranger_original||''; f.elements.clean_available.value=String(!(it.clean_available===false)); f.elements.ann_url.value=it.ann_url||''; f.elements.mal_url.value=it.mal_url||''; f.elements.issues.value=Array.isArray(it.issues)?it.issues.join(', '):''; f.elements.notes.value=it.notes||''; f.elements._index.value=(it._index??''); }

// Read & validate form
function readForm(){ const f=els.editForm; const yearRaw=f.elements.year.value.trim(); const year=yearRaw?Number(yearRaw):''; const clean_available=f.elements.clean_available.value==='true'; const issues=f.elements.issues.value.split(',').map(s=>s.trim()).filter(Boolean); const out={anime_en:f.elements.anime_en.value.trim(),anime_romaji:f.elements.anime_romaji.value.trim(),year:Number.isFinite(year)&&String(year).length===4?year:'',season:f.elements.season.value,type:f.elements.type.value,song_title_romaji:f.elements.song_title_romaji.value.trim(),song_title_original:f.elements.song_title_original.value.trim(),artist_romaji:f.elements.artist_romaji.value.trim(),artist_original:f.elements.artist_original.value.trim(),composer_romaji:f.elements.composer_romaji.value.trim(),composer_original:f.elements.composer_original.value.trim(),arranger_romaji:f.elements.arranger_romaji.value.trim(),arranger_original:f.elements.arranger_original.value.trim(),episode:f.elements.episode.value.trim(),time_start:f.elements.time_start.value.trim(),time_end:f.elements.time_end.value.trim(),unidentified:false,clean_available,ann_url:f.elements.ann_url.value.trim(),mal_url:f.elements.mal_url.value.trim(),issues,notes:f.elements.notes.value.trim()}; out.unidentified=computeUnidentified(out); const idxStr=f.elements._index.value; const index=idxStr===''?null:Number(idxStr); return {out,index}; }

// Draft helpers (session-scoped)
const draftKeyFor = (indexOrNew)=> indexOrNew===null?'draft:new':`draft:${indexOrNew}`;
function saveDraft(indexOrNew){ try{ const {out}=readForm(); sessionStorage.setItem(draftKeyFor(indexOrNew),JSON.stringify(out)); }catch{} }
function loadDraft(indexOrNew){ try{ const raw=sessionStorage.getItem(draftKeyFor(indexOrNew)); return raw?JSON.parse(raw):null; }catch{ return null; } }
function clearDraft(indexOrNew){ try{ sessionStorage.removeItem(draftKeyFor(indexOrNew)); }catch{} }

// Cancel button
els.cancelBtn.addEventListener('click',()=>{ const idxStr=els.editForm.elements._index.value; const indexOrNew=idxStr===''?null:Number(idxStr); clearDraft(indexOrNew); els.editForm.reset(); closeEditor(); });

// Form submit (add/edit)
els.editForm.addEventListener('submit', async(e)=>{
    e.preventDefault();
    const guard=await requireFreshAndAdmin(); if(!guard.ok){ alert(guard.reason==='not_admin'?'Not signed in with write access.':(guard.message||'Could not refresh latest data.')); return; }
    els.modalNotice.textContent=''; els.modalNotice.classList.remove('error');
    const {out,index}=readForm(); const originalForKey=index===null?null:{...DATA[index]};
    if(index!==null){ const currentItem=DATA[index]; if(!currentItem||!currentItem.id){ els.modalNotice.textContent='Item not found locally.'; els.modalNotice.classList.add('error'); return; } }
    if(out.year!=='' && (!Number.isFinite(out.year)||String(out.year).length!==4)){ els.modalNotice.textContent='Year must be 4 digits.'; els.modalNotice.classList.add('error'); return; }
    if(SAVE_QUEUE_BUSY){ els.modalNotice.textContent='Save already in progress.'; els.modalNotice.classList.add('error'); return; }
    SAVE_QUEUE_BUSY=true;
    try{
        let target=null; let originalId=null;
        if(index!==null){ originalId=DATA[index].id; target={id:originalId}; }
        const msg=index===null?'Add entry':`Edit entry id ${originalId||'unknown'}`;
        if(index===null){ const newItem={...out}; ensurePersistentId(newItem); DATA.push(newItem); }
        else { DATA[index]={...DATA[index],...out,id:originalId}; }
        DATA.sort(compareItems); DATA=DATA.map((item,i)=>({...item,_index:i})); applyFilters({resetPage:false});
        const finalCheck=await isFreshAgainstRemoteSha(); if(!finalCheck.ok && finalCheck.reason==='stale') throw new Error('Data changed upstream. Refresh and retry.');
        await commitJsonWithRefresh(out,target,msg,originalForKey);
        els.modalNotice.textContent='Changes saved.'; els.modalNotice.classList.remove('error'); els.modalNotice.classList.add('ok');
        clearDraft(index===null?null:index); els.editForm.reset();
        setTimeout(async()=>{ closeEditor(); await reloadLatestContent(); },1500);
    }catch(err){ if(index===null) DATA.pop(); else if(originalForKey) DATA[index]={...originalForKey}; DATA.sort(compareItems); DATA=DATA.map((item,i)=>({...item,_index:i})); applyFilters({resetPage:false}); els.modalNotice.textContent=String(err.message||err); els.modalNotice.classList.add('error'); }
    finally{ SAVE_QUEUE_BUSY=false; }
});

// Delete entry flow
async function confirmDeleteById(id){
    const guard=await requireFreshAndAdmin(); if(!guard.ok){ if(guard.reason==='not_admin') alert('Not signed in with write access.'); else if(guard.reason==='stale_json'){ if(confirm('Data outdated. Refresh now?')) await reloadLatestContent(); } else alert(guard.message||'Permission check failed.'); return; }
    const itemIndex=DATA.findIndex(item=>item && item.id===id); if(itemIndex<0){ alert('Item not found (may already be deleted).'); return; }
    const deletedItem={...DATA[itemIndex]}; const title=deletedItem.song_title_romaji||deletedItem.song_title_original||'(untitled)'; const anime=deletedItem.anime_en||deletedItem.anime_romaji||'(unknown)'; if(!confirm(`Delete this entry?\n\nAnime: ${anime}\nSong: ${title}`)) return;
    if(SAVE_QUEUE_BUSY){ alert('Save already in progress.'); return; } SAVE_QUEUE_BUSY=true;
    document.querySelectorAll('[data-delete-id]').forEach(b=>b.disabled=true);
    try{
        const finalCheck=await isFreshAgainstRemoteSha(); if(!finalCheck.ok && finalCheck.reason==='stale') throw new Error('Data changed upstream. Refresh and retry.');
        const msg=`Delete entry id ${deletedItem.id}`; const target={id:deletedItem.id};
        DATA=DATA.filter(item=>item.id!==deletedItem.id); DATA.sort(compareItems); DATA=DATA.map((item,i)=>({...item,_index:i})); applyFilters({resetPage:false});
        await commitJsonWithRefresh(null,target,msg,deletedItem); await reloadLatestContent();
    }catch(err){ DATA.splice(itemIndex,0,deletedItem); DATA.sort(compareItems); DATA=DATA.map((item,i)=>({...item,_index:i})); applyFilters({resetPage:false}); alert(`Delete failed: ${err.message||err}`); }
    finally{ document.querySelectorAll('[data-delete-id]').forEach(b=>b.disabled=false); SAVE_QUEUE_BUSY=false; }
}

// Keep header offset correct after fonts load
document.addEventListener('DOMContentLoaded', ()=> setToolbarHeight());

// Entry point
init();
