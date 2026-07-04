const state = {
  pdfLoaded: false,
  totalPages: 0,
  currentPage: 0,
  dpi: 200,
  backend: 'pix2tex',
  selecting: false,
  selStart: null,
  selEnd: null,
  results: [],
  renderedSize: { w: 0, h: 0 },
  displaySize: { w: 0, h: 0 },
  uploading: false,
};

const $ = id => document.getElementById(id);
const pageImage = $('pageImage');
const canvas = $('selectionCanvas');
const ctx = canvas.getContext('2d');

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
      if (b.available && !avail.length) opt.disabled = true;
      sel.appendChild(opt);
    }
    if (avail.length) state.backend = avail[0].name;
    else state.backend = '';
  } catch { /* server not ready */ }
}

$('backendSelect').addEventListener('change', e => {
  state.backend = e.target.value;
});

$('fileInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  try {
    const r = await fetch('/upload', { method: 'POST', body: form });
    if (!r.ok) { alert('Upload failed: ' + (await r.text())); return; }
    const data = await r.json();
    state.totalPages = data.pages;
    state.currentPage = 0;
    state.pdfLoaded = true;
    state.results = [];
    renderResults();
    $('prevPage').disabled = true;
    $('nextPage').disabled = state.totalPages <= 1;
    $('clearBtn').disabled = false;
    loadPage(0);
    await loadBackends();
  } catch (err) {
    alert('Error uploading PDF: ' + err.message);
  }
});

$('prevPage').addEventListener('click', () => {
  if (state.currentPage > 0) loadPage(state.currentPage - 1);
});

$('nextPage').addEventListener('click', () => {
  if (state.currentPage < state.totalPages - 1) loadPage(state.currentPage + 1);
});

$('dpiSlider').addEventListener('input', e => {
  state.dpi = parseInt(e.target.value);
  $('dpiValue').textContent = state.dpi;
  if (state.pdfLoaded) loadPage(state.currentPage);
});

$('clearBtn').addEventListener('click', () => {
  state.results = [];
  renderResults();
});

async function loadPage(pageNum) {
  state.currentPage = pageNum;
  $('pageInfo').textContent = `${pageNum + 1} / ${state.totalPages}`;
  $('prevPage').disabled = pageNum === 0;
  $('nextPage').disabled = pageNum === state.totalPages - 1;
  canvas.style.pointerEvents = 'none';
  const url = `/page/${pageNum}?dpi=${state.dpi}`;
  pageImage.src = url;
  await new Promise((resolve, reject) => {
    pageImage.onload = () => {
      state.renderedSize = { w: pageImage.naturalWidth, h: pageImage.naturalHeight };
      state.displaySize = { w: pageImage.clientWidth, h: pageImage.clientHeight };
      resizeCanvas();
      canvas.style.pointerEvents = 'auto';
      resolve();
    };
    pageImage.onerror = reject;
    if (pageImage.complete && pageImage.naturalWidth) {
      state.renderedSize = { w: pageImage.naturalWidth, h: pageImage.naturalHeight };
      state.displaySize = { w: pageImage.clientWidth, h: pageImage.clientHeight };
      resizeCanvas();
      canvas.style.pointerEvents = 'auto';
      resolve();
    }
  });
}

function resizeCanvas() {
  const rect = pageImage.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  state.displaySize = { w: rect.width, h: rect.height };
  redrawSelection();
}

function redrawSelection() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.selStart || !state.selEnd) return;
  const x1 = Math.min(state.selStart.x, state.selEnd.x);
  const y1 = Math.min(state.selStart.y, state.selEnd.y);
  const x2 = Math.max(state.selStart.x, state.selEnd.x);
  const y2 = Math.max(state.selStart.y, state.selEnd.y);
  ctx.fillStyle = 'rgba(233, 69, 96, 0.15)';
  ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
  ctx.strokeStyle = '#e94560';
  ctx.lineWidth = 2;
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
}

function getCanvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };
}

canvas.addEventListener('mousedown', e => {
  if (!state.pdfLoaded) return;
  state.selecting = true;
  state.selStart = getCanvasPos(e);
  state.selEnd = { ...state.selStart };
});

canvas.addEventListener('mousemove', e => {
  if (!state.selecting) return;
  state.selEnd = getCanvasPos(e);
  redrawSelection();
});

canvas.addEventListener('mouseup', async e => {
  if (!state.selecting) return;
  state.selecting = false;
  state.selEnd = getCanvasPos(e);
  redrawSelection();
  const x1 = Math.min(state.selStart.x, state.selEnd.x);
  const y1 = Math.min(state.selStart.y, state.selEnd.y);
  const x2 = Math.max(state.selStart.x, state.selEnd.x);
  const y2 = Math.max(state.selStart.y, state.selEnd.y);
  if (x2 - x1 < 5 || y2 - y1 < 5) return;
  const sx = state.renderedSize.w / state.displaySize.w;
  const sy = state.renderedSize.h / state.displaySize.h;
  const rx1 = Math.round(x1 * sx);
  const ry1 = Math.round(y1 * sy);
  const rx2 = Math.round(x2 * sx);
  const ry2 = Math.round(y2 * sy);
  await runOcr(rx1, ry1, rx2, ry2);
});

async function runOcr(x1, y1, x2, y2) {
  if (!state.backend) {
    addResult('No OCR backend available. Install pix2tex: pip install pix2tex[api]');
    return;
  }
  showLoading('Running OCR...');
  try {
    const params = new URLSearchParams({
      page_num: state.currentPage,
      x1, y1, x2, y2,
      dpi: state.dpi,
      backend: state.backend,
    });
    const r = await fetch('/ocr?' + params.toString(), { method: 'POST' });
    if (!r.ok) {
      const err = await r.text();
      addResult(`OCR error: ${err}`);
      return;
    }
    const data = await r.json();
    addResult(data.latex, data.backend);
  } catch (err) {
    addResult(`Request failed: ${err.message}`);
  } finally {
    hideLoading();
  }
}

function addResult(latex, backend) {
  state.results.unshift({ latex, backend: backend || 'unknown', ts: new Date() });
  renderResults();
}

function renderResults() {
  const container = $('resultsList');
  if (!state.results.length) {
    container.innerHTML = '<div class="empty-state">Select a region on the PDF to OCR it</div>';
    return;
  }
  container.innerHTML = state.results.map((r, i) => {
    let rendered = escapeHtml(r.latex);
    let parsed = false;
    try {
      rendered = katex.renderToString(r.latex, { throwOnError: false, displayMode: true });
      parsed = true;
    } catch { /* fallback to raw */ }
    const ts = r.ts.toLocaleTimeString();
    return `<div class="result-card">
      <div class="result-header">
        <span>${ts}</span>
        <span class="result-backend">${escapeHtml(r.backend)}</span>
      </div>
      <div class="result-latex">${rendered}</div>
      <div class="result-actions">
        <button onclick="copyResult(${i})">Copy LaTeX</button>
        <button onclick="retryResult(${i})">Re-OCR</button>
        <button onclick="removeResult(${i})">Remove</button>
      </div>
    </div>`;
  }).join('');
  container.scrollTop = 0;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function copyResult(i) {
  const r = state.results[i];
  if (!r) return;
  navigator.clipboard.writeText(r.latex).catch(() => {});
}

function removeResult(i) {
  state.results.splice(i, 1);
  renderResults();
}

function retryResult(i) {
  // Re-OCR not easily repeatable without original coords; just a placeholder
  // For now copy the latex back
  const r = state.results[i];
  if (!r) return;
  state.results.splice(i, 1);
  renderResults();
}

function showLoading(msg) {
  let el = $('loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loading';
    document.body.appendChild(el);
  }
  el.textContent = msg || 'Loading...';
  el.style.display = 'block';
}

function hideLoading() {
  const el = $('loading');
  if (el) el.style.display = 'none';
}

window.addEventListener('resize', () => {
  if (state.pdfLoaded) resizeCanvas();
});

loadBackends();
