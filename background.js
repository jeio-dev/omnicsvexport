// Omni Table to CSV — MV3 service worker.
// Copyright (c) 2026 Jeio. MIT License (see LICENSE). Unofficial; not affiliated with or endorsed by Omni.
//
// Strategy: Omni's result grid is virtualized, so the DOM only ever holds a
// window of ~45-50 rows and scraping <tr> elements silently drops data. The
// full result set lives on the React component that renders the tile, as
// `rawData` (one object per row, keyed by fully-qualified field name) plus
// `resultFields` (column metadata). We reach it by walking the React fiber,
// which means the injected code must run in the MAIN world — an isolated-world
// content script cannot see page objects. That code lives in extract.js, shared
// with the popup.
//
// Clicking the toolbar icon opens popup.html, where the user picks a table.
// This worker only handles the keyboard shortcut, which exports the largest
// table straight away.

importScripts('extract.js');

const ORIGIN_MATCH = /^https:\/\/[^/]+\.omniapp\.co\//;

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
      func: omniPage,
      args: ['export', null]
    });
    let hit = results.map(r => r.result).find(r => r && r.ok);

    if (!hit) {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: 'MAIN',
        func: omniPage,
        args: ['export', null]
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

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'export-csv') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  runExport(tab);
});
