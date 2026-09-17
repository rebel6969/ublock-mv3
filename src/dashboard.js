// Dashboard: list management, user filters, uBO-format backup, diagnostics.
'use strict';

const $ = id => document.getElementById(id);

function send(what, extra = {}) {
    return chrome.runtime.sendMessage({ what, ...extra }).then(reply => {
        if ( reply === undefined ) { throw new Error('no response from service worker'); }
        if ( reply.error !== undefined ) { throw new Error(reply.error); }
        return reply.result;
    });
}

function say(el, text, isError = false) {
    el.textContent = text;
    el.className = isError ? 'err' : '';
}

/* ---------------------------------------------------------------------- */
/* Tabs                                                                    */

for ( const btn of document.querySelectorAll('nav button') ) {
    btn.addEventListener('click', () => {
        for ( const b of document.querySelectorAll('nav button') ) {
            b.classList.toggle('active', b === btn);
        }
        for ( const s of document.querySelectorAll('section') ) {
            s.classList.toggle('active', s.id === `tab-${btn.dataset.tab}`);
        }
        if ( btn.dataset.tab === 'diag' ) { loadDiag(); }
        if ( btn.dataset.tab === 'myfilters' ) { loadFilters(); }
        if ( btn.dataset.tab === 'backup' ) { previewBackup(); }
    });
}

/* ---------------------------------------------------------------------- */
/* Build identity                                                          */

// Show which build is loaded, so a stale reload is obvious rather than silently
// producing numbers that do not match the last rebuild.
async function loadBuildInfo() {
    try {
        const info = await fetch(chrome.runtime.getURL('data/build-info.json'))
            .then(r => r.json());
        $('ver').textContent = `v${info.version}`;
        $('ver').title = `build ${info.build} · ${info.builtAtLocal}`;
        $('buildLede').textContent =
            `Build ${info.build} · ${info.builtAtLocal} · ${info.totalLists} filter lists, ` +
            `${info.totalRules.toLocaleString()} rules — all updating in-browser.`;
    } catch {
        $('ver').textContent = chrome.runtime.getManifest().version;
    }
}

/* ---------------------------------------------------------------------- */
/* Filter lists                                                            */

function fmtDate(ms) {
    if ( typeof ms !== 'number' || ms === 0 ) { return '—'; }
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function meter(value, limit) {
    const pct = Math.min(100, (value / limit) * 100);
    const cls = pct > 100 ? 'over' : pct > 85 ? 'hot' : '';
    return `<div class="bar"><i class="${cls}" style="width:${pct}%"></i></div>`;
}

async function loadLists() {
    const rows = await send('getLists');
    const tbody = $('listRows');
    tbody.replaceChildren();

    let staticCount = 0, dynCount = 0, staticRules = 0, dynRules = 0;
    for ( const r of rows ) {
        if ( r.kind === 'static' ) { staticCount += 1; staticRules += r.rules ?? 0; }
        else { dynCount += 1; dynRules += r.rules ?? 0; }

        const tr = document.createElement('tr');
        if ( r.enabled === false ) { tr.className = 'off'; }

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = r.enabled !== false;
        cb.addEventListener('change', async () => {
            cb.disabled = true;
            try {
                await send('setListEnabled', { token: r.token, enabled: cb.checked });
                say($('msg'), `${cb.checked ? 'Enabled' : 'Disabled'} ${r.title}`);
                await loadLists();
            } catch ( reason ) {
                cb.checked = !cb.checked;
                say($('msg'), reason.message, true);
            } finally {
                cb.disabled = false;
            }
        });
        const tdCb = document.createElement('td');
        tdCb.appendChild(cb);

        const tdName = document.createElement('td');
        tdName.textContent = r.title || r.token;
        if ( r.lastError ) {
            const e = document.createElement('div');
            e.className = 'err';
            e.textContent = r.lastError;
            tdName.appendChild(e);
        }

        const tdKind = document.createElement('td');
        const tag = document.createElement('span');
        tag.className = `tag ${r.mode === 'full' ? 'dyn' : ''}`;
        // Say how the list updates, not which internal bucket it lives in.
        tag.textContent = r.custom ? 'custom' : (r.mode ?? r.kind);
        tag.title = r.mode === 'patched'
            ? 'Baseline ships with the extension; updates apply only the differences'
            : 'Refetched and recompiled in full on every update';
        tdKind.appendChild(tag);

        const tdRules = document.createElement('td');
        tdRules.className = 'num';
        tdRules.textContent = r.rules === null || r.rules === undefined
            ? '—' : r.rules.toLocaleString();

        const tdWhen = document.createElement('td');
        tdWhen.textContent = fmtDate(r.lastUpdated);

        const tdAct = document.createElement('td');
        if ( r.custom ) {
            const rm = document.createElement('button');
            rm.className = 'btn';
            rm.textContent = 'Remove';
            rm.addEventListener('click', async () => {
                rm.disabled = true;
                try {
                    await send('removeList', { url: r.token });
                    say($('msg'), `Removed ${r.token}`);
                    await loadLists();
                } catch ( reason ) {
                    say($('msg'), reason.message, true);
                    rm.disabled = false;
                }
            });
            tdAct.appendChild(rm);
        }

        tr.append(tdCb, tdName, tdKind, tdRules, tdWhen, tdAct);
        tbody.appendChild(tr);
    }

    const status = await send('getStatus', { hostname: '' });
    const b = status.budget;
    const totalLists = staticCount + dynCount;
    $('cards').innerHTML = `
      <div class="card"><b>${totalLists}</b><span>lists, all updating in-browser · ${(staticRules + dynRules).toLocaleString()} rules</span></div>
      <div class="card"><b>${dynCount}<small> / ${staticCount}</small></b><span>refreshed in full / patched by diff</span>${meter(dynCount, totalLists)}</div>
      <div class="card"><b>${b.total.toLocaleString()}</b><span>dynamic rules of 30,000</span>${meter(b.total, 30000)}</div>
      <div class="card"><b>${b.unsafe.toLocaleString()}</b><span>unsafe rules of 5,000</span>${meter(b.unsafe, 5000)}</div>
    `;
}

$('updateAll').addEventListener('click', async () => {
    const btn = $('updateAll');
    btn.disabled = true;
    btn.textContent = 'Updating…';
    say($('msg'), 'Refetching and recompiling dynamic lists…');
    try {
        const r = await send('updateAll');
        const parts = [ `${r.updated.length} lists refreshed` ];
        if ( r.deltas ) {
            const d = r.deltas;
            parts.push(`${d.lists} large lists patched (+${d.added} new, ` +
                `-${d.disabled.reduce((n, x) => n + x.count, 0)} stale)`);
            if ( d.overflow > 0 ) {
                parts.push(`${d.overflow} changes did not fit — rebuild to reclaim space`);
            }
        }
        if ( r.failed.length !== 0 ) { parts.push(`${r.failed.length} failed`); }
        if ( r.installError ) { parts.push(`install error: ${r.installError}`); }
        const bad = r.failed.length !== 0 || Boolean(r.installError) ||
            (r.deltas && r.deltas.overflow > 0);
        say($('msg'), parts.join(' · '), bad);
        await loadLists();
    } catch ( reason ) {
        say($('msg'), reason.message, true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Update all lists';
    }
});

$('addList').addEventListener('click', async () => {
    const url = $('newList').value.trim();
    if ( url === '' ) { return; }
    const btn = $('addList');
    btn.disabled = true;
    try {
        const r = await send('addList', { url });
        say($('msg'), `Added (${(r.bytes / 1024).toFixed(0)} KiB)`);
        $('newList').value = '';
        await loadLists();
    } catch ( reason ) {
        say($('msg'), reason.message, true);
    } finally {
        btn.disabled = false;
    }
});

/* ---------------------------------------------------------------------- */
/* User filters                                                            */

// Scriptlet filters run through chrome.userScripts, which Chrome only allows
// once the user turns on "Allow user scripts" for this extension.
function showUserFiltersStatus(status) {
    const el = $('userScriptsNotice');
    if ( !status ) { el.hidden = true; return; }
    const parts = [];
    if ( status.scriptletsBlocked ) {
        parts.push(`${status.counts.scriptlets} scriptlet filter(s) are not running: open chrome://extensions, ` +
            'click Details on uBlock MV3 and turn on "Allow user scripts", then reopen this tab.');
    }
    if ( status.unsupportedScriptlets?.length ) {
        parts.push(`Unknown scriptlet(s), not run: ${status.unsupportedScriptlets.join(', ')}.`);
    }
    if ( status.refusedUntrusted?.length ) {
        parts.push(`Scriptlet(s) that require trusted filters, not run: ${status.refusedUntrusted.join(', ')}.`);
    }
    if ( status.exceptionLinesNotApplied ) {
        parts.push(`${status.exceptionLinesNotApplied} exception line(s) (#@#) are not applied.`);
    }
    if ( status.error ) { parts.push(`Error: ${status.error}`); }
    el.textContent = parts.join(' ');
    el.hidden = parts.length === 0;
}

async function loadFilters() {
    try {
        const r = await send('getUserFilters');
        $('userFilters').value = r.userFilters;
        showUserFiltersStatus(await send('getUserFiltersStatus'));
    } catch ( reason ) {
        say($('filtersMsg'), reason.message, true);
    }
}

$('saveFilters').addEventListener('click', async () => {
    const btn = $('saveFilters');
    btn.disabled = true;
    try {
        const r = await send('setUserFilters', { userFilters: $('userFilters').value });
        showUserFiltersStatus(r.user);
        say($('filtersMsg'), 'Saved and applied. Reload open pages to see the change.');
    } catch ( reason ) {
        say($('filtersMsg'), reason.message, true);
    } finally {
        btn.disabled = false;
    }
});

/* ---------------------------------------------------------------------- */
/* Backup                                                                  */

async function previewBackup() {
    try {
        const r = await send('exportConfig');
        const d = r.data;
        $('backupPreview').textContent =
            `filename: ${r.filename}\n` +
            `lists:      ${d.selectedFilterLists.length}\n` +
            `whitelist:  ${d.whitelist.length}\n` +
            `userFilters: ${d.userFilters.split('\n').length} lines\n` +
            `switches:   ${(d.hostnameSwitchesString || '').split('\n').filter(Boolean).length}\n`;
    } catch ( reason ) {
        say($('backupMsg'), reason.message, true);
    }
}

$('doExport').addEventListener('click', async () => {
    try {
        const r = await send('exportConfig');
        // uBO pretty-prints its exports; match that so diffs between a uBO
        // backup and one taken here stay readable.
        const blob = new Blob([ JSON.stringify(r.data, null, 2) ], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = r.filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        say($('backupMsg'), `Exported ${r.filename}`);
    } catch ( reason ) {
        say($('backupMsg'), reason.message, true);
    }
});

$('pickImport').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async event => {
    const file = event.target.files[0];
    if ( file === undefined ) { return; }
    say($('backupMsg'), 'Validating…');
    try {
        const text = await file.text();
        const r = await send('importConfig', { text });
        if ( r.ok === false ) {
            say($('backupMsg'), `Rejected: ${r.errors.join('; ')}`, true);
            return;
        }
        say($('backupMsg'), 'Imported and applied.');
        await loadLists();
        await previewBackup();
    } catch ( reason ) {
        say($('backupMsg'), reason.message, true);
    } finally {
        event.target.value = '';
    }
});

/* ---------------------------------------------------------------------- */
/* Diagnostics                                                             */

async function loadDiag() {
    $('diag').textContent = 'loading…';
    try {
        const d = await send('diagnostics');
        $('diag').textContent = JSON.stringify(d, null, 2);
    } catch ( reason ) {
        $('diag').textContent = `error: ${reason.message}`;
    }
}

$('refreshDiag').addEventListener('click', loadDiag);

// Copying the diagnostics by hand out of a <pre> is awkward, and the whole point
// of the tab is to hand the text to someone else.
$('copyDiag').addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText($('diag').textContent);
        say($('diagMsg'), 'Copied. Paste it wherever you need it.');
    } catch ( reason ) {
        say($('diagMsg'), `Could not copy: ${reason.message}`, true);
    }
});

$('saveDiag').addEventListener('click', () => {
    const blob = new Blob([ $('diag').textContent ], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ublock-mv3-diagnostics-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    say($('diagMsg'), 'Saved to your downloads.');
});

$('probeLimits').addEventListener('click', async () => {
    const btn = $('probeLimits');
    btn.disabled = true;
    say($('diagMsg'), 'Measuring Chrome’s disabled-static-rule limit…');
    try {
        const r = await send('probeDisabledStaticLimit', {});
        $('diag').textContent = JSON.stringify(r, null, 2);
        say($('diagMsg'), `Measured limit: ${r.maxDisabledStaticRules}`);
    } catch ( reason ) {
        say($('diagMsg'), reason.message, true);
    } finally {
        btn.disabled = false;
    }
});

loadBuildInfo();
loadLists().catch(reason => say($('msg'), reason.message, true));
