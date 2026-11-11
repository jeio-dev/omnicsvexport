// Omni Table to CSV — popup. Lists the result tables on the active Omni tab with
// their row/column counts and exports only the one the user clicks.
// Copyright (c) 2026 Jeio. MIT License (see LICENSE). Unofficial; not affiliated with or endorsed by Omni.
//
// omniPage() comes from extract.js. Row data never reaches this popup; only
// counts and labels do.

const ORIGIN_MATCH = /^https:\/\/[^/]+\.omniapp\.co\//;

const statusEl = document.getElementById('status');
const listEl = document.getElementById('tables');

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

async function run(tabId, frameId, mode, want) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    func: omniPage,
    args: [mode, want]
  });
  return res && res.result;
}

function renderTable(tabId, t, n) {
  const li = document.createElement('li');

  const info = document.createElement('div');
  info.className = 'info';
  const counts = document.createElement('div');
  counts.className = 'counts';
  counts.textContent = `Table ${n} · ${t.rows.toLocaleString()} rows × ${t.cols} columns`;
  const cols = document.createElement('div');
  cols.className = 'cols';
  cols.textContent = t.labels.join(', ') + (t.cols > t.labels.length ? ', …' : '');
  info.append(counts, cols);

  const btn = document.createElement('button');
  btn.textContent = 'Export';
  btn.disabled = t.rows === 0;
  btn.addEventListener('click', async () => {
    const buttons = listEl.querySelectorAll('button');
    buttons.forEach(b => { b.disabled = true; });
    try {
      const r = await run(tabId, t.frameId, 'export', { rows: t.rows, sig: t.sig });
      if (r && r.ok) {
        setStatus(`Exported ${r.rows.toLocaleString()} rows → ${r.name}`, 'ok');
      } else {
        setStatus((r && r.err) || 'Export failed.', 'error');
      }
    } catch (e) {
      setStatus(String((e && e.message) || e), 'error');
    }
    buttons.forEach((b, i) => { b.disabled = tables[i].rows === 0; });
  });

  li.append(info, btn);
  return li;
}

let tables = [];

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !ORIGIN_MATCH.test(tab.url || '')) {
    setStatus('Open an Omni dashboard or workbook, then click the icon again.', 'error');
    return;
  }

  try {
    // Scan every frame, in case a tile is iframed; remember which frame each table is in.
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: 'MAIN',
      func: omniPage,
      args: ['list', null]
    });
    for (const r of results) {
      if (r.result && r.result.ok) {
        for (const t of r.result.tiles) tables.push({ ...t, frameId: r.frameId });
      }
    }
    // Largest first across frames; stable, so ties keep frame/document order.
    tables.sort((a, b) => b.rows - a.rows);

    if (!tables.length) {
      setStatus('No result table found. Wait for the page to finish loading, then reopen this popup.', 'error');
      return;
    }
    setStatus(tables.length === 1 ? 'Found 1 table.' : `Found ${tables.length} tables. Pick one to export.`);
    tables.forEach((t, i) => listEl.append(renderTable(tab.id, t, i + 1)));
  } catch (e) {
    setStatus(String((e && e.message) || e), 'error');
  }
}

init();
