#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

const LINE_Y_TOL = 2.2;
const MAX_ASSIGN_DIST = 22;

const DEFAULT_X = {
  no: 26,
  ticker: 31,
  emiten: 43,
  sekuritas: 110,
  owner: 183,
  rekening: 256,
  address1: 329,
  address2: 402,
  country: 475,
  domicile: 494,
  status: 545,
  shares_prev: 563.2,
  shares_total_prev: 596.9,
  pct_prev: 648.2,
  shares_curr: 660.6,
  shares_total_curr: 694.2,
  pct_curr: 745.5,
  change: 766.1,
};

const COMPACT_X = {
  no: 55.8,
  ticker: 59.3,
  emiten: 67.1,
  sekuritas: 114.4,
  owner: 161.6,
  rekening: 208.9,
  address1: 256.2,
  address2: 303.5,
  country: 352.3,
  domicile: 363.3,
  status: 396.1,
  shares_prev: 407.3,
  shares_total_prev: 429,
  pct_prev: 462.6,
  shares_curr: 470.3,
  shares_total_curr: 492,
  pct_curr: 525.6,
  change: 538.3,
};

function cleanText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\u2212/g, "-")
    .replace(/−/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function norm(value) {
  return cleanText(value).toUpperCase();
}

function firstLine(value) {
  if (!value) {
    return "";
  }
  const parts = String(value).split(/[\r\n]+/);
  return cleanText(parts.length ? parts[0] : value);
}

function looksLikeTicker(value) {
  return /^[A-Z]{4}$/.test(cleanText(value).toUpperCase());
}

function normalizeNumber(value) {
  let s = cleanText(value);
  if (!s || s === "-") {
    return "";
  }
  s = s.replace(/\(/g, "-").replace(/\)/g, "");
  s = s.replace(/%/g, "");
  s = s.replace(/\s+/g, "");
  s = s.replace(/[\u2212−]/g, "-");
  return s;
}

function looksLikeNumericInt(raw) {
  let r = normalizeNumber(raw);
  if (!r) {
    return false;
  }
  if (r.startsWith("+") || r.startsWith("-")) {
    r = r.slice(1);
  }
  return /^\d[\d.,]*$/.test(r);
}

function looksLikeNumericPct(raw) {
  let r = normalizeNumber(raw);
  if (!r) {
    return false;
  }
  if (r.startsWith("+") || r.startsWith("-")) {
    r = r.slice(1);
  }
  return /^\d+(?:[.,]\d+)?$/.test(r);
}

function parseIntStrict(raw) {
  let s = normalizeNumber(raw);
  if (!s) {
    return null;
  }

  let sign = 1;
  if (s.startsWith("+")) {
    s = s.slice(1);
  } else if (s.startsWith("-")) {
    sign = -1;
    s = s.slice(1);
  }

  s = s.replace(/[.,]/g, "");
  if (!/^\d+$/.test(s)) {
    return null;
  }

  const parsed = Number(s);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return sign * parsed;
}

function parsePct(raw) {
  let s = normalizeNumber(raw);
  if (!s) {
    return null;
  }

  let sign = 1;
  if (s.startsWith("+")) {
    s = s.slice(1);
  } else if (s.startsWith("-")) {
    sign = -1;
    s = s.slice(1);
  }

  if (s.includes(",") && s.includes(".")) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(/,/g, ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (s.includes(",") && !s.includes(".")) {
    s = s.replace(/,/g, ".");
  }

  const parsed = Number(s);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return sign * parsed;
}

function sanePctOwned(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return value >= 0 && value <= 100 ? value : null;
}

function sanePctChange(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return Math.abs(value) <= 100 ? value : null;
}

function buildLinesFromTextContent(textContent) {
  const rawItems = [];

  for (const item of textContent.items || []) {
    const text = cleanText(item.str);
    if (!text) {
      continue;
    }

    const transform = item.transform || [0, 0, 0, 0, 0, 0];
    rawItems.push({
      x: Number(transform[4]) || 0,
      y: Number(transform[5]) || 0,
      width: Number(item.width) || 0,
      text,
    });
  }

  rawItems.sort((a, b) => {
    if (Math.abs(b.y - a.y) > 0.05) {
      return b.y - a.y;
    }
    return a.x - b.x;
  });

  const lines = [];
  for (const item of rawItems) {
    let bestIndex = -1;
    let bestDelta = Infinity;

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const delta = Math.abs(lines[i].y - item.y);
      if (delta <= LINE_Y_TOL && delta < bestDelta) {
        bestDelta = delta;
        bestIndex = i;
      }
      if (lines[i].y - item.y > LINE_Y_TOL * 3) {
        break;
      }
    }

    if (bestIndex === -1) {
      lines.push({ y: item.y, items: [item] });
    } else {
      const line = lines[bestIndex];
      line.items.push(item);
      line.y = (line.y * (line.items.length - 1) + item.y) / line.items.length;
    }
  }

  lines.sort((a, b) => b.y - a.y);
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.text = cleanText(line.items.map((item) => item.text).join(" "));
  }

  return lines;
}

function looksLikeHeaderLine(text) {
  const u = norm(text);
  return u.includes("KODE EFEK") && u.includes("PEMEGANG") && u.includes("SAHAM");
}

function looksLikeHeaderContinuation(text) {
  const u = norm(text);
  if (!u) {
    return false;
  }
  return (
    u.includes("JUMLAH SAHAM") ||
    u.includes("PERSENTASE") ||
    u.includes("PERUBAHAN") ||
    u.includes("KEPEMILIKAN PER") ||
    u.includes("NAMA PEMEGANG") ||
    u.includes("KEBANGSAAN") ||
    u.includes("DOMISILI")
  );
}

function parseHeaderAnchors(lines, start) {
  // Keep data-cell anchors fixed for KSEI/OJK 5% tables. Header labels are centered
  // and can drift significantly from data x positions, which causes wrong mapping.
  const headerItems = [];
  const end = Math.min(lines.length, start + 3);
  for (let i = start; i < end; i += 1) {
    headerItems.push(...(lines[i].items || []));
  }

  const hasCompactNumericHeader = headerItems.some((item) => {
    const text = norm(item.text);
    return (
      (text.includes("KEPEMILIKAN PER") && item.x < 520) ||
      (text.includes("PERUBAHAN") && item.x < 650)
    );
  });

  if (hasCompactNumericHeader) {
    return { ...COMPACT_X };
  }

  return { ...DEFAULT_X };
}

function buildAssignColumns(anchors) {
  const cols = [
    ["no", anchors.no],
    ["ticker", anchors.ticker],
    ["emiten", anchors.emiten],
    ["sekuritas", anchors.sekuritas],
    ["owner", anchors.owner],
    ["rekening", anchors.rekening],
    ["address1", anchors.address1],
    ["address2", anchors.address2],
    ["country", anchors.country],
    ["domicile", anchors.domicile],
    ["status", anchors.status],
    ["shares_prev", anchors.shares_prev],
    ["shares_total_prev", anchors.shares_total_prev],
    ["pct_prev", anchors.pct_prev],
    ["shares_curr", anchors.shares_curr],
    ["shares_total_curr", anchors.shares_total_curr],
    ["pct_curr", anchors.pct_curr],
    ["change", anchors.change],
  ];

  if (anchors.pct_change !== undefined) {
    cols.push(["pct_change", anchors.pct_change]);
  }

  return cols
    .filter(([, x]) => Number.isFinite(x))
    .sort((a, b) => a[1] - b[1])
    .map(([field, x]) => ({ field, x }));
}

function nearestColumn(x, columns) {
  let best = null;
  let bestDist = Infinity;
  for (const col of columns) {
    const d = Math.abs(x - col.x);
    if (d < bestDist) {
      bestDist = d;
      best = col;
    }
  }
  if (!best || bestDist > MAX_ASSIGN_DIST) {
    return null;
  }
  return best.field;
}

function assignItemsToCells(items, columns) {
  const cells = {};
  for (const item of items || []) {
    const field = nearestColumn(item.x, columns);
    if (!field) {
      continue;
    }
    if (!cells[field]) {
      cells[field] = cleanText(item.text);
    } else {
      cells[field] = cleanText(`${cells[field]} ${item.text}`);
    }
  }
  return cells;
}

function reconcilePctAndChange(cells) {
  const pctRaw = cleanText(cells.pct_curr || "");
  const changeRaw = cleanText(cells.change || "");
  if (!pctRaw || looksLikeNumericInt(changeRaw)) {
    return;
  }

  const parts = pctRaw.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return;
  }

  const pctCandidate = parts[0];
  const changeCandidate = parts[parts.length - 1];
  if (!looksLikeNumericPct(pctCandidate) || !looksLikeNumericInt(changeCandidate)) {
    return;
  }

  cells.pct_curr = pctCandidate;
  cells.change = changeCandidate;
}

function hasUsefulNumeric(cells) {
  const candidates = [
    cells.shares_curr,
    cells.shares_prev,
    cells.shares_total_curr,
    cells.shares_total_prev,
    cells.change,
    cells.pct_curr,
    cells.pct_prev,
    cells.pct_change,
  ];
  return candidates.some((v) => looksLikeNumericInt(v) || looksLikeNumericPct(v) || cleanText(v) === "-");
}

function looksLikeOwnerFallback(value) {
  const s = cleanText(value);
  if (!s) {
    return false;
  }
  if (!/[A-Za-z]/.test(s)) {
    return false;
  }
  if (s.length > 80) {
    return false;
  }
  const words = s.split(" ").filter(Boolean);
  if (words.length > 10) {
    return false;
  }
  // Reject obvious account labels after we've extracted a possible owner candidate.
  if (/\b(S\/A|A[\/-]C|TRUST|TR\b|BRANCH|OMNIBUS|CLIENT|CUSTODY|REGISTRAR|ODD\s+LOTS)\b/i.test(s)) {
    return false;
  }
  return true;
}

function ownerCandidateFromRekening(value) {
  let s = cleanText(value);
  if (!s) {
    return "";
  }

  // "QQ" usually means the beneficial owner is the segment after it.
  const qqParts = s.split(/\bQQ\b/i).map((part) => cleanText(part)).filter(Boolean);
  if (qqParts.length > 1) {
    s = qqParts[qqParts.length - 1];
  }

  // Account markers usually start account qualifiers, not owner names.
  s = cleanText(s.split(/\bA[\/-]C\b/i)[0]);

  // Trim common account suffix descriptors.
  s = cleanText(s.split(/\b(ODD\s+LOTS|CLIENT|FIRM\s+AC|REGISTRAR)\b/i)[0]);

  return s;
}

function canonicalOwnerName(value) {
  let k = cleanText(value).toUpperCase();
  k = k.replace(/[^A-Z0-9 ]+/g, " ");
  k = k.replace(/\b(DRS|DR|IR|PROF|H|HJ|H\.)\b/g, " ");
  k = k.replace(/\s+/g, " ").trim();
  return k;
}

function looksAccountLikeOwner(value) {
  return /\b(S\/A|A[\/-]C|QQ|TRUST|TR\b|OMNIBUS|CLIENT|CUSTODY|FIRM\s+AC)\b/i.test(cleanText(value));
}

function ownerEntityTokens(value) {
  const legal = new Set(["PT", "TBK", "LTD", "LIMITED", "PTE", "PLC", "CO", "CORP", "INC"]);
  const noise = new Set(["QQ", "CLIENT", "CUSTODY", "FIRM", "AC"]);

  const normalized = canonicalOwnerName(value)
    .replace(/\bINTL\b/g, "INTERNATIONAL")
    .replace(/\bHOLDINGS\b/g, "HOLDING")
    .replace(/\bAND\b/g, " ");

  return normalized
    .split(" ")
    .filter(Boolean)
    .filter((token) => !legal.has(token) && !noise.has(token));
}

function sameOwnerEntity(a, b) {
  const ca = canonicalOwnerName(a);
  const cb = canonicalOwnerName(b);
  if (!ca || !cb) {
    return false;
  }
  if (ca === cb) {
    return true;
  }

  const ta = ownerEntityTokens(a);
  const tb = ownerEntityTokens(b);
  if (!ta.length || !tb.length) {
    return false;
  }

  const setB = new Set(tb);
  const overlap = ta.filter((token) => setB.has(token)).length;
  const ratio = overlap / Math.min(ta.length, tb.length);
  return ratio >= 0.75;
}

function storeGroupHint(state, ticker, ownerRaw, pctOwned, pctChange, sharesChange) {
  if (!ticker || !ownerRaw) {
    return;
  }

  const [, ownerKey] = normalizeOwnerKey(ownerRaw);
  const key = `${ticker}\u0000${ownerKey}`;
  const prev = state.groupHints.get(key) || {};

  state.groupHints.set(key, {
    pct_owned: pctOwned !== null && pctOwned !== undefined ? pctOwned : prev.pct_owned ?? null,
    pct_change: pctChange !== null && pctChange !== undefined ? pctChange : prev.pct_change ?? null,
    shares_change: sharesChange !== null && sharesChange !== undefined ? sharesChange : prev.shares_change ?? null,
  });
}

function rowsFromLines(lines, state) {
  const out = [];

  const headerIndexes = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (looksLikeHeaderLine(lines[i].text)) {
      headerIndexes.push(i);
    }
  }

  for (let h = 0; h < headerIndexes.length; h += 1) {
    const start = headerIndexes[h];
    const end = h + 1 < headerIndexes.length ? headerIndexes[h + 1] : lines.length;

    const anchors = parseHeaderAnchors(lines, start);
    const columns = buildAssignColumns(anchors);

    for (let i = start + 1; i < end; i += 1) {
      const line = lines[i];
      if (!line || !line.text) {
        continue;
      }

      const upper = norm(line.text);
      if (looksLikeHeaderContinuation(upper) || upper.includes("KEPEMILIKAN EFEK DIATAS 5%")) {
        continue;
      }

      const cells = assignItemsToCells(line.items, columns);
      reconcilePctAndChange(cells);
      if (!hasUsefulNumeric(cells)) {
        continue;
      }

      const rawTicker = norm(cells.ticker || "");
      let ticker = "";
      if (looksLikeTicker(rawTicker)) {
        ticker = rawTicker;
        state.lastTicker = ticker;
      } else if (!rawTicker && state.lastTicker) {
        ticker = state.lastTicker;
      } else {
        continue;
      }

      let ownerFromCell = cleanText(cells.owner || "");
      const cachedOwner = state.lastOwnerByTicker.get(ticker) || "";
      const rekeningCandidate = cleanText(cells.rekening || "");
      const ownerFromRekeningCandidate = ownerCandidateFromRekening(rekeningCandidate);
      const ownerFromRekening = looksLikeOwnerFallback(ownerFromRekeningCandidate)
        ? ownerFromRekeningCandidate
        : "";

      if (ownerFromCell && cachedOwner && looksAccountLikeOwner(ownerFromCell)) {
        // Account-style strings inside owner column usually mean shifted rekening text.
        ownerFromCell = "";
      }

      let ownerRaw = ownerFromCell;
      if (!ownerRaw) {
        if (ownerFromRekening) {
          if (!cachedOwner || !sameOwnerEntity(ownerFromRekening, cachedOwner)) {
            // If rekening value clearly belongs to a different owner, switch owner context.
            ownerRaw = ownerFromRekening;
          } else {
            ownerRaw = cachedOwner;
          }
        } else {
          ownerRaw = cachedOwner;
        }
      }

      if (ownerRaw) {
        state.lastOwnerByTicker.set(ticker, ownerRaw);
      }

      let countryRaw = cleanText(cells.country || "");
      if (countryRaw) {
        state.lastCountryByTicker.set(ticker, countryRaw);
      } else {
        countryRaw = state.lastCountryByTicker.get(ticker) || "";
      }

      const sekuritasRaw = cleanText(cells.sekuritas || "");

      const sharesOwnedRaw = cleanText(cells.shares_curr || cells.shares_total_curr || "");
      let sharesOwned = looksLikeNumericInt(sharesOwnedRaw) ? parseIntStrict(sharesOwnedRaw) : null;

      const sharesPrevRaw = cleanText(cells.shares_prev || cells.shares_total_prev || "");
      let sharesPrev = looksLikeNumericInt(sharesPrevRaw) ? parseIntStrict(sharesPrevRaw) : null;

      if (sharesOwned === null && sharesPrev !== null && (sharesOwnedRaw === "" || sharesOwnedRaw === "-")) {
        sharesOwned = 0;
      }
      if (sharesPrev === null && sharesOwned !== null && sharesPrevRaw === "-") {
        sharesPrev = 0;
      }

      let sharesChange = null;
      const changeRaw = cleanText(cells.change || "");
      if (looksLikeNumericInt(changeRaw)) {
        sharesChange = parseIntStrict(changeRaw);
      }
      if (sharesChange === null && sharesPrev !== null && sharesOwned !== null) {
        sharesChange = sharesOwned - sharesPrev;
      }

      let pctOwned = null;
      const pctOwnedRaw = cleanText(cells.pct_curr || "");
      if (looksLikeNumericPct(pctOwnedRaw)) {
        pctOwned = sanePctOwned(parsePct(pctOwnedRaw));
      }

      let pctPrev = null;
      const pctPrevRaw = cleanText(cells.pct_prev || "");
      if (looksLikeNumericPct(pctPrevRaw)) {
        pctPrev = sanePctOwned(parsePct(pctPrevRaw));
      }
      if (pctPrev === null && pctOwned !== null && pctPrevRaw === "-") {
        pctPrev = 0;
      }

      let pctChange = null;
      const pctChangeRaw = cleanText(cells.pct_change || "");
      if (looksLikeNumericPct(pctChangeRaw)) {
        pctChange = sanePctChange(parsePct(pctChangeRaw));
      }
      if (pctChange === null && pctOwned !== null && pctPrev !== null) {
        pctChange = sanePctChange(pctOwned - pctPrev);
      }

      const looksLikeSummaryOnlyRow =
        !sekuritasRaw &&
        cleanText(cells.owner || "") &&
        (looksLikeNumericPct(cells.pct_curr || "") || looksLikeNumericPct(cells.pct_prev || "")) &&
        (looksLikeNumericInt(cells.shares_total_curr || "") ||
          looksLikeNumericInt(cells.shares_curr || "") ||
          looksLikeNumericInt(cells.shares_total_prev || "") ||
          looksLikeNumericInt(cells.shares_prev || ""));

      if (looksLikeSummaryOnlyRow) {
        storeGroupHint(state, ticker, ownerRaw, pctOwned, pctChange, sharesChange);
        continue;
      }

      const hasSignal = [sharesOwned, sharesPrev, sharesChange, pctOwned, pctPrev, pctChange].some(
        (v) => v !== null && v !== undefined,
      );
      if (!hasSignal || sharesOwned === null) {
        continue;
      }

      storeGroupHint(state, ticker, ownerRaw, pctOwned, pctChange, sharesChange);

      out.push({
        ticker,
        owner_raw: ownerRaw,
        sekuritas_raw: sekuritasRaw,
        country_raw: countryRaw,
        shares_owned: sharesOwned,
        shares_change: sharesChange,
        pct_owned: pctOwned,
        pct_change: pctChange,
      });
    }
  }

  return out;
}

async function extractHoldings(pdfPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
  });

  const rows = [];
  const state = {
    lastTicker: "",
    lastOwnerByTicker: new Map(),
    lastCountryByTicker: new Map(),
    groupHints: new Map(),
  };

  const pdf = await loadingTask.promise;
  try {
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent({ disableCombineTextItems: false });
      const lines = buildLinesFromTextContent(textContent);
      rows.push(...rowsFromLines(lines, state));
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  return { rows, groupHints: state.groupHints };
}

function normalizeOwnerKey(ownerRaw) {
  const display = firstLine(ownerRaw) || cleanText(ownerRaw);

  const tokens = ownerEntityTokens(display);
  let key = tokens.length ? tokens.join(" ") : canonicalOwnerName(display);
  key = key.replace(/\s+/g, " ").trim();

  return [display, key];
}

function ownerDisplayScore(name) {
  const n = norm(name);
  if (!n) {
    return -1;
  }

  let score = 0;
  if (/^PT\b/.test(n)) {
    score += 4;
  }
  if (/\bTBK\b/.test(n)) {
    score += 2;
  }
  if (!looksAccountLikeOwner(n)) {
    score += 2;
  }
  if (!/\bQQ\b/.test(n)) {
    score += 1;
  }
  return score;
}

function preferOwnerDisplay(existingName, candidateName) {
  const existing = cleanText(existingName);
  const candidate = cleanText(candidateName);

  if (!candidate) {
    return existing;
  }
  if (!existing) {
    return candidate;
  }

  const existingScore = ownerDisplayScore(existing);
  const candidateScore = ownerDisplayScore(candidate);
  if (candidateScore > existingScore) {
    return candidate;
  }
  if (candidateScore === existingScore && candidate.length > existing.length) {
    return candidate;
  }
  return existing;
}

function hasChange(entry) {
  if (entry.shares_change !== null && entry.shares_change !== 0) {
    return true;
  }
  if (entry.pct_change !== null && Math.abs(entry.pct_change) > 1e-12) {
    return true;
  }
  return false;
}

function formatPctChange(value, sharesChangeHint = null) {
  if (value === null || value === undefined) {
    return "-";
  }
  if (Math.abs(value) <= 1e-12) {
    if (sharesChangeHint !== null && sharesChangeHint !== 0) {
      return sharesChangeHint > 0 ? "+<0.01%" : "-<0.01%";
    }
    return "No Change";
  }
  if (Math.abs(value) < 0.005) {
    return value > 0 ? "+<0.01%" : "-<0.01%";
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function pickGroupPct(values) {
  const present = values.filter((v) => v !== null && v !== undefined);
  if (!present.length) {
    return null;
  }

  const buckets = new Map();
  for (const value of present) {
    const rounded = Math.round(value * 10000) / 10000;
    if (!buckets.has(rounded)) {
      buckets.set(rounded, []);
    }
    buckets.get(rounded).push(value);
  }

  let best = [];
  for (const vals of buckets.values()) {
    if (vals.length > best.length) {
      best = vals;
    }
  }

  return best.length ? best.reduce((a, b) => a + b, 0) / best.length : null;
}

function printGrouped(rows, onlyChanges = true, groupHints = new Map()) {
  const grouped = new Map();
  const ownerDisplay = new Map();
  const ownerCountry = new Map();

  for (const row of rows) {
    const [display, ownerKey] = normalizeOwnerKey(row.owner_raw);
    const mapKey = `${row.ticker}\u0000${ownerKey}`;

    if (!grouped.has(row.ticker)) {
      grouped.set(row.ticker, new Map());
    }
    if (!grouped.get(row.ticker).has(ownerKey)) {
      grouped.get(row.ticker).set(ownerKey, []);
    }
    grouped.get(row.ticker).get(ownerKey).push(row);

    ownerDisplay.set(mapKey, preferOwnerDisplay(ownerDisplay.get(mapKey) || "", display));
    const country = row.country_raw ? firstLine(row.country_raw) : "";
    if (country && !ownerCountry.has(mapKey)) {
      ownerCountry.set(mapKey, country);
    }
  }

  const changedGroups = new Set();
  if (onlyChanges) {
    const tickersForCheck = [...grouped.keys()];
    for (const ticker of tickersForCheck) {
      for (const ownerKey of grouped.get(ticker).keys()) {
        const key = `${ticker}\u0000${ownerKey}`;
        const entries = grouped.get(ticker).get(ownerKey) || [];
        const hint = groupHints.get(key) || null;
        const hintChanged =
          Boolean(hint) &&
          ((hint.shares_change !== null && hint.shares_change !== undefined && hint.shares_change !== 0) ||
            (hint.pct_change !== null && hint.pct_change !== undefined && Math.abs(hint.pct_change) > 1e-12));

        if (entries.some((row) => hasChange(row)) || hintChanged) {
          changedGroups.add(key);
        }
      }
    }
  }

  const tickers = [...grouped.keys()].sort();
  for (const ticker of tickers) {
    const owners = [...grouped.get(ticker).keys()].sort();
    for (const ownerKey of owners) {
      const key = `${ticker}\u0000${ownerKey}`;
      if (onlyChanges && !changedGroups.has(key)) {
        continue;
      }

      const entries = grouped.get(ticker).get(ownerKey);
      const display = ownerDisplay.get(key) || "";
      const country = ownerCountry.get(key) || "";

      process.stdout.write(`Ticker:              ${ticker}\n`);
      process.stdout.write(`Owner:               ${display}\n`);
      if (country) {
        process.stdout.write(`Country:             ${country}\n`);
      }
      process.stdout.write("\n");

      const hint = groupHints.get(key) || null;
      const groupPctOwned = pickGroupPct([
        ...entries.map((e) => e.pct_owned),
        hint ? hint.pct_owned : null,
      ]);
      const groupPctChange = pickGroupPct([
        ...entries.map((e) => e.pct_change),
        hint ? hint.pct_change : null,
      ]);

      for (const e of entries) {
        const sek = firstLine(e.sekuritas_raw) || cleanText(e.sekuritas_raw);
        process.stdout.write(`  Sekuritas:         ${sek || "-"}\n`);
        process.stdout.write(`  Shares Owned:      ${e.shares_owned.toLocaleString("en-US")}\n`);

        if (e.shares_change === null || e.shares_change === undefined) {
          process.stdout.write("  Shares Change:     -\n");
        } else {
          const sign = e.shares_change >= 0 ? "+" : "-";
          process.stdout.write(`  Shares Change:     ${sign}${Math.abs(e.shares_change).toLocaleString("en-US")}\n`);
        }

        if (entries.length > 1) {
          process.stdout.write("  Percentage Owned:  -\n");
          process.stdout.write("  Percentage Change: -\n");
        } else {
          const pctOwnedValue =
            e.pct_owned !== null && e.pct_owned !== undefined
              ? e.pct_owned
              : hint && hint.pct_owned !== undefined
                ? hint.pct_owned
                : null;
          const pctChangeValue =
            e.pct_change !== null && e.pct_change !== undefined
              ? e.pct_change
              : hint && hint.pct_change !== undefined
                ? hint.pct_change
                : null;

          if (pctOwnedValue === null || pctOwnedValue === undefined) {
            process.stdout.write("  Percentage Owned:  -\n");
          } else {
            process.stdout.write(`  Percentage Owned:  ${pctOwnedValue.toFixed(2)}%\n`);
          }

          if (pctChangeValue === null || pctChangeValue === undefined) {
            process.stdout.write("  Percentage Change: -\n");
          } else {
            process.stdout.write(`  Percentage Change: ${formatPctChange(pctChangeValue, e.shares_change)}\n`);
          }
        }

        process.stdout.write("\n");
      }

      if (entries.length > 1) {
        const totalShares = entries.reduce((sum, e) => sum + e.shares_owned, 0);
        const changes = entries.map((e) => e.shares_change).filter((v) => v !== null && v !== undefined);
        const totalChange = changes.length ? changes.reduce((a, b) => a + b, 0) : null;

        process.stdout.write("  TOTAL (all sekuritas for this owner)\n");
        process.stdout.write(`  Shares Owned:      ${totalShares.toLocaleString("en-US")}\n`);
        if (totalChange === null) {
          process.stdout.write("  Shares Change:     -\n");
        } else {
          const sign = totalChange >= 0 ? "+" : "-";
          process.stdout.write(`  Shares Change:     ${sign}${Math.abs(totalChange).toLocaleString("en-US")}\n`);
        }

        if (groupPctOwned === null || groupPctOwned === undefined) {
          process.stdout.write("  Percentage Owned:  -\n");
        } else {
          process.stdout.write(`  Percentage Owned:  ${groupPctOwned.toFixed(2)}%\n`);
        }
        process.stdout.write(`  Percentage Change: ${formatPctChange(groupPctChange, totalChange)}\n`);
        process.stdout.write("\n");
      }

      process.stdout.write(`${"-".repeat(60)}\n`);
    }
  }
}

function pickPdfPath(arg) {
  if (arg) {
    const full = path.resolve(process.cwd(), arg);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      const files = fs
        .readdirSync(full)
        .filter((name) => name.toLowerCase().endsWith(".pdf"))
        .map((name) => path.join(full, name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      return files.length ? files[0] : null;
    }
    return full;
  }

  const defaultDir = path.join(__dirname, "documents");
  if (fs.existsSync(defaultDir) && fs.statSync(defaultDir).isDirectory()) {
    const files = fs
      .readdirSync(defaultDir)
      .filter((name) => name.toLowerCase().endsWith(".pdf"))
      .map((name) => path.join(defaultDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files.length ? files[0] : null;
  }

  return null;
}

async function main() {
  const pdfPath = pickPdfPath(process.argv[2]);
  if (!pdfPath || !fs.existsSync(pdfPath) || !fs.statSync(pdfPath).isFile()) {
    console.error("No PDF found. Provide a file path or place a PDF in ./documents.");
    process.exit(2);
  }

  const { rows, groupHints } = await extractHoldings(pdfPath);
  if (!rows.length) {
    console.error(
      "No rows extracted. If this PDF is scanned or table lines are not detected, convert it to a text-based PDF.",
    );
    process.exit(2);
  }

  printGrouped(rows, true, groupHints);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(2);
});
