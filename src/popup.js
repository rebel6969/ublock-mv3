// Popup: per-site enable/disable, live counters, and the update-all trigger.
'use strict';

const $ = id => document.getElementById(id);

function send(what, extra = {}) {
    return chrome.runtime.sendMessage({ what, ...extra }).then(reply => {
        if ( reply === undefined ) { throw new Error('no response from service worker'); }
        if ( reply.error !== undefined ) { throw new Error(reply.error); }
        return reply.result;
    });
}

function setStatus(text, isError = false) {
    const el = $('status');
    el.textContent = text;
    el.className = isError ? 'err' : '';
}

let hostname = '';
let whitelisted = false;

function paintToggle() {
    const btn = $('toggle');
    btn.disabled = hostname === '';
    btn.textContent = whitelisted ? 'Enable on this site' : 'Disable on this site';
    const state = $('state');
    state.textContent = whitelisted ? 'not blocking here' : 'blocking';
    state.className = `badge ${whitelisted ? 'off' : 'on'}`;
}

async function currentHostname() {
    const [ tab ] = await chrome.tabs.query({ active: true, currentWindow: true });
    if ( tab === undefined || typeof tab.url !== 'string' ) { return ''; }
    try {
        const u = new URL(tab.url);
        // Only http(s) pages can be filtered at all.
        if ( u.protocol !== 'http:' && u.protocol !== 'https:' ) { return ''; }
        return u.hostname;
    } catch {
        return '';
    }
}

async function refresh() {
    hostname = await currentHostname();
    $('host').textContent = hostname === '' ? 'Not a filterable page' : hostname;
    if ( hostname === '' ) {
        $('state').textContent = 'n/a';
        $('toggle').disabled = true;
        return;
    }
    const status = await send('getStatus', { hostname });
    whitelisted = status.whitelisted;
    $('rulesets').textContent = status.enabledRulesets;
    $('dynamic').textContent = status.dynamicRules.toLocaleString();
    $('wl').textContent = status.whitelistSize.toLocaleString();
    paintToggle();
}

$('toggle').addEventListener('click', async () => {
    $('toggle').disabled = true;
    try {
        // "Disable on this site" means stop blocking -> add to whitelist.
        const r = await send('setSiteEnabled', { hostname, enabled: whitelisted });
        whitelisted = r.whitelisted;
        paintToggle();
        setStatus('Reload the page to apply.');
        await refresh();
    } catch ( reason ) {
        setStatus(reason.message, true);
    } finally {
        $('toggle').disabled = false;
    }
});

$('update').addEventListener('click', async () => {
    const btn = $('update');
    btn.disabled = true;
    btn.textContent = 'Updating…';
    setStatus('Refetching and recompiling lists…');
    try {
        const r = await send('updateAll');
        const parts = [ `${r.updated.length} updated` ];
        if ( r.failed.length !== 0 ) { parts.push(`${r.failed.length} failed`); }
        if ( r.staticSkipped ) { parts.push(`${r.staticSkipped} static skipped`); }
        setStatus(parts.join(', '), r.failed.length !== 0);
        await refresh();
    } catch ( reason ) {
        setStatus(reason.message, true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Update all lists';
    }
});

$('dash').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
});

refresh().catch(reason => setStatus(reason.message, true));
