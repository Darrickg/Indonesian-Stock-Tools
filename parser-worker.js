let pyodideRuntime = null;
let parserReady = false;

function postProgress(jobId, titleKey, detailKey) {
  self.postMessage({ type: "progress", jobId, titleKey, detailKey });
}

async function ensureRuntime(jobId) {
  if (parserReady && pyodideRuntime) {
    return;
  }

  if (!self.loadPyodide) {
    importScripts("https://cdn.jsdelivr.net/pyodide/v0.27.4/full/pyodide.js");
  }

  if (!pyodideRuntime) {
    postProgress(jobId, "progress_loading_runtime_title", "progress_loading_runtime_detail");
    pyodideRuntime = await self.loadPyodide({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.27.4/full/",
    });
  }

  postProgress(jobId, "progress_installing_deps_title", "progress_installing_deps_detail");
  await pyodideRuntime.loadPackage("micropip");

  for (const pkg of ["pillow", "Pillow"]) {
    try {
      await pyodideRuntime.loadPackage(pkg);
      break;
    } catch (_err) {
      // Ignore and continue.
    }
  }

  try {
    await pyodideRuntime.runPythonAsync(`
import micropip

async def _install_pdf_stack():
    errors = []

    for spec in ("pdfplumber==0.10.4", "pdfplumber==0.10.3", "pdfplumber==0.9.0"):
        try:
            await micropip.install(spec)
            return
        except Exception as exc:
            errors.append(f"{spec}: {exc}")

    for spec in ("pdfplumber==0.10.4", "pdfplumber==0.10.3"):
        try:
            await micropip.install("pdfminer.six==20221105")
            await micropip.install(spec, deps=False)
            return
        except Exception as exc:
            errors.append(f"{spec} (deps=False): {exc}")

    raise RuntimeError("Unable to install a Pyodide-compatible pdfplumber build.\\n" + "\\n".join(errors[-4:]))

await _install_pdf_stack()
`);
  } catch (err) {
    throw new Error(`Could not load parser dependencies in browser. ${err.message}`);
  }

  postProgress(jobId, "progress_loading_parser_title", "progress_loading_parser_detail");
  const parserSource = await fetch("./fivepercent.py", { cache: "no-store" }).then((r) => {
    if (!r.ok) {
      throw new Error("Could not load fivepercent.py from this repository.");
    }
    return r.text();
  });

  pyodideRuntime.FS.mkdirTree("/workspace");
  pyodideRuntime.FS.writeFile("/workspace/fivepercent.py", parserSource);

  await pyodideRuntime.runPythonAsync(`
import sys
if "/workspace" not in sys.path:
    sys.path.insert(0, "/workspace")
import fivepercent
`);

  parserReady = true;
}

async function parsePdf(jobId, buffer) {
  pyodideRuntime.FS.writeFile("/workspace/input.pdf", new Uint8Array(buffer));
  postProgress(jobId, "progress_parsing_pdf_title", "progress_parsing_pdf_detail");

  const outputJson = await pyodideRuntime.runPythonAsync(`
import json
from collections import defaultdict
import fivepercent

def pick_group_pct(values):
    present = [v for v in values if v is not None]
    if not present:
        return None
    buckets = defaultdict(list)
    for v in present:
        buckets[round(v, 4)].append(v)
    best = max(buckets.values(), key=len)
    return sum(best) / len(best)

rows = fivepercent.extract_holdings('/workspace/input.pdf', debug=False)
grouped = defaultdict(lambda: defaultdict(list))
owner_display = {}
owner_country = {}

for r in rows:
    disp, okey = fivepercent.normalize_owner_key(r.owner_raw)
    grouped[r.ticker][okey].append(r)
    owner_display[(r.ticker, okey)] = disp
    c = fivepercent.first_line(r.country_raw) if r.country_raw else ""
    if c and not owner_country.get((r.ticker, okey)):
        owner_country[(r.ticker, okey)] = c

changed_groups = set()
for r in rows:
    if fivepercent._has_change(r):
        _, okey = fivepercent.normalize_owner_key(r.owner_raw)
        changed_groups.add((r.ticker, okey))

result = []
for ticker in sorted(grouped.keys()):
    for okey in sorted(grouped[ticker].keys()):
        if (ticker, okey) not in changed_groups:
            continue
        entries = grouped[ticker][okey]
        items = []
        for e in entries:
            items.append({
                "sekuritas": fivepercent.first_line(e.sekuritas_raw) or fivepercent.clean_text(e.sekuritas_raw) or "-",
                "shares_owned": e.shares_owned,
                "shares_change": e.shares_change,
                "pct_owned": e.pct_owned,
                "pct_change": e.pct_change,
            })

        total = None
        if len(entries) > 1:
            changes = [e.shares_change for e in entries if e.shares_change is not None]
            total = {
                "shares_owned": sum(e.shares_owned for e in entries),
                "shares_change": sum(changes) if changes else None,
                "pct_owned": pick_group_pct([e.pct_owned for e in entries]),
                "pct_change": pick_group_pct([e.pct_change for e in entries]),
            }

        result.append({
            "ticker": ticker,
            "owner": owner_display[(ticker, okey)],
            "country": owner_country.get((ticker, okey), ""),
            "entries": items,
            "total": total,
        })

summary = {
    "groups": len(result),
    "rows": sum(len(x["entries"]) for x in result),
    "tickers": len({x["ticker"] for x in result}),
    "changed_rows": sum(1 for r in rows if fivepercent._has_change(r)),
}

json.dumps({"summary": summary, "groups": result})
`);

  return JSON.parse(outputJson);
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type !== "parse") {
    return;
  }

  const jobId = msg.jobId ?? 0;

  try {
    await ensureRuntime(jobId);
    const payload = await parsePdf(jobId, msg.buffer);
    self.postMessage({ type: "result", jobId, payload });
  } catch (err) {
    self.postMessage({
      type: "error",
      jobId,
      error: err && err.message ? err.message : String(err),
    });
  }
};
