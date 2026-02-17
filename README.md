# Indonesian Stock Tools Web App

This repository now includes a GitHub Pages web app for parsing IDX/KSEI 5% ownership PDFs directly in the browser.

## How it works

- Users drag and drop a PDF on the page.
- The site loads Pyodide (Python in WebAssembly).
- The existing `fivepercent.py` parser is loaded and executed in-browser.
- Results are rendered as grouped cards (Ticker + Owner + Sekuritas + totals).

No backend is required and uploaded files stay in the browser session.

## Local preview

Serve the repository with a local HTTP server (do not open `index.html` directly):

```bash
python3 -m http.server 8000
```

Then open:

`http://localhost:8000`

## GitHub Pages deploy

A workflow is included at `.github/workflows/pages.yml`.

1. Push to `main`.
2. In repository settings, set **Pages > Build and deployment > Source** to **GitHub Actions**.
3. The workflow deploys the site automatically.
