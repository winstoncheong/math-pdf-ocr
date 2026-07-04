const state = {
  pdfLoaded: false,
  totalPages: 0,
  dpi: 200,
  ocrDpi: 600,
  showRaw: false,
  backend: 'pix2tex',
  results: [],
  pageStates: {},
  activePage: null,
  observer: null,
  recentOpen: false,
};

const $ = id => document.getElementById(id);
const $$ = (sel, ctx) => (ctx || document).querySelectorAll(sel);

function getPageState(pageNum) {
  if (!state.pageStates[pageNum]) {
    state.pageStates[pageNum] = {
      loaded: false, selecting: false,
      selStart: null, selEnd: null,
      renderedW: 0, renderedH: 0,
      displayW: 0, displayH: 0,
    };
  }
  return state.pageStates[pageNum];
}

async function scrollToPage(pageNum) {
  const el = document.querySelector(`.pdf-page[data-page="${pageNum}"]`);
  if (!el) return;
  await loadPage(pageNum);
  el.scrollIntoView({ block: 'start' });
}

/* ------------------------------------------------------------------ */
/*  Backend loading                                                    */
/* ------------------------------------------------------------------ */
async function loadBackends() {
  try {
    const r = await fetch('/backends');
    const data = await r.json();
    const sel = $('backendSelect');
    sel.innerHTML = '';
    const avail = data.backends.filter(b => b.available);
    const unavail = data.backends.filter(b => !b.available);
    for (const b of [...avail, ...unavail]) {
      const opt = document.createElement('option');
      opt.value = b.name;
      opt.textContent = b.name + (b.available ? '' : ' (not installed)');
      opt.disabled = !b.available;
      sel.appendChild(opt);
    }
    if (avail.length) state.backend = avail[0].name;
    else state.backend = '';
  } catch { }
}

$('backendSelect').addEventListener('change', e => {
  state.backend = e.target.value;
});

/* ------------------------------------------------------------------ */
/*  DPI slider                                                         */
/* ------------------------------------------------------------------ */
$('dpiSlider').addEventListener('input', e => {
  state.dpi = parseInt(e.target.value);
  $('dpiValue').textContent = state.dpi;
  if (state.pdfLoaded) reloadVisiblePages();
});

/* ------------------------------------------------------------------ */
/*  OCR DPI slider                                                     */
/* ------------------------------------------------------------------ */
$('ocrDpiSlider').addEventListener('input', e => {
  state.ocrDpi = parseInt(e.target.value);
  $('ocrDpiValue').textContent = state.ocrDpi;
});

/* ------------------------------------------------------------------ */
/*  Clear results                                                      */
/* ------------------------------------------------------------------ */
$('clearBtn').addEventListener('click', () => {
  state.results = [];
  renderResults();
});

$('rawToggle').addEventListener('click', () => {
  state.showRaw = !state.showRaw;
  $('rawToggle').textContent = state.showRaw ? 'Render' : 'Raw';
  renderResults();
});

/* ------------------------------------------------------------------ */
/*  Page jump                                                          */
/* ------------------------------------------------------------------ */
const jumpInput = $('pageJump');
jumpInput.addEventListener('keydown', async e => {
  if (e.key === 'Enter' && state.pdfLoaded) {
    const n = parseInt(jumpInput.value);
    if (n >= 1 && n <= state.totalPages) {
      await scrollToPage(n - 1);
      jumpInput.value = n;
    }
  }
});

/* ------------------------------------------------------------------ */
/*  Upload PDF                                                         */
/* ------------------------------------------------------------------ */
$('fileInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  try {
    const r = await fetch('/upload', { method: 'POST', body: form });
    if (!r.ok) { alert('Upload failed: ' + (await r.text())); return; }
    const data = await r.json();
    openPdf(data.pages);
    await loadBackends();
    loadRecentFiles();
  } catch (err) {
    alert('Error uploading PDF: ' + err.message);
  }
});

/* ------------------------------------------------------------------ */
/*  Core: build / open / reload pages                                  */
/* ------------------------------------------------------------------ */
function openPdf(pages) {
  state.totalPages = pages;
  state.pdfLoaded = true;
  state.results = [];
  state.pageStates = {};
  renderResults();
  $('clearBtn').disabled = false;
  $('recentBtn').disabled = false;
  jumpInput.disabled = false;
  jumpInput.value = 1;
  $('pageCount').textContent = `\u2009/\u2009${pages}`;
  buildPages();
}

async function reopenFile(fileId) {
  try {
    const r = await fetch(`/open/${fileId}`, { method: 'POST' });
    if (!r.ok) { alert('Failed to reopen file'); return; }
    const data = await r.json();
    openPdf(data.pages);
    await loadBackends();
  } catch (err) {
    alert('Error reopening file: ' + err.message);
  }
  closeRecent();
}

function buildPages() {
  const container = $('pagesContainer');
  container.innerHTML = '';
  if (state.observer) state.observer.disconnect();

  state.observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        loadPage(parseInt(entry.target.dataset.page));
      }
    }
  }, { rootMargin: '400px' });

  for (let i = 0; i < state.totalPages; i++) {
    const pageDiv = document.createElement('div');
    pageDiv.className = 'pdf-page';
    pageDiv.dataset.page = i;
    pageDiv.dataset.loaded = 'false';

    const label = document.createElement('div');
    label.className = 'page-label';
    label.textContent = `\u2009Page ${i + 1}\u2009`;

    const wrapper = document.createElement('div');
    wrapper.className = 'page-content';

    const img = document.createElement('img');
    const canvas = document.createElement('canvas');
    wrapper.appendChild(img);
    wrapper.appendChild(canvas);
    pageDiv.appendChild(label);
    pageDiv.appendChild(wrapper);
    container.appendChild(pageDiv);
    state.observer.observe(pageDiv);
  }
}

async function loadPage(pageNum) {
  const pageDiv = document.querySelector(`.pdf-page[data-page="${pageNum}"]`);
  if (!pageDiv || pageDiv.dataset.loaded === 'true') return;
  pageDiv.dataset.loaded = 'true';

  const img = pageDiv.querySelector('img');
  const ps = getPageState(pageNum);

  img.src = `/page/${pageNum}?dpi=${state.dpi}`;
  await new Promise((resolve, reject) => {
    img.onload = () => {
      ps.renderedW = img.naturalWidth;
      ps.renderedH = img.naturalHeight;
      resizePageCanvas(pageNum);
      resolve();
    };
    img.onerror = reject;
    if (img.complete && img.naturalWidth) {
      ps.renderedW = img.naturalWidth;
      ps.renderedH = img.naturalHeight;
      resizePageCanvas(pageNum);
      resolve();
    }
  });
  ps.loaded = true;
}

function resizePageCanvas(pageNum) {
  const pageDiv = document.querySelector(`.pdf-page[data-page="${pageNum}"]`);
  if (!pageDiv) return;
  const img = pageDiv.querySelector('img');
  const canvas = pageDiv.querySelector('canvas');
  const ps = getPageState(pageNum);

  const rect = img.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  ps.displayW = rect.width;
  ps.displayH = rect.height;

  redrawSelection(pageNum);
}

function redrawSelection(pageNum) {
  const pageDiv = document.querySelector(`.pdf-page[data-page="${pageNum}"]`);
  if (!pageDiv) return;
  const canvas = pageDiv.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const ps = getPageState(pageNum);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!ps.selStart || !ps.selEnd) return;

  const x1 = Math.min(ps.selStart.x, ps.selEnd.x);
  const y1 = Math.min(ps.selStart.y, ps.selEnd.y);
  const x2 = Math.max(ps.selStart.x, ps.selEnd.x);
  const y2 = Math.max(ps.selStart.y, ps.selEnd.y);

  ctx.fillStyle = 'rgba(233, 69, 96, 0.15)';
  ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
  ctx.strokeStyle = '#e94560';
  ctx.lineWidth = 2;
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
}

function getCanvasPos(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function reloadVisiblePages() {
  const pages = document.querySelectorAll('.pdf-page[data-loaded="true"]');
  for (const pageDiv of pages) {
    pageDiv.dataset.loaded = 'false';
    const pageNum = parseInt(pageDiv.dataset.page);
    const ps = getPageState(pageNum);
    ps.loaded = false;
    ps.renderedW = 0;
    ps.renderedH = 0;
    pageDiv.querySelector('img').src = '';
    loadPage(pageNum);
  }
}

/* ------------------------------------------------------------------ */
/*  Mouse selection                                                    */
/* ------------------------------------------------------------------ */
$('pagesContainer').addEventListener('mousedown', e => {
  const canvas = e.target.closest('canvas');
  if (!canvas || !state.pdfLoaded) return;
  const pageDiv = canvas.closest('.pdf-page');
  if (!pageDiv) return;
  const pageNum = parseInt(pageDiv.dataset.page);
  const ps = getPageState(pageNum);
  if (!ps.loaded) return;

  state.activePage = pageNum;
  ps.selecting = true;
  ps.selStart = getCanvasPos(canvas, e);
  ps.selEnd = { ...ps.selStart };
});

document.addEventListener('mousemove', e => {
  if (state.activePage === null) return;
  const ps = getPageState(state.activePage);
  if (!ps || !ps.selecting) return;
  const pageDiv = document.querySelector(`.pdf-page[data-page="${state.activePage}"]`);
  if (!pageDiv) return;
  ps.selEnd = getCanvasPos(pageDiv.querySelector('canvas'), e);
  redrawSelection(state.activePage);
});

document.addEventListener('mouseup', async e => {
  if (state.activePage === null) return;
  const pageNum = state.activePage;
  const ps = getPageState(pageNum);
  state.activePage = null;
  if (!ps || !ps.selecting) return;
  ps.selecting = false;

  const pageDiv = document.querySelector(`.pdf-page[data-page="${pageNum}"]`);
  if (!pageDiv) return;
  ps.selEnd = getCanvasPos(pageDiv.querySelector('canvas'), e);
  redrawSelection(pageNum);

  const x1 = Math.min(ps.selStart.x, ps.selEnd.x);
  const y1 = Math.min(ps.selStart.y, ps.selEnd.y);
  const x2 = Math.max(ps.selStart.x, ps.selEnd.x);
  const y2 = Math.max(ps.selStart.y, ps.selEnd.y);
  if (x2 - x1 < 5 || y2 - y1 < 5) return;

  const sx = ps.renderedW / ps.displayW;
  const sy = ps.renderedH / ps.displayH;
  await runOcr(pageNum,
    Math.round(x1 * sx), Math.round(y1 * sy),
    Math.round(x2 * sx), Math.round(y2 * sy));
});

async function runOcr(pageNum, x1, y1, x2, y2) {
  if (!state.backend) {
    addResult('No OCR backend available. Install pix2tex: pip install pix2tex[api]');
    return;
  }
  showLoading('Running OCR...');
  try {
    const params = new URLSearchParams({
      page_num: pageNum, x1, y1, x2, y2,
      dpi: state.dpi,
      ocr_dpi: state.ocrDpi,
      backend: state.backend,
    });
    const r = await fetch('/ocr?' + params.toString(), { method: 'POST' });
    if (!r.ok) { addResult('OCR error: ' + await r.text()); return; }
    const data = await r.json();
    addResult(data.latex, data.backend);
  } catch (err) {
    addResult('Request failed: ' + err.message);
  } finally {
    hideLoading();
  }
}

/* ------------------------------------------------------------------ */
/*  Window resize                                                      */
/* ------------------------------------------------------------------ */
window.addEventListener('resize', () => {
  if (!state.pdfLoaded) return;
  for (const pageDiv of $$('.pdf-page[data-loaded="true"]')) {
    resizePageCanvas(parseInt(pageDiv.dataset.page));
  }
});

/* ------------------------------------------------------------------ */
/*  Recent files                                                       */
/* ------------------------------------------------------------------ */
async function loadRecentFiles() {
  try {
    const r = await fetch('/files');
    const data = await r.json();
    renderRecent(data.files);
  } catch { }
}

function renderRecent(files) {
  const el = $('recentList');
  if (!files.length) {
    el.innerHTML = '<div class="dropdown-empty">No recent files</div>';
    return;
  }
  el.innerHTML = files.map(f =>
    `<div class="dropdown-item" data-fid="${f.file_id}">
      <span class="dfn">${escapeHtml(f.filename)}</span>
      <span class="dpg">${f.pages} p.</span>
    </div>`
  ).join('');
  for (const item of el.querySelectorAll('.dropdown-item')) {
    item.addEventListener('click', () => reopenFile(item.dataset.fid));
  }
}

function closeRecent() {
  state.recentOpen = false;
  $('recentList').classList.remove('open');
}

$('recentBtn').addEventListener('click', () => {
  state.recentOpen = !state.recentOpen;
  $('recentList').classList.toggle('open', state.recentOpen);
  if (state.recentOpen) loadRecentFiles();
});

document.addEventListener('click', e => {
  if (state.recentOpen && !e.target.closest('#recentWrap')) {
    closeRecent();
  }
});

/* ------------------------------------------------------------------ */
/*  Results                                                            */
/* ------------------------------------------------------------------ */
function addResult(latex, backend) {
  state.results.unshift({ latex, backend: backend || 'unknown', ts: new Date() });
  renderResults();
}

function renderResults() {
  const container = $('resultsList');
  if (!state.results.length) {
    container.innerHTML = '<div class="empty-state">Select a region on any page to OCR it</div>';
    return;
  }
  container.innerHTML = state.results.map((r, i) => {
    let rendered;
    if (state.showRaw) {
      rendered = `<pre class="raw-output">${escapeHtml(r.latex)}</pre>`;
    } else {
      try {
        rendered = katex.renderToString(r.latex, { throwOnError: false, displayMode: true });
      } catch {
        rendered = escapeHtml(r.latex);
      }
    }
    const ts = r.ts.toLocaleTimeString();
    return `<div class="result-card">
      <div class="result-header">
        <span>${ts}</span>
        <span class="result-backend">${escapeHtml(r.backend)}</span>
      </div>
      <div class="result-latex">${rendered}</div>
      <div class="result-actions">
        <button onclick="copyResult(${i})">Copy LaTeX</button>
        <button onclick="removeResult(${i})">Remove</button>
      </div>
    </div>`;
  }).join('');
  container.scrollTop = 0;
}

function copyResult(i) {
  const r = state.results[i];
  if (r) navigator.clipboard.writeText(r.latex).catch(() => {});
}

function removeResult(i) {
  state.results.splice(i, 1);
  renderResults();
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function showLoading(msg) {
  let el = $('loading');
  if (!el) { el = document.createElement('div'); el.id = 'loading'; document.body.appendChild(el); }
  el.textContent = msg || 'Loading...';
  el.style.display = 'block';
}

function hideLoading() {
  const el = $('loading');
  if (el) el.style.display = 'none';
}

/* ------------------------------------------------------------------ */
/*  Init                                                               */
/* ------------------------------------------------------------------ */
loadBackends();
