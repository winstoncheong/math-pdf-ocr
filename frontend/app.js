const PAGE_BUFFER = 20;

const state = {
  pdfLoaded: false,
  totalPages: 0,
  dpi: 200,
  ocrDpi: 600,
  backend: 'texify-onnx',
  results: [],
  pageStates: {},
  activePage: null,
  observer: null,
  recentOpen: false,
  ocrQueue: [],
  ocrRunning: 0,
  ocrMaxConcurrent: 3,
  currentPage: 0,
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
  await new Promise(r => requestAnimationFrame(r));
  await new Promise(r => requestAnimationFrame(r));
  const viewer = $('viewer');
  viewer.scrollTop = el.offsetTop - $('pagesContainer').offsetTop;
  await new Promise(r => requestAnimationFrame(r));
  prunePages();
}

/* ------------------------------------------------------------------ */
/*  LocalStorage persistence                                           */
/* ------------------------------------------------------------------ */
const STORAGE_KEY = 'mathPdfOcrState';

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      dpi: state.dpi,
      ocrDpi: state.ocrDpi,
      backend: state.backend,
      results: state.results.map(r => ({
        pageNum: r.pageNum,
        x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2,
        previewUrl: r.previewUrl,
        latex: r.latex,
        backend: r.backend,
        status: r.status,
        showRaw: r.showRaw,
      })),
    }));
  } catch { }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.dpi != null) {
      state.dpi = saved.dpi;
      $('dpiSlider').value = saved.dpi;
      $('dpiValue').textContent = saved.dpi;
    }
    if (saved.ocrDpi != null) {
      state.ocrDpi = saved.ocrDpi;
      $('ocrDpiSlider').value = saved.ocrDpi;
      $('ocrDpiValue').textContent = saved.ocrDpi;
    }
    if (saved.backend) {
      state.backend = saved.backend;
      $('backendSelect').value = saved.backend;
    }
    if (saved.results && saved.results.length) {
      state.results = saved.results.map(r => ({
        ...r,
        ts: new Date(),
        id: Date.now() + Math.random(),
      }));
      renderResults();
    }
  } catch { }
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
    // Preserve current selection if still available, otherwise pick a default
    if (state.backend && avail.find(b => b.name === state.backend)) {
      // keep state.backend as-is
    } else if (avail.find(b => b.name === 'texify-onnx')) {
      state.backend = 'texify-onnx';
    } else if (avail.length) {
      state.backend = avail[0].name;
    } else {
      state.backend = '';
    }
    sel.value = state.backend;
  } catch { }
}

$('backendSelect').addEventListener('change', e => {
  state.backend = e.target.value;
  saveState();
});

/* ------------------------------------------------------------------ */
/*  DPI slider                                                         */
/* ------------------------------------------------------------------ */
$('dpiSlider').addEventListener('input', e => {
  state.dpi = parseInt(e.target.value);
  $('dpiValue').textContent = state.dpi;
  saveState();
  if (state.pdfLoaded) reloadVisiblePages();
});

/* ------------------------------------------------------------------ */
/*  OCR DPI slider                                                     */
/* ------------------------------------------------------------------ */
$('ocrDpiSlider').addEventListener('input', e => {
  state.ocrDpi = parseInt(e.target.value);
  $('ocrDpiValue').textContent = state.ocrDpi;
  saveState();
});

/* ------------------------------------------------------------------ */
/*  Clear results                                                      */
/* ------------------------------------------------------------------ */
$('clearBtn').addEventListener('click', () => {
  state.results = [];
  renderResults();
  saveState();
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
/*  Open by path                                                       */
/* ------------------------------------------------------------------ */
$('openPathBtn').addEventListener('click', async () => {
  const path = $('pathInput').value.trim();
  if (!path) return;
  try {
    const r = await fetch('/open-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!r.ok) { alert('Failed to open: ' + (await r.text())); return; }
    const data = await r.json();
    openPdf(data.pages);
    await loadBackends();
    loadRecentFiles();
    $('pathInput').value = '';
  } catch (err) {
    alert('Error opening file: ' + err.message);
  }
});

$('pathInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('openPathBtn').click();
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

function unloadPage(pageNum) {
  const pageDiv = document.querySelector(`.pdf-page[data-page="${pageNum}"]`);
  if (!pageDiv || pageDiv.dataset.loaded !== 'true') return;
  pageDiv.dataset.loaded = 'false';
  pageDiv.querySelector('img').src = '';
  const canvas = pageDiv.querySelector('canvas');
  canvas.width = 0;
  canvas.height = 0;
  const ps = getPageState(pageNum);
  ps.loaded = false;
  ps.renderedW = 0;
  ps.renderedH = 0;
}

function getCurrentPage() {
  const viewer = $('viewer');
  const rect = viewer.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  for (const dy of [0, -60, 60, -120, 120]) {
    const el = document.elementFromPoint(cx, cy + dy);
    const pageDiv = el?.closest('.pdf-page');
    if (pageDiv) return parseInt(pageDiv.dataset.page);
  }
  return state.currentPage;
}

function prunePages() {
  if (!state.pdfLoaded) return;
  const centerPage = getCurrentPage();
  if (centerPage < 0) return;
  state.currentPage = centerPage;
  const windowStart = Math.max(0, centerPage - PAGE_BUFFER);
  const windowEnd = Math.min(state.totalPages - 1, centerPage + PAGE_BUFFER);
  for (const pageDiv of $$('.pdf-page[data-loaded="true"]')) {
    const pageNum = parseInt(pageDiv.dataset.page);
    if (pageNum < windowStart || pageNum > windowEnd) {
      unloadPage(pageNum);
    }
  }
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
  const rx1 = Math.round(x1 * sx);
  const ry1 = Math.round(y1 * sy);
  const rx2 = Math.round(x2 * sx);
  const ry2 = Math.round(y2 * sy);

  const previewUrl = captureRegionPreview(pageDiv.querySelector('img'), x1, y1, x2, y2);
  enqueueOcr(pageNum, rx1, ry1, rx2, ry2, previewUrl);
});

function captureRegionPreview(imgEl, x1, y1, x2, y2) {
  const scaleX = imgEl.naturalWidth / imgEl.clientWidth;
  const scaleY = imgEl.naturalHeight / imgEl.clientHeight;
  const sx = x1 * scaleX, sy = y1 * scaleY;
  const sw = (x2 - x1) * scaleX, sh = (y2 - y1) * scaleY;
  const c = document.createElement('canvas');
  c.width = sw;
  c.height = sh;
  const ctx = c.getContext('2d');
  ctx.drawImage(imgEl, sx, sy, sw, sh, 0, 0, sw, sh);
  return c.toDataURL('image/png');
}

/* ------------------------------------------------------------------ */
/*  Async OCR queue                                                    */
/* ------------------------------------------------------------------ */
function enqueueOcr(pageNum, x1, y1, x2, y2, previewUrl) {
  if (!state.backend) {
    addResult('No OCR backend available. Install pix2tex: pip install pix2tex[api]', null, previewUrl);
    return;
  }
  const id = Date.now() + Math.random();
  const item = { id, pageNum, x1, y1, x2, y2, previewUrl, status: 'queued', latex: null, backend: null, showRaw: true };
  state.results.unshift(item);
  renderResults();
  state.ocrQueue.push(item);
  processQueue();
}

async function processQueue() {
  while (state.ocrRunning < state.ocrMaxConcurrent && state.ocrQueue.length > 0) {
    const item = state.ocrQueue.shift();
    state.ocrRunning++;
    runOcr(item).finally(() => {
      state.ocrRunning--;
      processQueue();
    });
  }
}

async function runOcr(item) {
  item.status = 'running';
  renderResults();
  try {
    const params = new URLSearchParams({
      page_num: item.pageNum, x1: item.x1, y1: item.y1, x2: item.x2, y2: item.y2,
      dpi: state.dpi,
      ocr_dpi: state.ocrDpi,
      backend: state.backend,
    });
    const r = await fetch('/ocr?' + params.toString(), { method: 'POST' });
    if (!r.ok) { item.latex = 'OCR error: ' + await r.text(); item.status = 'error'; return; }
    const data = await r.json();
    item.latex = data.latex;
    item.backend = data.backend;
    item.status = 'done';
  } catch (err) {
    item.latex = 'Request failed: ' + err.message;
    item.status = 'error';
  } finally {
    renderResults();
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
/*  Scroll position persistence                                        */
/* ------------------------------------------------------------------ */
let _scrollSaveTimer = null;
$('viewer').addEventListener('scroll', () => {
  if (!state.pdfLoaded) return;
  clearTimeout(_scrollSaveTimer);
  _scrollSaveTimer = setTimeout(() => {
    const cur = getCurrentPage();
    if (cur >= 0) {
      localStorage.setItem('scrollPos', String(cur));
    }
    prunePages();
  }, 200);
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
function addResult(latex, backend, previewUrl) {
  state.results.unshift({ latex, backend: backend || 'unknown', ts: new Date(), previewUrl: previewUrl || null, status: 'done', id: Date.now(), showRaw: true });
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
    if (r.status === 'queued') {
      rendered = '<span class="status-queued">Queued...</span>';
    } else if (r.status === 'running') {
      rendered = '<span class="status-running">Processing...</span>';
    } else if (r.status === 'error') {
      rendered = `<pre class="raw-output">${escapeHtml(r.latex)}</pre>`;
    } else if (r.showRaw) {
      rendered = `<pre class="raw-output">${escapeHtml(r.latex)}</pre>`;
    } else {
      rendered = renderLatexText(r.latex);
    }
    const ts = r.ts ? r.ts.toLocaleTimeString() : '';
    const preview = r.previewUrl ? `<img class="result-preview" src="${r.previewUrl}" alt="Selected region">` : '';
    const toggleBtn = r.status === 'done' ? `<button class="result-raw-toggle" onclick="toggleResultRaw(${i})" title="Toggle raw/rendered view">${r.showRaw ? 'Render' : 'Raw'}</button>` : '';
    const resendBtn = (r.pageNum !== undefined && r.x1 !== undefined) ? `<button onclick="resendResult(${i})" title="Re-run OCR with current backend">Resend</button>` : '';
    const createTestBtn = (r.pageNum !== undefined && r.x1 !== undefined && r.previewUrl) ? `<button onclick="openCreateTest(${i})" title="Create a test case from this region">Create test</button>` : '';
    return `<div class="result-card">
      <div class="result-header">
        <span>${ts}</span>
        <span class="result-header-right">
          <span class="result-backend">${escapeHtml(r.backend || '')}</span>
          ${toggleBtn}
        </span>
      </div>
      ${preview}
      <div class="result-latex">${rendered}</div>
      <div class="result-actions">
        ${resendBtn}
        ${createTestBtn}
        ${r.status === 'done' ? `<button onclick="copyResult(${i})">Copy LaTeX</button>` : ''}
        <button onclick="removeResult(${i})">Remove</button>
      </div>
    </div>`;
  }).join('');
  container.scrollTop = 0;
  saveState();
}

function toggleResultRaw(i) {
  state.results[i].showRaw = !state.results[i].showRaw;
  renderResults();
}

function copyResult(i) {
  const r = state.results[i];
  if (!r || !r.latex) return;
  const text = r.latex;
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

function removeResult(i) {
  state.results.splice(i, 1);
  renderResults();
}

function resendResult(i) {
  const r = state.results[i];
  if (!r || r.pageNum === undefined) return;
  enqueueOcr(r.pageNum, r.x1, r.y1, r.x2, r.y2, r.previewUrl);
}

/* ------------------------------------------------------------------ */
/*  Create test case modal                                             */
/* ------------------------------------------------------------------ */
let _createTestResultIdx = null;

async function openCreateTest(i) {
  const r = state.results[i];
  if (!r || !r.previewUrl) return;
  _createTestResultIdx = i;

  $('testModalPreview').src = r.previewUrl;
  $('testNameInput').value = 'test' + (Date.now() % 10000);
  $('testExpectedInput').value = '';

  $('testModal').style.display = 'flex';
  $('testNameInput').focus();

  // Run texify to pre-fill expected output
  $('testExpectedInput').value = 'Running texify...';
  try {
    const params = new URLSearchParams({
      page_num: r.pageNum, x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2,
      dpi: state.dpi, ocr_dpi: state.ocrDpi, backend: 'texify-onnx',
    });
    const resp = await fetch('/ocr?' + params.toString(), { method: 'POST' });
    if (resp.ok) {
      const data = await resp.json();
      $('testExpectedInput').value = data.latex;
    } else {
      $('testExpectedInput').value = '';
    }
  } catch {
    $('testExpectedInput').value = '';
  }
  $('testExpectedInput').focus();
}

$('testModalClose').addEventListener('click', closeCreateTest);
$('testModalCancel').addEventListener('click', closeCreateTest);
$('testModal').addEventListener('click', e => {
  if (e.target === $('testModal')) closeCreateTest();
});

function closeCreateTest() {
  $('testModal').style.display = 'none';
  _createTestResultIdx = null;
}

$('testModalSave').addEventListener('click', async () => {
  const r = state.results[_createTestResultIdx];
  if (!r || !r.previewUrl) return;

  const name = $('testNameInput').value.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  const expected = $('testExpectedInput').value.trim();
  if (!name || !expected) {
    alert('Name and expected output are required.');
    return;
  }

  $('testModalSave').disabled = true;
  $('testModalSave').textContent = 'Saving...';
  try {
    const resp = await fetch('/save-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        expected,
        image: r.previewUrl,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      alert('Save failed: ' + err);
    } else {
      closeCreateTest();
    }
  } catch (err) {
    alert('Save failed: ' + err.message);
  } finally {
    $('testModalSave').disabled = false;
    $('testModalSave').textContent = 'Save test';
  }
});

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function renderLatexText(text) {
  // Split on $$...$$ (display) and $...$ (inline) math delimiters
  // then render math fragments with KaTeX and escape plain text
  const parts = [];
  let remaining = text;

  // First extract display math $$...$$
  const displayRe = /\$\$([\s\S]*?)\$\$/g;
  let lastIdx = 0;
  let m;
  while ((m = displayRe.exec(text)) !== null) {
    if (m.index > lastIdx) {
      parts.push({ type: 'text', content: text.slice(lastIdx, m.index) });
    }
    parts.push({ type: 'display', content: m[1] });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    parts.push({ type: 'text', content: text.slice(lastIdx) });
  }

  // Now extract inline math $...$ from text parts
  const final = [];
  const inlineRe = /\$([^\$]+?)\$/g;
  for (const part of parts) {
    if (part.type !== 'text') {
      final.push(part);
      continue;
    }
    let last = 0;
    let im;
    inlineRe.lastIndex = 0;
    while ((im = inlineRe.exec(part.content)) !== null) {
      if (im.index > last) {
        final.push({ type: 'text', content: part.content.slice(last, im.index) });
      }
      final.push({ type: 'inline', content: im[1] });
      last = im.index + im[0].length;
    }
    if (last < part.content.length) {
      final.push({ type: 'text', content: part.content.slice(last) });
    }
  }

  // Render each part
  return final.map(part => {
    if (part.type === 'text') {
      return escapeHtml(part.content).replace(/\n/g, '<br>');
    }
    try {
      const displayMode = part.type === 'display';
      return katex.renderToString(part.content, { throwOnError: false, displayMode });
    } catch {
      return escapeHtml(part.content);
    }
  }).join('');
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
/*  Split divider                                                      */
/* ------------------------------------------------------------------ */
(function initSplitDivider() {
  const divider = $('splitDivider');
  const results = $('results');
  let dragging = false;

  divider.addEventListener('mousedown', e => {
    e.preventDefault();
    dragging = true;
    divider.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const mainRect = $('main').getBoundingClientRect();
    const maxW = mainRect.width - 200;
    let w = mainRect.right - e.clientX;
    w = Math.max(200, Math.min(w, maxW));
    results.style.width = w + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

/* ------------------------------------------------------------------ */
/*  Image OCR tab                                                     */
/* ------------------------------------------------------------------ */
let _imageOcrFile = null;
let _imageOcrDataUrl = null;

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $('pagesContainer').style.display = tab === 'pdf' ? '' : 'none';
    $('imageOcrZone').style.display = tab === 'image' ? '' : 'none';
  });
});

$('imageOcrInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) loadImageToOcr(file);
});

$('imageOcrDropzone').addEventListener('dragover', e => { e.preventDefault(); });
$('imageOcrDropzone').addEventListener('drop', e => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) loadImageToOcr(file);
});

$('imageOcrDropzone').addEventListener('click', () => {
  $('imageOcrInput').click();
});

document.addEventListener('paste', e => {
  if ($('imageOcrZone').style.display === 'none') return;
  const items = e.clipboardData.items;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      loadImageToOcr(item.getAsFile());
      e.preventDefault();
      return;
    }
  }
});

function loadImageToOcr(file) {
  _imageOcrFile = file;
  const reader = new FileReader();
  reader.onload = e => {
    _imageOcrDataUrl = e.target.result;
    $('imageOcrImg').src = _imageOcrDataUrl;
    $('imageOcrDropzone').style.display = 'none';
    $('imageOcrPreview').style.display = '';
    $('imageOcrResult').innerHTML = '';
    $('imageOcrRunBtn').disabled = false;
  };
  reader.readAsDataURL(file);
}

$('imageOcrRunBtn').addEventListener('click', async () => {
  if (!_imageOcrFile && !_imageOcrDataUrl) return;
  const btn = $('imageOcrRunBtn');
  btn.disabled = true;
  btn.textContent = 'Running OCR...';

  const form = new FormData();
  if (_imageOcrFile) {
    form.append('file', _imageOcrFile);
  } else {
    const resp = await fetch(_imageOcrDataUrl);
    form.append('file', await resp.blob(), 'screenshot.png');
  }

  try {
    const r = await fetch('/api/ocr-image?backend=' + encodeURIComponent(state.backend), { method: 'POST', body: form });
    if (!r.ok) {
      $('imageOcrResult').innerHTML = '<pre class="raw-output">OCR error: ' + escapeHtml(await r.text()) + '</pre>';
      return;
    }
    const data = await r.json();
    $('imageOcrResult').innerHTML = '<pre class="raw-output">' + escapeHtml(data.latex) + '</pre>';
    addResult(data.latex, data.backend, _imageOcrDataUrl);
  } catch (err) {
    $('imageOcrResult').innerHTML = '<pre class="raw-output">Request failed: ' + escapeHtml(err.message) + '</pre>';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run OCR';
  }
});

$('imageOcrClearBtn').addEventListener('click', () => {
  _imageOcrFile = null;
  _imageOcrDataUrl = null;
  $('imageOcrDropzone').style.display = '';
  $('imageOcrPreview').style.display = 'none';
  $('imageOcrResult').innerHTML = '';
  $('imageOcrInput').value = '';
});

/* ------------------------------------------------------------------ */
/*  Init                                                               */
/* ------------------------------------------------------------------ */
async function init() {
  await loadBackends();
  loadState();
  await loadRecentFiles();
  try {
    const r = await fetch('/info');
    if (r.ok) {
      const data = await r.json();
      if (data.file_id) {
        await reopenFile(data.file_id);
        const saved = localStorage.getItem('scrollPos');
        if (saved) {
          await scrollToPage(parseInt(saved));
        }
      }
    }
  } catch { }
}
init();
