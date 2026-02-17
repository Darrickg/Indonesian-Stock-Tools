const uploadArea = document.getElementById("upload-area");
const fileInput = document.getElementById("file-input");
const statusLine = document.getElementById("status-line");
const summaryEl = document.getElementById("summary");
const resultsEl = document.getElementById("results");
const loadingOverlay = document.getElementById("loading-overlay");
const loadingTitle = document.getElementById("loading-title");
const loadingDetail = document.getElementById("loading-detail");
const heroEyebrow = document.getElementById("hero-eyebrow");
const heroTitle = document.getElementById("hero-title");
const heroSubtitle = document.getElementById("hero-subtitle");
const uploadTitle = document.getElementById("upload-title");
const uploadSubtitle = document.getElementById("upload-subtitle");
const langSwitch = document.getElementById("lang-switch");

const summaryTemplate = document.getElementById("summary-template");
const ownerCardTemplate = document.getElementById("owner-card-template");
const entryRowTemplate = document.getElementById("entry-row-template");

const I18N = {
  en: {
    hero_eyebrow: "Indonesia Stock Tools",
    hero_title: "IDX 5% Ownership Reader",
    hero_subtitle: "Drop a KSEI/OJK 5% PDF and get clean, grouped ownership changes.",
    upload_title: "Drag and drop your 5% PDF",
    upload_subtitle: "or click to choose a file",
    upload_aria: "Upload a PDF file",
    lang_switch_aria: "Language",

    status_ready: "Ready. Drop a PDF to start.",
    status_need_pdf: "Please upload a PDF file.",
    status_parsing: "Parsing {file}...",
    status_done: "Done. Parsed {file}.",
    status_no_rows: "No changed rows were extracted from this PDF.",
    status_failed: "Parsing failed: {error}",

    loading_preparing_title: "Preparing parser...",
    loading_preparing_detail: "Starting worker runtime.",
    progress_working_title: "Working...",
    progress_working_detail: "",
    progress_loading_runtime_title: "Loading Python runtime...",
    progress_loading_runtime_detail: "First load may take 20-40 seconds.",
    progress_installing_deps_title: "Installing parser dependencies...",
    progress_installing_deps_detail: "Loading pdfplumber in your browser.",
    progress_loading_parser_title: "Loading parser...",
    progress_loading_parser_detail: "Preparing fivepercent.py.",
    progress_parsing_pdf_title: "Parsing PDF...",
    progress_parsing_pdf_detail: "Analyzing holdings and changes.",

    summary_owner_groups: "Owner Groups",
    summary_tickers: "Tickers",
    summary_rows_shown: "Rows Shown",
    summary_rows_with_change: "Rows With Change",

    label_sekuritas: "Sekuritas",
    label_shares_owned: "Shares Owned",
    label_shares_change: "Shares Change",
    label_pct_owned: "Percentage Owned",
    label_pct_change: "Percentage Change",
    total_heading: "TOTAL (all sekuritas for this owner)",

    error_parser_busy: "Parser is already running. Please wait for it to finish.",
    error_worker_crashed: "Parser worker crashed. Refresh and try again.",
    error_unknown: "Unknown parser error.",
  },
  id: {
    hero_eyebrow: "Indonesia Stock Tools",
    hero_title: "Pembaca Kepemilikan 5% IDX",
    hero_subtitle: "Tarik dan lepaskan PDF 5% KSEI/OJK untuk melihat perubahan kepemilikan yang sudah dikelompokkan.",
    upload_title: "Tarik dan lepaskan PDF 5% Anda",
    upload_subtitle: "atau klik untuk memilih file",
    upload_aria: "Unggah file PDF",
    lang_switch_aria: "Bahasa",

    status_ready: "Siap. Tarik file PDF untuk mulai.",
    status_need_pdf: "Silakan unggah file PDF.",
    status_parsing: "Memproses {file}...",
    status_done: "Selesai. {file} berhasil diproses.",
    status_no_rows: "Tidak ada baris perubahan yang berhasil diekstrak dari PDF ini.",
    status_failed: "Proses gagal: {error}",

    loading_preparing_title: "Menyiapkan parser...",
    loading_preparing_detail: "Memulai runtime worker.",
    progress_working_title: "Memproses...",
    progress_working_detail: "",
    progress_loading_runtime_title: "Memuat runtime Python...",
    progress_loading_runtime_detail: "Muat pertama bisa memakan 20-40 detik.",
    progress_installing_deps_title: "Memasang dependensi parser...",
    progress_installing_deps_detail: "Memuat pdfplumber di browser.",
    progress_loading_parser_title: "Memuat parser...",
    progress_loading_parser_detail: "Menyiapkan fivepercent.py.",
    progress_parsing_pdf_title: "Memproses PDF...",
    progress_parsing_pdf_detail: "Menganalisis kepemilikan dan perubahan.",

    summary_owner_groups: "Grup Pemilik",
    summary_tickers: "Ticker",
    summary_rows_shown: "Baris Ditampilkan",
    summary_rows_with_change: "Baris Berubah",

    label_sekuritas: "Sekuritas",
    label_shares_owned: "Saham Dimiliki",
    label_shares_change: "Perubahan Saham",
    label_pct_owned: "Persentase Kepemilikan",
    label_pct_change: "Perubahan Persentase",
    total_heading: "TOTAL (semua sekuritas untuk pemilik ini)",

    error_parser_busy: "Parser sedang berjalan. Tunggu sampai selesai.",
    error_worker_crashed: "Worker parser berhenti. Muat ulang lalu coba lagi.",
    error_unknown: "Error parser tidak diketahui.",
  },
};

let parserWorker = null;
let activeJob = null;
let nextJobId = 1;
let lastParsed = null;
let statusState = { key: "status_ready", vars: {} };
let loadingState = {
  titleKey: "loading_preparing_title",
  detailKey: "loading_preparing_detail",
  titleText: "",
  detailText: "",
};

let currentLang = localStorage.getItem("idx_lang");
if (!currentLang || !I18N[currentLang]) {
  currentLang = "en";
}

function t(key, vars = {}) {
  const dict = I18N[currentLang] || I18N.en;
  const fallback = I18N.en[key] || key;
  const template = dict[key] || fallback;
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    return vars[name] !== undefined ? String(vars[name]) : `{${name}}`;
  });
}

function formatInt(value) {
  if (value === null || value === undefined) {
    return "-";
  }
  return new Intl.NumberFormat("en-US").format(value);
}

function formatSignedInt(value) {
  if (value === null || value === undefined) {
    return "-";
  }
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${formatInt(Math.abs(value))}`;
}

function formatSharesChange(value, dashIfZero = false) {
  if (value === null || value === undefined) {
    return "-";
  }
  if (dashIfZero && value === 0) {
    return "-";
  }
  return formatSignedInt(value);
}

function formatPct(value, signed = false) {
  if (value === null || value === undefined) {
    return "-";
  }
  if (signed) {
    const sign = value >= 0 ? "+" : "-";
    return `${sign}${Math.abs(value).toFixed(2)}%`;
  }
  return `${value.toFixed(2)}%`;
}

function classForChange(value) {
  if (value === null || value === undefined || value === 0) {
    return "";
  }
  return value > 0 ? "change-pos" : "change-neg";
}

function renderLoadingText() {
  const title = loadingState.titleKey ? t(loadingState.titleKey) : loadingState.titleText;
  const detail = loadingState.detailKey ? t(loadingState.detailKey) : loadingState.detailText;
  loadingTitle.textContent = title;
  loadingDetail.textContent = detail;
}

function setStatusKey(key, vars = {}) {
  statusState = { key, vars };
  statusLine.textContent = t(key, vars);
}

function refreshStatus() {
  statusLine.textContent = t(statusState.key, statusState.vars);
}

function showLoading(titleKey, detailKey) {
  loadingState = {
    titleKey,
    detailKey,
    titleText: "",
    detailText: "",
  };
  renderLoadingText();
  loadingOverlay.classList.remove("hidden");
}

function updateLoading(titleKey, detailKey) {
  loadingState = {
    titleKey,
    detailKey,
    titleText: "",
    detailText: "",
  };
  renderLoadingText();
}

function updateLoadingRaw(titleText, detailText) {
  loadingState = {
    titleKey: "",
    detailKey: "",
    titleText,
    detailText,
  };
  renderLoadingText();
}

function hideLoading() {
  loadingOverlay.classList.add("hidden");
}

function applyStaticTranslations() {
  heroEyebrow.textContent = t("hero_eyebrow");
  heroTitle.textContent = t("hero_title");
  heroSubtitle.textContent = t("hero_subtitle");
  uploadTitle.textContent = t("upload_title");
  uploadSubtitle.textContent = t("upload_subtitle");
  uploadArea.setAttribute("aria-label", t("upload_aria"));
  langSwitch.setAttribute("aria-label", t("lang_switch_aria"));
}

function setLanguage(lang) {
  if (!I18N[lang]) {
    return;
  }

  currentLang = lang;
  localStorage.setItem("idx_lang", lang);
  document.documentElement.lang = lang === "id" ? "id" : "en";

  for (const btn of langSwitch.querySelectorAll(".lang-btn")) {
    btn.classList.toggle("active", btn.dataset.lang === lang);
  }

  applyStaticTranslations();
  refreshStatus();
  renderLoadingText();

  if (lastParsed && lastParsed.groups) {
    renderSummary(lastParsed.summary);
    renderResults(lastParsed.groups);
  }
}

function ensureWorker() {
  if (parserWorker) {
    return parserWorker;
  }

  parserWorker = new Worker("./parser-worker.js");

  parserWorker.onmessage = (event) => {
    const msg = event.data || {};

    if (msg.type === "progress") {
      if (activeJob && msg.jobId === activeJob.jobId) {
        if (msg.titleKey || msg.detailKey) {
          updateLoading(msg.titleKey || "progress_working_title", msg.detailKey || "progress_working_detail");
        } else {
          updateLoadingRaw(msg.title || t("progress_working_title"), msg.detail || t("progress_working_detail"));
        }
      }
      return;
    }

    if (!activeJob || msg.jobId !== activeJob.jobId) {
      return;
    }

    if (msg.type === "result") {
      activeJob.resolve(msg.payload);
      activeJob = null;
      return;
    }

    if (msg.type === "error") {
      activeJob.reject(new Error(msg.error || t("error_unknown")));
      activeJob = null;
    }
  };

  parserWorker.onerror = () => {
    if (activeJob) {
      activeJob.reject(new Error(t("error_worker_crashed")));
      activeJob = null;
    }
  };

  return parserWorker;
}

async function parseFileWithWorker(file) {
  if (activeJob) {
    throw new Error(t("error_parser_busy"));
  }

  const worker = ensureWorker();
  const buffer = await file.arrayBuffer();
  const jobId = nextJobId++;

  return await new Promise((resolve, reject) => {
    activeJob = { jobId, resolve, reject };
    worker.postMessage({ type: "parse", jobId, buffer }, [buffer]);
  });
}

function renderSummary(summary) {
  summaryEl.innerHTML = "";
  const cards = [
    [t("summary_owner_groups"), summary.groups],
    [t("summary_tickers"), summary.tickers],
    [t("summary_rows_shown"), summary.rows],
    [t("summary_rows_with_change"), summary.changed_rows],
  ];

  for (const [label, value] of cards) {
    const node = summaryTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".label").textContent = label;
    node.querySelector(".value").textContent = formatInt(value);
    summaryEl.appendChild(node);
  }

  summaryEl.classList.remove("hidden");
}

function renderResults(groups) {
  resultsEl.innerHTML = "";

  for (const group of groups) {
    const card = ownerCardTemplate.content.firstElementChild.cloneNode(true);
    card.querySelector(".ticker-pill").textContent = group.ticker;
    card.querySelector(".owner-name").textContent = group.owner || "-";
    card.querySelector(".owner-country").textContent = group.country || "";

    const entriesEl = card.querySelector(".entries");
    const totalEl = card.querySelector(".total-row");
    const isMultiSekuritas = group.entries.length > 1;

    for (const entry of group.entries) {
      const row = entryRowTemplate.content.firstElementChild.cloneNode(true);
      row.querySelector(".entry-label-sek").textContent = t("label_sekuritas");
      row.querySelector(".entry-sek").textContent = entry.sekuritas || "-";
      row.querySelector(".label-shares-owned").textContent = t("label_shares_owned");
      row.querySelector(".label-shares-change").textContent = t("label_shares_change");
      row.querySelector(".label-pct-owned").textContent = t("label_pct_owned");
      row.querySelector(".label-pct-change").textContent = t("label_pct_change");
      row.querySelector(".metric-shares-owned").textContent = formatInt(entry.shares_owned);

      const sharesChangeEl = row.querySelector(".metric-shares-change");
      sharesChangeEl.textContent = formatSharesChange(entry.shares_change, isMultiSekuritas);
      sharesChangeEl.className = `metric-shares-change ${classForChange(entry.shares_change)}`.trim();

      const pctOwnedEl = row.querySelector(".metric-pct-owned");
      const pctChangeEl = row.querySelector(".metric-pct-change");

      if (isMultiSekuritas) {
        pctOwnedEl.textContent = "-";
        pctChangeEl.textContent = "-";
      } else {
        pctOwnedEl.textContent = formatPct(entry.pct_owned, false);
        pctChangeEl.textContent = formatPct(entry.pct_change, true);
        pctChangeEl.className = `metric-pct-change ${classForChange(entry.pct_change)}`.trim();
      }

      entriesEl.appendChild(row);
    }

    if (group.total) {
      totalEl.classList.remove("hidden");
      totalEl.innerHTML = `
        <h4>${t("total_heading")}</h4>
        <div class="total-metrics">
          <p><span>${t("label_shares_owned")}</span><strong>${formatInt(group.total.shares_owned)}</strong></p>
          <p><span>${t("label_shares_change")}</span><strong class="${classForChange(group.total.shares_change)}">${formatSharesChange(group.total.shares_change, true)}</strong></p>
          <p><span>${t("label_pct_owned")}</span><strong>${formatPct(group.total.pct_owned, false)}</strong></p>
          <p><span>${t("label_pct_change")}</span><strong class="${classForChange(group.total.pct_change)}">${formatPct(group.total.pct_change, true)}</strong></p>
        </div>
      `;
    }

    resultsEl.appendChild(card);
  }

  resultsEl.classList.remove("hidden");
}

async function handleFile(file) {
  const isPdf = Boolean(
    file && (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))
  );
  if (!isPdf) {
    setStatusKey("status_need_pdf");
    return;
  }

  showLoading("loading_preparing_title", "loading_preparing_detail");
  setStatusKey("status_parsing", { file: file.name });

  try {
    const parsed = await parseFileWithWorker(file);
    lastParsed = parsed;

    if (!parsed.groups || parsed.groups.length === 0) {
      summaryEl.classList.add("hidden");
      resultsEl.classList.add("hidden");
      setStatusKey("status_no_rows");
      return;
    }

    renderSummary(parsed.summary);
    renderResults(parsed.groups);
    setStatusKey("status_done", { file: file.name });
  } catch (err) {
    console.error(err);
    summaryEl.classList.add("hidden");
    resultsEl.classList.add("hidden");
    setStatusKey("status_failed", { error: err.message });
  } finally {
    hideLoading();
  }
}

uploadArea.addEventListener("click", () => fileInput.click());
uploadArea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener("change", async (e) => {
  const [file] = e.target.files;
  if (file) {
    await handleFile(file);
  }
});

uploadArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  uploadArea.classList.add("dragover");
});

uploadArea.addEventListener("dragleave", () => {
  uploadArea.classList.remove("dragover");
});

uploadArea.addEventListener("drop", async (e) => {
  e.preventDefault();
  uploadArea.classList.remove("dragover");
  const [file] = e.dataTransfer.files;
  if (file) {
    await handleFile(file);
  }
});

langSwitch.addEventListener("click", (e) => {
  const btn = e.target.closest(".lang-btn");
  if (!btn) {
    return;
  }
  setLanguage(btn.dataset.lang);
});

setLanguage(currentLang);
setStatusKey("status_ready");
