#!/usr/bin/env python3
"""
fivepercent.py

Parse Indonesian "5% ownership" PDFs (KSEI / OJK style tables) and print holdings.

Design goals:
- Be robust to multi-row headers, column order changes, and noisy extraction.
- Prefer header-based mapping, but allow safe inference when headers are incomplete.
- Never treat text/address columns as numeric change columns.
- Support two-snapshot PDFs (prev vs current) and compute changes when needed.

Usage:
  python fivepercent.py path/to/file.pdf              # DEFAULT: only changes
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

try:
    import pdfplumber
except ImportError:
    print("Error: pdfplumber is not installed. Try: pip install pdfplumber", file=sys.stderr)
    sys.exit(1)

# ---------------------------
# Helpers: normalization/parsing
# ---------------------------

HEADER_SCAN_ROWS = 15
HEADER_MERGE_DEPTH = 3
SAMPLE_ROWS = 200

MONTHS = {
    "JAN": 1,
    "FEB": 2,
    "MAR": 3,
    "APR": 4,
    "MEI": 5,
    "MAY": 5,
    "JUN": 6,
    "JUL": 7,
    "AGU": 8,
    "AUG": 8,
    "SEP": 9,
    "OKT": 10,
    "OCT": 10,
    "NOV": 11,
    "DES": 12,
    "DEC": 12,
}


def clean_text(s: Any) -> str:
    if s is None:
        return ""
    s = str(s)
    s = s.replace("\u00a0", " ")
    s = s.replace("\u2212", "-")
    s = s.replace("−", "-")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def norm(s: Any) -> str:
    return clean_text(s).upper()


def first_line(s: str) -> str:
    if not s:
        return ""
    parts = re.split(r"[\r\n]+", s.strip())
    return clean_text(parts[0]) if parts else clean_text(s)


def looks_like_ticker(s: str) -> bool:
    s = clean_text(s).upper()
    return bool(re.fullmatch(r"[A-Z]{4}", s))


def _normalize_number(s: Any) -> str:
    s = clean_text(s)
    if not s or s == "-":
        return ""
    s = s.replace("(", "-").replace(")", "")
    s = s.replace("%", "")
    s = s.replace(" ", "")
    s = s.replace("\u2212", "-").replace("−", "-")
    return s


def looks_like_numeric_int(raw: Any) -> bool:
    r = _normalize_number(raw)
    if not r:
        return False
    if r[0] in "+-":
        r = r[1:]
    return bool(re.fullmatch(r"\d[\d.,]*", r))


def looks_like_numeric_pct(raw: Any) -> bool:
    r = _normalize_number(raw)
    if not r:
        return False
    if r[0] in "+-":
        r = r[1:]
    return bool(re.fullmatch(r"\d+(?:[.,]\d+)?", r))


def parse_int(raw: Any) -> Optional[int]:
    s = _normalize_number(raw)
    if not s:
        return None

    sign = 1
    if s[0] == "+":
        s = s[1:]
    elif s[0] == "-":
        sign = -1
        s = s[1:]

    s = s.replace(",", "").replace(".", "")
    if not s.isdigit():
        return None
    return sign * int(s)


def parse_pct(raw: Any) -> Optional[float]:
    s = _normalize_number(raw)
    if not s:
        return None

    sign = 1
    if s[0] == "+":
        s = s[1:]
    elif s[0] == "-":
        sign = -1
        s = s[1:]

    if "," in s and "." in s:
        # Use the last separator as decimal mark
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "")
            s = s.replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s and "." not in s:
        s = s.replace(",", ".")

    try:
        return sign * float(s)
    except ValueError:
        return None


def sane_pct_owned(v: Optional[float]) -> Optional[float]:
    if v is None:
        return None
    return v if 0.0 <= v <= 100.0 else None


def sane_pct_change(v: Optional[float]) -> Optional[float]:
    if v is None:
        return None
    return v if abs(v) <= 100.0 else None


def _digit_ratio(s: str) -> float:
    s = clean_text(s)
    s = re.sub(r"\s+", "", s)
    if not s:
        return 0.0
    d = sum(ch.isdigit() for ch in s)
    return d / len(s)


def _median(vals: list[float]) -> Optional[float]:
    if not vals:
        return None
    vals = sorted(vals)
    return vals[len(vals) // 2]


def _parse_header_date(label: str) -> Optional[tuple[int, int, int]]:
    h = norm(label)
    if not h:
        return None

    h = re.sub(r"[^A-Z0-9]", " ", h)
    toks = [t for t in h.split() if t]

    # Try dd-MMM-YYYY or dd MMM YY
    for i in range(len(toks) - 2):
        t1, t2, t3 = toks[i], toks[i + 1], toks[i + 2]
        if t1.isdigit() and t2 in MONTHS and t3.isdigit():
            day = int(t1)
            year = int(t3)
            if year < 100:
                year += 2000
            return (year, MONTHS[t2], day)

    # Try MMM YYYY or MMM YY
    for i in range(len(toks) - 1):
        t1, t2 = toks[i], toks[i + 1]
        if t1 in MONTHS and t2.isdigit():
            year = int(t2)
            if year < 100:
                year += 2000
            return (year, MONTHS[t1], 1)

    return None


# ---------------------------
# Table/header detection
# ---------------------------


def is_header_like_row(row: list[Any]) -> bool:
    joined = norm(" ".join(clean_text(c) for c in row if c is not None))
    return (
        ("KODE" in joined and "EFEK" in joined)
        or ("PEMEGANG" in joined and "SAHAM" in joined)
        or ("JUMLAH" in joined and "SAHAM" in joined)
    )


def merge_header_rows(rows: list[list[Any]]) -> list[str]:
    n = max((len(r) for r in rows), default=0)
    out: list[str] = []
    for i in range(n):
        parts = []
        for r in rows:
            parts.append(clean_text(r[i]) if i < len(r) else "")
        out.append(clean_text(" ".join(p for p in parts if p)))
    return out


@dataclass
class HeaderMatch:
    start_idx: int
    end_idx: int
    merged: list[str]
    colmap: dict[str, int]
    candidates: dict[str, list[int]]
    text_cols: set[int]
    score: int


def _pick_best(cands: list[tuple[int, int]]) -> Optional[int]:
    if not cands:
        return None
    return max(cands, key=lambda x: x[1])[0]


def analyze_header(labels: list[str]) -> tuple[dict[str, int], dict[str, list[int]], set[int], int]:
    colmap: dict[str, int] = {}
    candidates: dict[str, list[int]] = {
        "shares": [],
        "pct": [],
        "shares_change": [],
        "pct_change": [],
        "generic_change": [],
    }
    text_cols: set[int] = set()

    ticker_cands: list[tuple[int, int]] = []
    owner_cands: list[tuple[int, int]] = []
    sek_cands: list[tuple[int, int]] = []
    country_cands: list[tuple[int, int]] = []

    for i, cell in enumerate(labels):
        h = norm(cell)
        if not h:
            continue

        if any(k in h for k in ["NAMA", "ALAMAT", "DOMISILI", "STATUS", "EMITEN"]):
            text_cols.add(i)
        if "PEMEGANG" in h:
            text_cols.add(i)
        if "REKENING" in h and "EFEK" in h:
            text_cols.add(i)

        if "KODE" in h and ("EFEK" in h or "SAHAM" in h):
            score = 5 if "EFEK" in h else 4
            ticker_cands.append((i, score))

        if "PEMEGANG" in h and "SAHAM" in h:
            owner_cands.append((i, 5))

        if "REKENING" in h and "EFEK" in h:
            if "PEMEGANG" in h:
                sek_cands.append((i, 6))
            else:
                sek_cands.append((i, 2))

        if any(k in h for k in ["KEBANGSAAN", "KEWARGANEGARAAN", "NATIONALITY", "COUNTRY", "NEGARA"]):
            country_cands.append((i, 3))

        if "JUMLAH" in h and "SAHAM" in h and "PERUBAHAN" not in h:
            candidates["shares"].append(i)

        if ("PERSENTASE" in h or "PERSENTASI" in h or "%" in h) and "PERUBAHAN" not in h:
            candidates["pct"].append(i)

        if "PERUBAHAN" in h or "SELISIH" in h:
            if "SAHAM" in h or "JUMLAH" in h:
                candidates["shares_change"].append(i)
            elif "PERSENTASE" in h or "PERSENTASI" in h or "%" in h:
                candidates["pct_change"].append(i)
            else:
                candidates["generic_change"].append(i)

    colmap["ticker"] = _pick_best(ticker_cands) if ticker_cands else -1
    colmap["owner"] = _pick_best(owner_cands) if owner_cands else -1
    colmap["sekuritas"] = _pick_best(sek_cands) if sek_cands else -1
    colmap["country"] = _pick_best(country_cands) if country_cands else -1

    # Compute a header score so we can choose the best header block.
    score = 0
    if colmap["ticker"] >= 0:
        score += 5
    if colmap["owner"] >= 0:
        score += 5
    if colmap["sekuritas"] >= 0:
        score += 4
    if candidates["shares"]:
        score += 2
    if candidates["pct"]:
        score += 1

    return colmap, candidates, text_cols, score


def detect_header(table: list[list[Any]]) -> Optional[HeaderMatch]:
    best: Optional[HeaderMatch] = None

    scan_limit = min(len(table), HEADER_SCAN_ROWS)
    for start in range(scan_limit):
        row = table[start] or []
        if not is_header_like_row(row):
            continue

        for depth in range(HEADER_MERGE_DEPTH):
            end = start + depth
            if end >= len(table):
                break
            merged = merge_header_rows([table[i] or [] for i in range(start, end + 1)])
            colmap, candidates, text_cols, score = analyze_header(merged)

            if score <= 0:
                continue

            match = HeaderMatch(
                start_idx=start,
                end_idx=end,
                merged=merged,
                colmap=colmap,
                candidates=candidates,
                text_cols=text_cols,
                score=score,
            )

            if best is None or match.score > best.score:
                best = match

    return best


# ---------------------------
# Column scoring / refinement
# ---------------------------


@dataclass
class ColumnStats:
    parsable: int
    total: int
    signed: int
    values: list[float]
    decimal: int

    @property
    def ratio(self) -> float:
        return self.parsable / self.total if self.total else 0.0

    @property
    def median(self) -> Optional[float]:
        return _median(self.values)

    @property
    def decimal_ratio(self) -> float:
        return self.decimal / self.parsable if self.parsable else 0.0


def _col_text(row: list[Any], idx: int) -> str:
    return clean_text(row[idx]) if idx < len(row) else ""


def score_int_column(rows: list[list[Any]], idx: int) -> ColumnStats:
    parsable = 0
    total = 0
    signed = 0
    values: list[float] = []

    for r in rows[:SAMPLE_ROWS]:
        if idx >= len(r):
            continue
        raw = _col_text(r, idx)
        if not raw:
            continue
        total += 1
        if looks_like_numeric_int(raw):
            v = parse_int(raw)
            if v is not None:
                parsable += 1
                values.append(float(v))
                if raw.strip().startswith(("+", "-", "(")):
                    signed += 1

    return ColumnStats(parsable=parsable, total=total, signed=signed, values=values, decimal=0)


def score_pct_column(rows: list[list[Any]], idx: int) -> ColumnStats:
    parsable = 0
    total = 0
    signed = 0
    decimal = 0
    values: list[float] = []

    for r in rows[:SAMPLE_ROWS]:
        if idx >= len(r):
            continue
        raw = _col_text(r, idx)
        if not raw:
            continue
        total += 1
        if looks_like_numeric_pct(raw):
            v = parse_pct(raw)
            if v is not None and abs(v) <= 100.0:
                parsable += 1
                values.append(float(v))
                if raw.strip().startswith(("+", "-", "(")):
                    signed += 1
                if "." in raw or "," in raw:
                    decimal += 1

    return ColumnStats(parsable=parsable, total=total, signed=signed, values=values, decimal=decimal)


def pick_current_prev(
    candidates: list[int],
    rows: list[list[Any]],
    kind: str,
    min_ratio: float = 0.5,
    min_count: int = 5,
) -> tuple[Optional[int], Optional[int]]:
    if not candidates:
        return None, None

    stats = []
    for idx in candidates:
        st = score_int_column(rows, idx) if kind == "int" else score_pct_column(rows, idx)
        if st.parsable >= min_count and st.ratio >= min_ratio:
            stats.append((idx, st))

    if not stats:
        return None, None

    # If two or more good candidates, pick leftmost as prev and rightmost as current.
    stats_sorted = sorted(stats, key=lambda x: x[0])
    if len(stats_sorted) == 1:
        return stats_sorted[0][0], None
    return stats_sorted[-1][0], stats_sorted[0][0]


def refine_colmap(
    match: HeaderMatch,
    data_rows: list[list[Any]],
    debug: bool = False,
) -> dict[str, Optional[int]]:
    colmap: dict[str, Optional[int]] = {
        "ticker": match.colmap.get("ticker", -1),
        "owner": match.colmap.get("owner", -1),
        "sekuritas": match.colmap.get("sekuritas", -1),
        "country": match.colmap.get("country", -1),
        "shares_owned": None,
        "shares_prev": None,
        "pct_owned": None,
        "pct_prev": None,
        "shares_change": None,
        "pct_change": None,
    }

    ncols = max(len(match.merged), max((len(r) for r in data_rows), default=0))
    text_cols = set(match.text_cols)

    # Choose shares columns (prefer header candidates).
    shares_curr, shares_prev = pick_current_prev(match.candidates["shares"], data_rows, kind="int")
    if shares_curr is None:
        # Header missing: infer from strongly numeric columns (exclude text/pct/change).
        excluded = set(text_cols)
        excluded.update(match.candidates["pct"])
        excluded.update(match.candidates["shares_change"])
        excluded.update(match.candidates["pct_change"])
        excluded.update(match.candidates["generic_change"])
        inferred = []
        for idx in range(ncols):
            if idx in excluded:
                continue
            st = score_int_column(data_rows, idx)
            if st.parsable >= 8 and st.ratio >= 0.6:
                med = st.median or 0
                if med >= 1000:
                    inferred.append(idx)
        inferred = sorted(set(inferred))
        if inferred:
            shares_curr = inferred[-1]
            shares_prev = inferred[0] if len(inferred) > 1 else None
    colmap["shares_owned"] = shares_curr
    colmap["shares_prev"] = shares_prev

    # Choose percent columns (prefer header candidates).
    pct_curr, pct_prev = pick_current_prev(match.candidates["pct"], data_rows, kind="pct")
    if pct_curr is None:
        excluded = set(text_cols)
        excluded.update(match.candidates["shares"])
        excluded.update(match.candidates["shares_change"])
        excluded.update(match.candidates["pct_change"])
        excluded.update(match.candidates["generic_change"])
        inferred = []
        for idx in range(ncols):
            if idx in excluded:
                continue
            st = score_pct_column(data_rows, idx)
            med = st.median if st.median is not None else 999
            if st.parsable >= 8 and st.ratio >= 0.6 and med <= 100 and st.decimal_ratio >= 0.1:
                inferred.append(idx)
        inferred = sorted(set(inferred))
        if inferred:
            pct_curr = inferred[-1]
            pct_prev = inferred[0] if len(inferred) > 1 else None
    colmap["pct_owned"] = pct_curr
    colmap["pct_prev"] = pct_prev

    # Choose explicit change columns if present.
    if match.candidates["shares_change"]:
        best = max(match.candidates["shares_change"], key=lambda i: score_int_column(data_rows, i).parsable)
        st = score_int_column(data_rows, best)
        if st.parsable >= 5 and st.ratio >= 0.5:
            colmap["shares_change"] = best

    if match.candidates["pct_change"]:
        best = max(match.candidates["pct_change"], key=lambda i: score_pct_column(data_rows, i).parsable)
        st = score_pct_column(data_rows, best)
        if st.parsable >= 5 and st.ratio >= 0.5:
            colmap["pct_change"] = best

    # Generic "PERUBAHAN" columns: decide if they look like shares or pct change.
    for idx in match.candidates["generic_change"]:
        if colmap["shares_change"] is None:
            st_int = score_int_column(data_rows, idx)
            if st_int.parsable >= 5 and st_int.ratio >= 0.5:
                colmap["shares_change"] = idx
                continue
        if colmap["pct_change"] is None:
            st_pct = score_pct_column(data_rows, idx)
            if st_pct.parsable >= 5 and st_pct.ratio >= 0.5 and (st_pct.median or 0) <= 100:
                colmap["pct_change"] = idx

    # Last-resort inference for change columns if we cannot compute from prev/current.
    if colmap["shares_change"] is None and colmap["shares_prev"] is None:
        excluded = set(text_cols)
        excluded.update([colmap["shares_owned"], colmap["pct_owned"], colmap["pct_prev"]])
        for idx in range(ncols):
            if idx in excluded:
                continue
            st = score_int_column(data_rows, idx)
            if st.parsable >= 8 and st.ratio >= 0.6 and st.signed >= 1:
                colmap["shares_change"] = idx
                break

    if colmap["pct_change"] is None and colmap["pct_prev"] is None:
        excluded = set(text_cols)
        excluded.update([colmap["pct_owned"], colmap["shares_owned"], colmap["shares_prev"]])
        for idx in range(ncols):
            if idx in excluded:
                continue
            st = score_pct_column(data_rows, idx)
            if st.parsable >= 8 and st.ratio >= 0.6 and st.decimal_ratio >= 0.1:
                colmap["pct_change"] = idx
                break

    # Safety: avoid overlapping columns.
    if colmap["shares_change"] == colmap["shares_owned"]:
        colmap["shares_change"] = None
    if colmap["pct_change"] == colmap["pct_owned"]:
        colmap["pct_change"] = None
    if colmap["shares_change"] == colmap["pct_change"]:
        colmap["pct_change"] = None

    if debug:
        print(
            f"[debug] colmap refined: shares_owned={colmap['shares_owned']} shares_prev={colmap['shares_prev']} "
            f"pct_owned={colmap['pct_owned']} pct_prev={colmap['pct_prev']} "
            f"shares_change={colmap['shares_change']} pct_change={colmap['pct_change']}"
        )

    return colmap


def validate_colmap(
    data_rows: list[list[Any]],
    colmap: dict[str, Optional[int]],
    debug: bool = False,
) -> bool:
    sample = data_rows[:120]
    if not sample:
        return True

    def get(row: list[Any], field: str) -> str:
        idx = colmap.get(field)
        if idx is None or idx < 0 or idx >= len(row):
            return ""
        return clean_text(row[idx])

    ticker_ok = 0
    shares_ok = 0
    owner_ratios = []
    sek_ratios = []

    for r in sample:
        t = get(r, "ticker").upper()
        if looks_like_ticker(t):
            ticker_ok += 1

        so = parse_int(get(r, "shares_owned")) if colmap.get("shares_owned") is not None else None
        if so is not None:
            shares_ok += 1

        o = first_line(get(r, "owner"))
        s = first_line(get(r, "sekuritas"))
        if o:
            owner_ratios.append(_digit_ratio(o))
        if s:
            sek_ratios.append(_digit_ratio(s))

    if shares_ok < 10 or ticker_ok < 3:
        if debug:
            print(f"[debug] validate_colmap failed: shares_ok={shares_ok}, ticker_ok={ticker_ok}")
        return False

    def median(xs: list[float]) -> float:
        if not xs:
            return 0.0
        xs2 = sorted(xs)
        return xs2[len(xs2) // 2]

    owner_med = median(owner_ratios)
    sek_med = median(sek_ratios)

    if owner_med > 0.25 or sek_med > 0.25:
        if debug:
            print(
                f"[debug] validate_colmap failed: owner_med_digit_ratio={owner_med:.3f}, "
                f"sek_med_digit_ratio={sek_med:.3f}"
            )
        return False

    return True


# ---------------------------
# Data model
# ---------------------------


@dataclass
class HoldingRow:
    ticker: str
    owner_raw: str
    sekuritas_raw: str
    country_raw: str

    shares_owned: int
    shares_change: Optional[int]
    pct_owned: Optional[float]
    pct_change: Optional[float]


# ---------------------------
# Extract rows from PDF
# ---------------------------


def extract_tables_from_page(page, debug: bool = False) -> list[list[list[Any]]]:
    settings_lines = {
        "vertical_strategy": "lines",
        "horizontal_strategy": "lines",
        "intersection_tolerance": 5,
        "snap_tolerance": 3,
        "join_tolerance": 3,
        "edge_min_length": 10,
        "min_words_vertical": 1,
        "min_words_horizontal": 1,
        "text_tolerance": 3,
    }
    settings_text = {
        "vertical_strategy": "text",
        "horizontal_strategy": "text",
        "snap_tolerance": 3,
        "join_tolerance": 3,
        "edge_min_length": 10,
        "min_words_vertical": 1,
        "min_words_horizontal": 1,
        "text_tolerance": 3,
    }

    tables = page.extract_tables(table_settings=settings_lines) or []
    if not tables:
        tables = page.extract_tables(table_settings=settings_text) or []

    if debug:
        print(f"[debug] page {page.page_number}: extracted {len(tables)} tables")
    return tables


def rows_from_table(
    table: list[list[Any]],
    debug: bool = False,
    state: Optional[dict[str, Any]] = None,
) -> list[HoldingRow]:
    out: list[HoldingRow] = []
    if not table:
        return out

    if state is None:
        state = {"last_ticker": "", "last_owner_by_ticker": {}, "last_country_by_ticker": {}}

    match = detect_header(table)
    if match is None:
        return out

    data_rows = table[match.end_idx + 1 :]

    colmap = refine_colmap(match, data_rows, debug=debug)
    if not validate_colmap(data_rows, colmap, debug=debug):
        return out

    if debug:
        shown = " | ".join(
            f"{idx}:{clean_text(h)}" for idx, h in enumerate(match.merged) if clean_text(h)
        )
        print(f"[debug] header rows {match.start_idx}-{match.end_idx} score={match.score}")
        print(f"[debug] header cols: {shown}")
        print(f"[debug] header candidates: {match.candidates}")
        print(f"[debug] colmap: {colmap}")

    last_ticker = state.get("last_ticker", "")
    last_owner_by_ticker = state.get("last_owner_by_ticker", {})
    last_country_by_ticker = state.get("last_country_by_ticker", {})

    for r in data_rows:
        if not r or all(not clean_text(c) for c in r):
            continue
        if is_header_like_row(r):
            continue

        def get(field: str) -> str:
            idx = colmap.get(field)
            if idx is None or idx < 0 or idx >= len(r):
                return ""
            return clean_text(r[idx])

        shares_owned_raw = get("shares_owned") if colmap.get("shares_owned") is not None else ""
        shares_owned = parse_int(shares_owned_raw) if looks_like_numeric_int(shares_owned_raw) else None

        # prev snapshot (if present)
        shares_prev = None
        if colmap.get("shares_prev") is not None:
            sp_raw = get("shares_prev")
            if looks_like_numeric_int(sp_raw):
                shares_prev = parse_int(sp_raw)

        # Some rows use "-" for current shares when the holding is fully sold.
        # Keep these rows by treating current shares as zero, so change can be computed.
        if shares_owned is None and shares_prev is not None and shares_owned_raw in {"", "-"}:
            shares_owned = 0

        # ticker: forward-fill across continuation rows and pages
        raw_ticker = get("ticker").upper()
        if looks_like_ticker(raw_ticker):
            ticker = raw_ticker
            last_ticker = ticker
        elif clean_text(raw_ticker) == "" and last_ticker:
            ticker = last_ticker
        else:
            continue

        # owner: forward-fill per ticker
        owner_raw = get("owner")
        if clean_text(owner_raw):
            last_owner_by_ticker[ticker] = owner_raw
        else:
            owner_raw = last_owner_by_ticker.get(ticker, "")

        # country: forward-fill per ticker
        country_raw = get("country")
        if clean_text(country_raw):
            last_country_by_ticker[ticker] = country_raw
        else:
            country_raw = last_country_by_ticker.get(ticker, "")

        sek_raw = get("sekuritas")

        shares_change = None
        if colmap.get("shares_change") is not None:
            sc_raw = get("shares_change")
            if looks_like_numeric_int(sc_raw):
                shares_change = parse_int(sc_raw)

        pct_owned = None
        if colmap.get("pct_owned") is not None:
            pct_owned = sane_pct_owned(parse_pct(get("pct_owned")))

        pct_prev = None
        if colmap.get("pct_prev") is not None:
            pp_raw = get("pct_prev")
            if looks_like_numeric_pct(pp_raw):
                pct_prev = sane_pct_owned(parse_pct(pp_raw))

        pct_change = None
        if colmap.get("pct_change") is not None:
            pc_raw = get("pct_change")
            if looks_like_numeric_pct(pc_raw):
                pct_change = sane_pct_change(parse_pct(pc_raw))

        # If no explicit change column, compute from snapshots when possible.
        if shares_change is None and shares_prev is not None:
            shares_change = shares_owned - shares_prev

        if pct_change is None and pct_owned is not None and pct_prev is not None:
            pct_change = sane_pct_change(pct_owned - pct_prev)

        has_numeric_signal = any(
            v is not None for v in [shares_owned, shares_prev, shares_change, pct_owned, pct_prev, pct_change]
        )
        if not has_numeric_signal or shares_owned is None:
            continue

        out.append(
            HoldingRow(
                ticker=ticker,
                owner_raw=owner_raw,
                sekuritas_raw=sek_raw,
                country_raw=country_raw,
                shares_owned=shares_owned,
                shares_change=shares_change,
                pct_owned=pct_owned,
                pct_change=pct_change,
            )
        )

    state["last_ticker"] = last_ticker
    state["last_owner_by_ticker"] = last_owner_by_ticker
    state["last_country_by_ticker"] = last_country_by_ticker

    return out


def extract_holdings(pdf_path: str, debug: bool = False) -> list[HoldingRow]:
    rows: list[HoldingRow] = []
    state = {
        "last_ticker": "",
        "last_owner_by_ticker": {},
        "last_country_by_ticker": {},
    }
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            for table in extract_tables_from_page(page, debug=debug):
                rows.extend(rows_from_table(table, debug=debug, state=state))
    return rows


# ---------------------------
# Group + print
# ---------------------------


def normalize_owner_key(owner_raw: str) -> tuple[str, str]:
    """
    Returns (display_name, grouping_key).

    Grouping:
    - Take first line (usually the name).
    - Uppercase.
    - Remove punctuation.
    - Remove common titles that can move around (DRS/DR/IR/PROF/etc.).
    """
    display = first_line(owner_raw) or clean_text(owner_raw)

    key = display.upper()
    key = re.sub(r"[^A-Z0-9 ]+", " ", key)
    key = re.sub(r"\b(DRS|DR|IR|PROF|H|HJ|H\.)\b", " ", key)
    key = re.sub(r"\s+", " ", key).strip()

    return display, key


def _has_change(e: HoldingRow) -> bool:
    if e.shares_change is not None and e.shares_change != 0:
        return True
    if e.pct_change is not None and abs(e.pct_change) > 1e-12:
        return True
    return False


def print_grouped(rows: list[HoldingRow], only_changes: bool = True) -> None:
    def pick_group_pct(values: list[Optional[float]]) -> Optional[float]:
        """
        For multi-sekuritas owners, percentage fields are usually owner-level values
        that appear on only one row. Pick a stable representative instead of summing.
        """
        present = [v for v in values if v is not None]
        if not present:
            return None
        buckets: dict[float, list[float]] = defaultdict(list)
        for v in present:
            buckets[round(v, 4)].append(v)
        best = max(buckets.values(), key=len)
        return sum(best) / len(best)

    grouped: dict[str, dict[str, list[HoldingRow]]] = defaultdict(lambda: defaultdict(list))
    owner_display: dict[tuple[str, str], str] = {}
    owner_country: dict[tuple[str, str], str] = {}

    for r in rows:
        disp, okey = normalize_owner_key(r.owner_raw)
        grouped[r.ticker][okey].append(r)
        owner_display[(r.ticker, okey)] = disp

        c = first_line(r.country_raw) if r.country_raw else ""
        if c and not owner_country.get((r.ticker, okey)):
            owner_country[(r.ticker, okey)] = c

    changed_groups: set[tuple[str, str]] = set()
    if only_changes:
        for r in rows:
            if _has_change(r):
                _, okey = normalize_owner_key(r.owner_raw)
                changed_groups.add((r.ticker, okey))

    for ticker in sorted(grouped.keys()):
        for okey in sorted(grouped[ticker].keys()):
            if only_changes and (ticker, okey) not in changed_groups:
                continue
            entries = grouped[ticker][okey]
            disp = owner_display[(ticker, okey)]
            country = owner_country.get((ticker, okey), "")

            print(f"Ticker:              {ticker}")
            print(f"Owner:               {disp}")
            if country:
                print(f"Country:             {country}")
            print()

            group_pct_owned = pick_group_pct([e.pct_owned for e in entries])
            group_pct_change = pick_group_pct([e.pct_change for e in entries])

            for e in entries:
                sek = first_line(e.sekuritas_raw) or clean_text(e.sekuritas_raw)
                print(f"  Sekuritas:         {sek if sek else '-'}")
                print(f"  Shares Owned:      {e.shares_owned:,}")

                if e.shares_change is None:
                    print("  Shares Change:     -")
                else:
                    print(f"  Shares Change:     {e.shares_change:+,}")

                if len(entries) > 1:
                    # For multi-sekuritas owners, show percentages only on TOTAL.
                    print("  Percentage Owned:  -")
                    print("  Percentage Change: -")
                else:
                    if e.pct_owned is None:
                        print("  Percentage Owned:  -")
                    else:
                        print(f"  Percentage Owned:  {e.pct_owned:.2f}%")

                    if e.pct_change is None:
                        print("  Percentage Change: -")
                    else:
                        print(f"  Percentage Change: {e.pct_change:+.2f}%")

                print()

            if len(entries) > 1:
                total_shares = sum(e.shares_owned for e in entries)

                changes = [e.shares_change for e in entries if e.shares_change is not None]
                total_change = sum(changes) if changes else None

                print("  TOTAL (all sekuritas for this owner)")
                print(f"  Shares Owned:      {total_shares:,}")
                print(f"  Shares Change:     {'-' if total_change is None else f'{total_change:+,}'}")
                print(f"  Percentage Owned:  {'-' if group_pct_owned is None else f'{group_pct_owned:.2f}%'}")
                print(f"  Percentage Change: {'-' if group_pct_change is None else f'{group_pct_change:+.2f}%'}")
                print()

            print("-" * 60)


# ---------------------------
# Main
# ---------------------------


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", nargs="?", help="Path to the 5% ownership PDF")

    args = ap.parse_args()

    def pick_pdf_path(arg: Optional[str]) -> Optional[str]:
        if arg:
            p = Path(arg)
            if p.is_dir():
                candidates = sorted(p.glob("*.pdf"), key=lambda x: x.stat().st_mtime, reverse=True)
                return str(candidates[0]) if candidates else None
            return str(p)

        default_dir = Path(__file__).resolve().parent / "documents"
        if default_dir.is_dir():
            candidates = sorted(default_dir.glob("*.pdf"), key=lambda x: x.stat().st_mtime, reverse=True)
            return str(candidates[0]) if candidates else None
        return None

    pdf_path = pick_pdf_path(args.pdf)
    if not pdf_path or not Path(pdf_path).is_file():
        print("No PDF found. Provide a file path or place a PDF in ./documents.", file=sys.stderr)
        return 2

    rows = extract_holdings(pdf_path, debug=False)
    if not rows:
        print(
            "No rows extracted. If this PDF is scanned or table lines are not detected, "
            "convert it to a text-based PDF.",
            file=sys.stderr,
        )
        return 2

    print_grouped(rows, only_changes=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
