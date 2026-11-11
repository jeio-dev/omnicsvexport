# Omni Table to CSV

One-click CSV export for Omni result tables, for accounts without download permission or API access.

## Install

1. Unzip somewhere permanent. Chrome loads it from this folder every launch — if you delete or move it, the extension disappears.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. **Load unpacked** → select the unzipped `omni-csv-export` folder.
5. Pin it to the toolbar so the icon is always visible.

## Use

Open an Omni dashboard or workbook, wait for the table to finish loading, then click the toolbar icon. The popup lists every result table it finds with its row and column count and a preview of the column names. Nothing is exported until you click **Export** next to the one you want. Errors and the exported filename show in the popup.

**Shortcut:** `Ctrl+Shift+E` (`Cmd+Shift+E` on Mac) skips the popup and immediately exports the table with the most rows. The badge on the icon confirms the result: a green row count on success, red `ERR` on failure, grey `—` if the tab isn't an Omni page. On failure, right-click the icon → *Inspect service worker* for the reason.

Files land in your normal Chrome download folder, named after the dashboard and the applied date filter:

```
search-csr-sales-report_2026-08-01_to_2026-08-25.csv
```

## How it works, and why not the obvious way

Omni's result grid is **virtualized** — only about 45–50 rows exist in the DOM at any moment, recycled as you scroll. Scrolled to the top the DOM held 49 rows; scrolled to the bottom, 47 different ones. Any exporter built on `document.querySelectorAll('tr')` would produce a CSV that looks complete and silently omits rows. That's the worst possible failure mode for a sales report, so this extension doesn't touch the DOM for data.

Instead it walks the React fiber to the component rendering the tile and reads two props:

- `rawData` — one object per row, keyed by fully-qualified field name, **the entire result set** regardless of scroll position
- `resultFields` — column metadata: display label, field name, and type

Because these are page objects, the code must run in the `MAIN` world. An ordinary isolated-world content script cannot see them, which is why this is an injected `chrome.scripting.executeScript` call rather than a declared content script. The injected function lives in `extract.js`, shared by the popup and the shortcut handler. The popup only ever receives counts and column names; row data stays in the page.

### The decimal trap

Money does not come back as a decimal. `Total Sales` displaying as `32,915.59` arrives as:

```
329155900   // Uint32Array-backed Decimal128, field.type.scale === 4
```

The value is an unscaled 128-bit integer and the decimal position lives in `field.type.scale`. The extension shifts the point **as a string** rather than dividing:

```js
329155900 → "329155900" → "32915.5900" → "32915.59"
```

Dividing by `10 ** scale` would work for these numbers and start rounding once values get large enough to exceed float precision. String shifting is exact at any magnitude.

Scale is read per field, not hardcoded, so a new column with different precision exports correctly without a code change.

Column types observed on this dashboard:

| `typeId` | Meaning | JS type | Handling |
|---|---|---|---|
| 2 | integer | `bigint` | `.toString()` |
| 3 | float | `number` | as-is, full precision |
| 5 | string | `string` | as-is |
| 7 | decimal | `Uint32Array` subclass | descale by `type.scale` |

### Output format

Raw numeric values: `32915.59`, not `32,915.59`. No thousands separators, no rounding — Excel imports these as numbers you can sum. `Avg Item Per Order` exports at full precision (`1.4181818181818182`) rather than the displayed `1.42`; round it in the spreadsheet if you want the display value.

The file is written UTF-8 with a BOM so Excel gets the encoding right on double-click.

## Scope

Works on any Omni page with a result table, not just this dashboard. If a dashboard has several table tiles, the popup lists them all, largest first, and the keyboard shortcut exports the one with the most rows. Non-table tiles (the KPI stat cards) are ignored.

Tables are identified by row count and column names, not by tile title, because the popup has no reliable way to read tile titles from Omni's page. If the table changes between opening the popup and clicking **Export** (the query re-ran, say), the export is refused with a message rather than exporting a different table.

## When it will break

It reads a React internal, not a public API. An Omni frontend release can rename `rawData` / `resultFields` or restructure the component tree, and the extension will start reporting `ERR` — visibly, not silently, which is the important part. The fix is re-pointing the fiber walk at the new prop names.

The genuinely durable fix is getting download permission or an API token from your Omni admin. This is a workaround for a permissions setting, and worth revisiting if that ever changes.

## Permissions

- `scripting` — inject the extractor on click
- `https://*.omniapp.co/*` — restricts that injection to Omni

No `downloads` permission: the CSV is written via a blob URL from the page itself. No network calls, no storage, no data leaves the browser.

## Credits and disclaimer

Created by Jeio — <https://github.com/jeio-dev/omnicsvexport>. Released under the [MIT License](LICENSE).

This is an unofficial tool. It is not affiliated with or endorsed by Omni, and "Omni" is used only to describe the product it works with. It depends on undocumented page internals and may stop working without notice.
