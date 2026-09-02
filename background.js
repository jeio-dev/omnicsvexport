// Omni Table to CSV — MV3 service worker.
//
// Strategy: Omni's result grid is virtualized, so the DOM only ever holds a
// window of ~45-50 rows and scraping <tr> elements silently drops data. The
// full result set lives on the React component that renders the tile, as
// `rawData` (one object per row, keyed by fully-qualified field name) plus
// `resultFields` (column metadata). We reach it by walking the React fiber,
// which means the injected code must run in the MAIN world — an isolated-world
// content script cannot see page objects.

const ORIGIN_MATCH = /^https:\/\/[^/]+\.omniapp\.co\//;

/* ------------------------------------------------------------------ *
 * Injected into the page (MAIN world). Must be entirely self-contained.
 * ------------------------------------------------------------------ */
function pageExtract() {
  const FIBER_KEY = /^(__reactFiber\$|__reactInternalInstance\$)/;

  function fiberOf(el) {
    const k = Object.keys(el).find(n => FIBER_KEY.test(n));
    return k ? el[k] : null;
  }

  // Walk up from likely table roots until we hit props carrying the result set.
  function findTiles() {
    const found = [];
    const seen = new Set();
    const roots = document.querySelectorAll(
      '.data-table, [class*="data-table"], [class*="spreadsheet"], table'
    );
    for (const el of roots) {
      let f = fiberOf(el);
      let depth = 0;
      while (f && depth < 40) {
        const p = f.memoizedProps;
        if (p && Array.isArray(p.rawData) && Array.isArray(p.resultFields) && p.resultFields.length) {
          if (!seen.has(p.rawData)) {
            seen.add(p.rawData);
            found.push(p);
          }
          break;
        }
        f = f.return;
        depth++;
      }
    }
    return found;
  }

  // Omni returns DECIMAL columns as unscaled 128-bit integers with the decimal
  // position in field.type.scale — Total Sales of 32,915.59 arrives as
  // 329155900 with scale 4. Shift the point as a string so 128-bit values and
  // cents both survive; going through a JS float would round the large ones.
  function descale(raw, scale) {
    let s = String(raw);
    let neg = false;
    if (s.charAt(0) === '-') { neg = true; s = s.slice(1); }
    if (!scale) return (neg ? '-' : '') + s;
    s = s.padStart(scale + 1, '0');
    let out = s.slice(0, -scale) + '.' + s.slice(-scale);
    out = out.replace(/0+$/, '').replace(/\.$/, '');
    if (out === '') out = '0';
    return (neg ? '-' : '') + out;
  }

  function cellValue(v, field) {
    if (v === null || v === undefined) return '';
    const scale = field.type && field.type.scale;
    if (scale) return descale(v, scale);
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    if (v instanceof Date) return v.toISOString();
    return String(v);
  }

  function escapeCsv(s) {
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(tile) {
    const fields = tile.resultFields;
    const lines = [fields.map(f => escapeCsv(f.label || f.name)).join(',')];
    for (const row of tile.rawData) {
      lines.push(fields.map(f => escapeCsv(cellValue(row[f.name], f))).join(','));
    }
    return lines.join('\r\n');
  }

  function slug(s) {
    return String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  // A recurring export that doesn't record which filter produced it is a trap,
  // so fold any date range in the filter bar into the filename.
  function filterTag() {
    try {
      const nodes = document.querySelectorAll('.dashboard-filter-wrapper, .dashboard-filter');
      for (const n of nodes) {
        const m = (n.innerText || '').match(/(\d{4}-\d{2}-\d{2})\D+(\d{4}-\d{2}-\d{2})/);
        if (m) return m[1] + '_to_' + m[2];
      }
      for (const n of nodes) {
        const t = (n.innerText || '').split('\n')[1];
        if (t && !/is any value/i.test(t)) return slug(t);
      }
    } catch (e) { /* filename decoration only, never fatal */ }
    return new Date().toISOString().slice(0, 10);
  }

  function download(text, filename) {
    const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 10000);
  }

  try {
    const tiles = findTiles();
    if (!tiles.length) return { ok: false, err: 'No Omni result table found on this page.' };

    // Multiple table tiles on one dashboard: take the largest result set.
    tiles.sort((a, b) => b.rawData.length - a.rawData.length);
    const tile = tiles[0];
    if (!tile.rawData.length) return { ok: false, err: 'The table is empty — has the query finished running?' };

    const title = document.title.replace(/\s*\(.*$/, '').replace(/\s*[—-]\s*Omni.*$/i, '').trim();
    const name = (slug(title) || 'omni-table') + '_' + filterTag() + '.csv';

    download(toCsv(tile), name);
    return { ok: true, rows: tile.rawData.length, cols: tile.resultFields.length, tiles: tiles.length, name };
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e) };
  }
}

/* ------------------------------------------------------------------ */

function flash(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 2500);
}

async function runExport(tab) {
  if (!tab || !tab.id) return;
  if (!ORIGIN_MATCH.test(tab.url || '')) {
    flash(tab.id, '—', '#888888');
    return;
  }

  try {
    // Main frame first; fall back to all frames in case a tile is iframed.
    let results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: pageExtract
    });
    let hit = results.map(r => r.result).find(r => r && r.ok);

    if (!hit) {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: 'MAIN',
        func: pageExtract
      });
      hit = results.map(r => r.result).find(r => r && r.ok);
    }

    if (hit) {
      console.log(`[omni-csv] ${hit.name}: ${hit.rows} rows x ${hit.cols} cols`);
      flash(tab.id, String(hit.rows), '#1a7f37');
    } else {
      const err = results.map(r => r.result).find(r => r && r.err);
      console.warn('[omni-csv]', (err && err.err) || 'extraction failed');
      flash(tab.id, 'ERR', '#b42318');
    }
  } catch (e) {
    console.error('[omni-csv]', e);
    flash(tab.id, 'ERR', '#b42318');
  }
}

chrome.action.onClicked.addListener(runExport);

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'export-csv') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  runExport(tab);
});
