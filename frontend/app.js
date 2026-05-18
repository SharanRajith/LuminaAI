/* ── Centralised State ── */
const state = {
  mode: 'presentation',
  theme: 'dark',
  presData: null,
  slide: 0,
  notesVisible: false,
  user: null,
};

const API = window.LUMINA_API_URL || 'http://localhost:8000';
let supabaseClient = null;
let loadingTimer = null;

/* ── Offline Detection ── */
function syncOnlineStatus() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  banner.hidden = navigator.onLine;
}
window.addEventListener('online',  syncOnlineStatus);
window.addEventListener('offline', syncOnlineStatus);
syncOnlineStatus();

/* ── Screen Router ── */
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + name);
  if (el) el.classList.add('active');
  // Hide main navbar in immersive screens; show it everywhere else
  const navbar = document.getElementById('navbar');
  if (navbar) navbar.style.display = (name === 'presentation' || name === 'report') ? 'none' : '';
  window.scrollTo(0, 0);
}

function navigateToCreate() {
  showScreen(state.user ? 'create' : 'auth');
}

/* ── Mode & Theme ── */
function setMode(mode) {
  state.mode = mode;
  const presBtn = document.getElementById('mode-pres');
  const repBtn  = document.getElementById('mode-rep');
  presBtn.classList.toggle('active', mode === 'presentation');
  repBtn.classList.toggle('active',  mode === 'report');
  presBtn.setAttribute('aria-pressed', String(mode === 'presentation'));
  repBtn.setAttribute('aria-pressed',  String(mode === 'report'));
  document.getElementById('pres-options').style.display = mode === 'presentation' ? '' : 'none';
  document.getElementById('rep-options').style.display  = mode === 'report'       ? '' : 'none';
}

function selectTheme(el) {
  document.querySelectorAll('.theme-opt').forEach(o => {
    o.classList.remove('active');
    o.setAttribute('aria-checked', 'false');
  });
  el.classList.add('active');
  el.setAttribute('aria-checked', 'true');
  state.theme = el.dataset.theme;
}

/* ── Character Counter ── */
function updateCharCount(textarea) {
  const counter = document.getElementById('char-count');
  if (!counter) return;
  const len = textarea.value.length;
  counter.textContent = `${len} / 5000`;
  counter.classList.toggle('char-count--warn', len > 4500);
}

/* ── Input Validation ── */
function validatePrompt(topic) {
  if (topic.length < 5)    return 'Prompt must be at least 5 characters.';
  if (topic.length > 5000) return 'Prompt must be 5000 characters or fewer.';
  return null;
}

/* ── Document Upload ── */
async function handleUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const statusEl = document.getElementById('upload-status');
  statusEl.textContent = 'Uploading…';
  const form = new FormData();
  form.append('file', file);
  try {
    const res  = await fetch(`${API}/upload/document`, { method: 'POST', body: form });
    const data = await res.json();
    if (data.text) {
      const topic = document.getElementById('topic');
      topic.value = (topic.value ? topic.value + '\n\n' : '') + data.text;
      updateCharCount(topic);
      statusEl.textContent = `✓ ${file.name} loaded`;
    } else {
      statusEl.textContent = '✗ No text extracted';
    }
  } catch {
    statusEl.textContent = '✗ Upload failed';
  }
}

/* ── Loading Animation ── */
function startLoading(type) {
  showScreen('loading');
  document.getElementById('loading-type').textContent = type;
  const bar      = document.getElementById('loading-bar');
  const progress = document.getElementById('loading-progress');
  bar.style.width = '0%';
  [0,1,2,3,4].forEach(i => { document.getElementById('lstep-' + i).className = 'lstep'; });

  let step = 0;
  const pcts = [10, 30, 55, 80, 95];
  document.getElementById('lstep-0').classList.add('active');
  bar.style.width = pcts[0] + '%';
  if (progress) progress.setAttribute('aria-valuenow', pcts[0]);

  loadingTimer = setInterval(() => {
    if (step > 0) document.getElementById('lstep-' + (step - 1)).className = 'lstep done';
    step++;
    if (step >= 5) { clearInterval(loadingTimer); return; }
    document.getElementById('lstep-' + step).classList.add('active');
    bar.style.width = pcts[step] + '%';
    if (progress) progress.setAttribute('aria-valuenow', pcts[step]);
  }, 1800);
}

function finishLoading() {
  clearInterval(loadingTimer);
  const bar      = document.getElementById('loading-bar');
  const progress = document.getElementById('loading-progress');
  bar.style.width = '100%';
  if (progress) progress.setAttribute('aria-valuenow', 100);
  [0,1,2,3,4].forEach(i => { document.getElementById('lstep-' + i).className = 'lstep done'; });
}

/* ── Generate ── */
async function generate() {
  const topicEl = document.getElementById('topic');
  const topic   = topicEl.value.trim();
  const errEl   = document.getElementById('create-error');
  errEl.style.display = 'none';

  function showErr(msg) { errEl.textContent = msg; errEl.style.display = 'block'; topicEl.focus(); }

  const validationError = validatePrompt(topic);
  if (validationError) { showErr(validationError); return; }

  if (!navigator.onLine) { showErr('You are offline. Please reconnect and try again.'); return; }

  const btn = document.getElementById('btn-generate');
  btn.disabled = true;

  const authHeader = {};
  if (supabaseClient) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session?.access_token) authHeader['Authorization'] = `Bearer ${session.access_token}`;
  }

  if (state.mode === 'presentation') {
    startLoading('presentation');
    try {
      const res = await fetch(`${API}/generate/presentation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          prompt:      topic,
          model_name:  'llama-3.3-70b-versatile',
          theme:       state.theme,
          slide_count: parseInt(document.getElementById('slide-count').value, 10),
          audience:    document.getElementById('audience').value,
          tone:        document.getElementById('tone').value,
        }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail || 'Server error'); }
      const data = await res.json();
      finishLoading();
      setTimeout(() => { renderPresentation(data); showScreen('presentation'); }, 600);
    } catch (e) {
      finishLoading();
      showScreen('create');
      showErr('Error: ' + e.message);
    }
  } else {
    startLoading('report');
    try {
      const res = await fetch(`${API}/generate/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          prompt:      topic,
          model_name:  'llama-3.3-70b-versatile',
          report_type: document.getElementById('report-type').value,
          tone:        document.getElementById('tone').value,
          length:      document.getElementById('report-length').value,
        }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail || 'Server error'); }
      const data = await res.json();
      finishLoading();
      setTimeout(() => { renderReport(data); showScreen('report'); }, 600);
    } catch (e) {
      finishLoading();
      showScreen('create');
      showErr('Error: ' + e.message);
    }
  }

  btn.disabled = false;
}

/* ── Render Presentation ── */
function renderPresentation(data) {
  state.presData = data;
  state.slide    = 0;
  const theme    = data.theme || state.theme;
  document.getElementById('pres-title').textContent = data.title || 'Presentation';

  const wrap = document.getElementById('slide-wrap');
  wrap.className = 'slide-wrap theme-' + theme;
  wrap.innerHTML = '';

  const slides = data.slides || [];
  slides.forEach((sd, i) => {
    const div        = document.createElement('div');
    div.className    = 'slide' + (i === 0 ? ' active' : '');
    div.dataset.notes    = sd.notes || '';
    div.dataset.slideIdx = i;
    div.setAttribute('role', 'tabpanel');
    div.setAttribute('aria-label', `Slide ${i + 1}: ${sd.title || ''}`);
    div.innerHTML    = buildSlideHTML(sd, i);
    wrap.appendChild(div);
  });

  // Load AI images for every slide asynchronously
  loadSlideImages(slides);

  const dots = document.getElementById('slide-dots');
  dots.innerHTML = '';
  slides.forEach((_, i) => {
    const d = document.createElement('button');
    d.className = 'dot' + (i === 0 ? ' active' : '');
    d.setAttribute('role', 'tab');
    d.setAttribute('aria-label', `Go to slide ${i + 1}`);
    d.setAttribute('aria-selected', String(i === 0));
    d.onclick = () => goToSlide(i);
    dots.appendChild(d);
  });

  updateSlideCounter();
  updateNotes();
}

function loadSlideImages(slides, startIdx = 0) {
  slides.forEach((sd, i) => {
    const idx = startIdx + i;
    const topic = sd.title || sd.quote || '';
    if (!topic) return;
    const imgEl = document.getElementById(`slide-img-${idx}`);
    if (!imgEl) return;

    const keyword  = encodeURIComponent(topic.split(' ').slice(0, 3).join(' '));
    const aiPrompt = encodeURIComponent(`${topic}, professional photography, cinematic lighting, 4k`);

    // Step 1 — instant stock photo from Unsplash
    const stockUrl = `https://source.unsplash.com/1280x720/?${keyword}`;
    imgEl.onload  = () => imgEl.classList.add('loaded');
    imgEl.onerror = () => imgEl.classList.add('loaded');
    imgEl.src = stockUrl;

    // Step 2 — swap to Pollinations AI image when ready (~10-15s)
    const aiUrl = `https://image.pollinations.ai/prompt/${aiPrompt}?width=1280&height=720&nologo=true&seed=${idx}`;
    const aiImg = new Image();
    aiImg.onload = () => {
      imgEl.style.transition = 'opacity .6s ease';
      imgEl.style.opacity = '0';
      setTimeout(() => {
        imgEl.src = aiUrl;
        imgEl.style.opacity = '1';
      }, 300);
    };
    aiImg.src = aiUrl;
  });
}

function buildSlideHTML(sd, idx) {
  const type = sd.type || 'content';
  const pos  = sd.image_position || 'right';

  // ── Per-slide action controls (hover overlay) ──
  const controls = `
    <div class="slide-controls">
      <button class="slide-ctrl-btn" onclick="regenerateSlide(${idx})" title="Regenerate slide">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
        Regenerate
      </button>
      <button class="slide-ctrl-btn" onclick="swapSlideImage(${idx})" title="New image">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        New Image
      </button>
    </div>`;

  // ── Image helpers ──
  const imgFull = `
    <div class="slide-bg-wrap">
      <img class="slide-bg-img" id="slide-img-${idx}" alt="">
      <div class="slide-overlay${type === 'quote' ? ' slide-overlay--heavy' : type === 'stats' ? ' slide-overlay--medium' : ''}"></div>
    </div>`;

  const imgPanel = (side) => `
    <div class="slide-img-col slide-img-col--${side}" onclick="swapSlideImage(${idx})" title="Click for new image">
      <img class="slide-panel-img" id="slide-img-${idx}" alt="${esc(sd.title || '')}">
      <div class="slide-img-shimmer"></div>
      <div class="slide-img-swap-hint">Click for new image</div>
    </div>`;

  // ── Content by type ──
  let inner = '';
  if (type === 'title') {
    inner = `
      <div class="slide-title-text" data-field="title">${esc(sd.title || '')}</div>
      ${sd.subtitle ? `<div class="slide-subtitle-text" data-field="subtitle">${esc(sd.subtitle)}</div>` : ''}`;
  } else if (type === 'quote') {
    inner = `
      <div class="slide-quote-mark" aria-hidden="true">"</div>
      <p class="slide-quote-text" data-field="quote">${esc(sd.quote || '')}</p>
      ${sd.author ? `<div class="slide-quote-author" data-field="author">— ${esc(sd.author)}</div>` : ''}`;
  } else if (type === 'stats') {
    const stats = (sd.stats || []).map(s => `
      <div class="stat-box">
        <div class="stat-val">${esc(s.value || '')}</div>
        <div class="stat-lbl">${esc(s.label || '')}</div>
        <div class="stat-desc">${esc(s.description || '')}</div>
      </div>`).join('');
    inner = `
      <div class="slide-heading" data-field="title">${esc(sd.title || 'Key Statistics')}</div>
      <div class="slide-accent-bar" aria-hidden="true"></div>
      <div class="slide-stats-grid">${stats}</div>`;
  } else {
    const items   = sd.bullets || sd.items || (sd.caption ? [sd.caption] : []);
    const bullets = items.map((b, bi) =>
      `<li><div class="slide-bullet-dot" aria-hidden="true"></div><span data-field="bullet" data-bullet-idx="${bi}">${esc(b)}</span></li>`
    ).join('');
    inner = `
      <div class="slide-heading" data-field="title">${esc(sd.title || '')}</div>
      <div class="slide-accent-bar" aria-hidden="true"></div>
      ${bullets ? `<ul class="slide-bullets">${bullets}</ul>` : ''}
      ${sd.caption && !items.length ? `<div class="slide-caption" data-field="caption">${esc(sd.caption)}</div>` : ''}`;
  }

  // ── Assemble by image_position ──
  if (pos === 'none') {
    return `${controls}<div class="slide-text-col slide-text-col--full">${inner}</div>`;
  }
  if (pos === 'full') {
    return `${controls}${imgFull}<div class="slide-center-content">${inner}</div>`;
  }
  const textCol = `<div class="slide-text-col">${inner}</div>`;
  return pos === 'left'
    ? `${controls}${imgPanel('left')}${textCol}`
    : `${controls}${textCol}${imgPanel('right')}`;
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Slide Navigation ── */
function goToSlide(n) {
  const slides = document.querySelectorAll('#slide-wrap .slide');
  const dots   = document.querySelectorAll('#slide-dots .dot');
  if (n < 0 || n >= slides.length) return;
  slides[state.slide].classList.remove('active');
  dots[state.slide]?.classList.remove('active');
  dots[state.slide]?.setAttribute('aria-selected', 'false');
  state.slide = n;
  slides[state.slide].classList.add('active');
  dots[state.slide]?.classList.add('active');
  dots[state.slide]?.setAttribute('aria-selected', 'true');
  updateSlideCounter();
  updateNotes();
}

function nextSlide() { goToSlide(state.slide + 1); }
function prevSlide() { goToSlide(state.slide - 1); }

function updateSlideCounter() {
  const total = document.querySelectorAll('#slide-wrap .slide').length;
  document.getElementById('slide-counter').textContent = `${state.slide + 1} / ${total}`;
}

function updateNotes() {
  const slide = document.querySelector('#slide-wrap .slide.active');
  document.getElementById('notes-body').textContent = slide?.dataset.notes || 'No speaker notes for this slide.';
}

function toggleNotes() {
  state.notesVisible = !state.notesVisible;
  const panel  = document.getElementById('notes-panel');
  const toggle = document.getElementById('notes-toggle');
  panel.style.display = state.notesVisible ? 'block' : 'none';
  toggle.setAttribute('aria-pressed', String(state.notesVisible));
  toggle.style.background = state.notesVisible ? 'rgba(108,99,255,.3)' : '';
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.getElementById('screen-presentation').requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
}

/* ── Edit Mode ── */
let editMode = false;

function toggleEditMode() {
  editMode ? exitEditMode() : enterEditMode();
}

function enterEditMode() {
  editMode = true;
  document.querySelectorAll('[data-field]').forEach(el => {
    el.contentEditable = 'true';
    el.classList.add('editable');
  });
  const btn = document.getElementById('edit-mode-btn');
  btn.textContent = '✓ Done';
  btn.style.background = 'rgba(0,200,100,.25)';
  btn.style.color = '#00c864';
}

function exitEditMode() {
  editMode = false;
  document.querySelectorAll('[data-field]').forEach(el => {
    el.contentEditable = 'false';
    el.classList.remove('editable');
    const slideDiv = el.closest('[data-slide-idx]');
    if (!slideDiv || !state.presData) return;
    const idx   = parseInt(slideDiv.dataset.slideIdx);
    const slide = state.presData.slides?.[idx];
    if (!slide) return;
    const field = el.dataset.field;
    if (field === 'bullet') {
      const bi  = parseInt(el.dataset.bulletIdx);
      const arr = slide.bullets || slide.items || [];
      arr[bi]   = el.textContent.trim();
    } else if (field === 'author') {
      slide.author = el.textContent.replace(/^—\s*/, '').trim();
    } else {
      slide[field] = el.textContent.trim();
    }
  });
  const btn = document.getElementById('edit-mode-btn');
  btn.textContent = 'Edit';
  btn.style.background = '';
  btn.style.color = '';
}

/* ── Regenerate Single Slide ── */
async function regenerateSlide(idx) {
  if (!state.presData) return;
  const slide    = state.presData.slides?.[idx];
  const slideDiv = document.querySelector(`[data-slide-idx="${idx}"]`);
  if (!slide || !slideDiv) return;

  slideDiv.classList.add('slide-loading');
  try {
    const res = await fetch(`${API}/generate/slide`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        presentation_title: state.presData.title || '',
        slide_type:         slide.type || 'content',
        topic:              slide.title || slide.quote || state.presData.title,
        tone:               state.presData.tone || 'professional',
        audience:           state.presData.audience || 'general',
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const newSlide = await res.json();
    newSlide.notes = slide.notes; // preserve original notes
    state.presData.slides[idx] = newSlide;
    slideDiv.dataset.notes = newSlide.notes || '';
    slideDiv.innerHTML = buildSlideHTML(newSlide, idx);
    loadSlideImages([newSlide], idx);
  } catch (e) {
    alert('Regeneration failed: ' + e.message);
  } finally {
    slideDiv.classList.remove('slide-loading');
  }
}

/* ── Swap Slide Image ── */
function swapSlideImage(idx) {
  const imgEl = document.getElementById(`slide-img-${idx}`);
  if (!imgEl) return;
  const slide   = state.presData?.slides?.[idx];
  const topic   = slide?.title || slide?.quote || '';
  const newSeed = Math.floor(Math.random() * 9999);
  const encoded = encodeURIComponent(`${topic}, professional photography, cinematic lighting, 4k`);
  imgEl.classList.remove('loaded');
  imgEl.src = `https://image.pollinations.ai/prompt/${encoded}?width=1280&height=720&nologo=true&seed=${newSeed}`;
  imgEl.onload  = () => imgEl.classList.add('loaded');
}

/* ── PDF Export ── */
async function exportPDF() {
  if (!state.presData) return;
  const btn = document.querySelector('[aria-label="Export as PDF"]');
  if (btn) { btn.textContent = 'Exporting…'; btn.disabled = true; }

  try {
    const { jsPDF } = window.jspdf;
    const pdf    = new jsPDF({ orientation: 'landscape', unit: 'px', format: [1280, 720] });
    const slides = document.querySelectorAll('#slide-wrap .slide');
    const active = state.slide;

    for (let i = 0; i < slides.length; i++) {
      slides[i].classList.add('active');
      if (i > 0) slides[i - 1].classList.remove('active');
      await new Promise(r => setTimeout(r, 120)); // let paint settle
      const canvas = await html2canvas(slides[i], { scale: 1, useCORS: true, logging: false });
      if (i > 0) pdf.addPage();
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 1280, 720);
    }

    // restore original active slide
    slides.forEach((s, i) => s.classList.toggle('active', i === active));
    pdf.save(`${state.presData.title || 'lumina'}.pdf`);
  } catch (e) {
    alert('PDF export failed: ' + e.message);
  } finally {
    if (btn) { btn.textContent = 'PDF'; btn.disabled = false; }
  }
}

/* ── PPTX Export ── */
async function exportPPTX() {
  if (!state.presData) return;
  const btn = document.querySelector('.tb-right .tb-btn[aria-label="Export presentation as PowerPoint file"]');
  if (btn) { btn.textContent = 'Exporting…'; btn.disabled = true; }
  try {
    const res = await fetch(`${API}/export/pptx`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ presentation_data: state.presData }),
    });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'lumina_presentation.pptx'; a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Export error: ' + e.message);
  }
  if (btn) {
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export PPTX';
    btn.disabled = false;
  }
}

/* ── Render Report ── */
function renderReport(data) {
  window._reportData = data;
  const toc      = document.getElementById('report-toc');
  const sections = data.sections || [];
  toc.innerHTML  = `<div class="toc-title">Contents</div>
    <div class="toc-item" onclick="scrollToSection('exec-summary')">Executive Summary</div>
    ${data.key_highlights?.length ? '<div class="toc-item" onclick="scrollToSection(\'highlights\')">Key Highlights</div>' : ''}
    ${sections.map((s, i) => `<div class="toc-item" onclick="scrollToSection('sec-${i}')">${esc(s.heading || 'Section ' + (i+1))}</div>`).join('')}
    <div class="toc-item" onclick="scrollToSection('conclusion')">Conclusion</div>
    ${data.recommendations?.length ? '<div class="toc-item" onclick="scrollToSection(\'recommendations\')">Recommendations</div>' : ''}
  `;

  const body    = document.getElementById('report-body');
  body.innerHTML = `
    <div class="report-meta">
      <div class="report-type-badge">${esc(data.report_type || 'Report')}</div>
      <h1 class="report-main-title">${esc(data.title || 'Report')}</h1>
      ${data.subtitle ? `<p class="report-subtitle">${esc(data.subtitle)}</p>` : ''}
      <div class="report-date">${esc(data.date || '')}</div>
    </div>

    <div id="exec-summary" class="exec-summary">
      <div class="exec-label">Executive Summary</div>
      <p class="exec-text">${esc(data.executive_summary || '')}</p>
    </div>

    ${data.key_highlights?.length ? `
    <div id="highlights" class="highlights-grid">
      ${data.key_highlights.map(h => `
        <div class="highlight-card">
          <div class="hl-value">${esc(h.value || '')}</div>
          <div class="hl-label">${esc(h.label || '')}</div>
        </div>`).join('')}
    </div>` : ''}

    ${sections.map((s, i) => `
    <div id="sec-${i}" class="report-section">
      <div class="section-heading">
        <div class="section-num" aria-hidden="true">${i + 1}</div>
        ${esc(s.heading || '')}
      </div>
      <div class="section-content">${esc(s.content || '')}</div>
      ${s.key_points?.length ? `
        <ul class="section-keypoints">
          ${s.key_points.map(p => `<li>${esc(p)}</li>`).join('')}
        </ul>` : ''}
      ${s.subsections?.length ? s.subsections.map(sub => `
        <div class="subsection">
          <div class="subsection-heading">${esc(sub.heading || '')}</div>
          <div class="subsection-content">${esc(sub.content || '')}</div>
        </div>`).join('') : ''}
    </div>`).join('')}

    ${data.conclusion ? `
    <div id="conclusion" class="report-conclusion">
      <div class="report-conclusion-label">Conclusion</div>
      <p>${esc(data.conclusion)}</p>
    </div>` : ''}

    ${data.recommendations?.length ? `
    <div id="recommendations" class="recommendations">
      <div class="rec-title">Recommendations</div>
      <ul class="rec-list">
        ${data.recommendations.map((r, i) => `
          <li>
            <div class="rec-num" aria-hidden="true">${i + 1}</div>
            <span>${esc(r)}</span>
          </li>`).join('')}
      </ul>
    </div>` : ''}
  `;
}

function scrollToSection(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.querySelectorAll('.toc-item').forEach(el => el.classList.remove('active'));
}

/* ── Report PDF (LaTeX compiled) ── */
async function exportReportPDF() {
  if (!window._reportData) { alert('No report loaded.'); return; }
  const btn = document.getElementById('report-pdf-btn');
  if (btn) { btn.textContent = 'Compiling…'; btn.disabled = true; }
  try {
    const res = await fetch(`${API}/export/report-pdf`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ presentation_data: window._reportData }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err);
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = (window._reportData.title || 'report').replace(/\s+/g, '_') + '.pdf';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('PDF compilation failed: ' + e.message);
  } finally {
    if (btn) { btn.textContent = 'PDF'; btn.disabled = false; }
  }
}

/* ── LaTeX Source Export ── */
async function exportReportLatex() {
  if (!window._reportData) { alert('No report loaded.'); return; }
  const btn = document.querySelector('[aria-label="Download LaTeX source"]');
  if (btn) { btn.textContent = 'Exporting…'; btn.disabled = true; }
  try {
    const res = await fetch(`${API}/export/report-latex`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ presentation_data: window._reportData }),
    });
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = (window._reportData.title || 'report').replace(/\s+/g, '_') + '.tex';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('LaTeX export failed: ' + e.message);
  } finally {
    if (btn) { btn.innerHTML = 'LaTeX'; btn.disabled = false; }
  }
}

/* ── Word DOCX Export ── */
async function exportReportDocx() {
  if (!window._reportData) { alert('No report loaded.'); return; }
  const btn = document.getElementById('report-docx-btn');
  if (btn) { btn.querySelector('.tb-label').textContent = 'Exporting…'; btn.disabled = true; }
  try {
    const res = await fetch(`${API}/export/report-docx`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ presentation_data: window._reportData }),
    });
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = (window._reportData.title || 'report').replace(/\s+/g, '_') + '.docx';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Word export failed: ' + e.message);
  } finally {
    if (btn) { btn.querySelector('.tb-label').textContent = 'Word'; btn.disabled = false; }
  }
}

/* ── Touch Swipe (slides) ── */
(function initTouchSwipe() {
  let startX = 0;
  document.addEventListener('touchstart', e => {
    if (!document.getElementById('screen-presentation').classList.contains('active')) return;
    startX = e.touches[0].clientX;
  }, { passive: true });
  document.addEventListener('touchend', e => {
    if (!document.getElementById('screen-presentation').classList.contains('active')) return;
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 50) dx > 0 ? prevSlide() : nextSlide();
  }, { passive: true });
})();

/* ── Keyboard Nav ── */
document.addEventListener('keydown', e => {
  if (!document.getElementById('screen-presentation').classList.contains('active')) return;
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); nextSlide(); }
  if (e.key === 'ArrowLeft')                    { e.preventDefault(); prevSlide(); }
  if (e.key === 'Escape')                        showScreen('create');
  if (e.key === 'n' || e.key === 'N')            toggleNotes();
  if (e.key === 'f' || e.key === 'F')            toggleFullscreen();
});

/* ── Supabase & Auth ── */
const _sc = window.SUPABASE_CONFIG;
if (_sc && _sc.url && !_sc.url.includes('your-project-id')) {
  supabaseClient = window.supabase.createClient(_sc.url, _sc.anonKey);

  // Restore session on page load
  supabaseClient.auth.getSession().then(({ data: { session } }) => {
    if (session) {
      state.user = session.user;
      updateNavForUser(true);
    }
  });

  // Keep UI in sync on sign-in / sign-out / token refresh
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    state.user = session?.user || null;
    updateNavForUser(!!state.user);
    if (state.user && document.getElementById('screen-auth').classList.contains('active')) {
      showScreen('create');
    }
  });
}

function updateNavForUser(isLoggedIn) {
  const libBtn   = document.getElementById('nav-library');
  const loginBtn = document.getElementById('nav-login');
  if (isLoggedIn) {
    libBtn.style.display  = 'block';
    loginBtn.textContent  = 'Sign Out';
    loginBtn.onclick      = handleSignOut;
  } else {
    libBtn.style.display  = 'none';
    loginBtn.textContent  = 'Login / Sign Up';
    loginBtn.onclick      = () => showScreen('auth');
  }
}

async function handleSignOut() {
  if (supabaseClient) {
    await supabaseClient.auth.signOut();
    showScreen('home');
  }
}

async function handleAuth() {
  if (!supabaseClient) return;
  const email    = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const errEl    = document.getElementById('auth-error');
  errEl.style.display = 'none';

  if (!email || !password) {
    errEl.textContent   = 'Please enter email and password.';
    errEl.style.display = 'block';
    return;
  }

  try {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
  } catch (err) {
    errEl.textContent   = err.message;
    errEl.style.display = 'block';
  }
}

async function handleSignup() {
  if (!supabaseClient) return;
  const firstName       = document.getElementById('signup-first-name').value.trim();
  const lastName        = document.getElementById('signup-last-name').value.trim();
  const email           = document.getElementById('signup-email').value.trim();
  const password        = document.getElementById('signup-password').value;
  const confirmPassword = document.getElementById('signup-confirm-password').value;
  const errEl           = document.getElementById('signup-error');
  const successEl       = document.getElementById('signup-success');
  errEl.style.display     = 'none';
  successEl.style.display = 'none';

  if (!firstName || !lastName || !email || !password || !confirmPassword) {
    errEl.textContent   = 'Please fill in all fields.';
    errEl.style.display = 'block';
    return;
  }
  if (password !== confirmPassword) {
    errEl.textContent   = 'Passwords do not match.';
    errEl.style.display = 'block';
    return;
  }
  if (password.length < 8) {
    errEl.textContent   = 'Password must be at least 8 characters.';
    errEl.style.display = 'block';
    return;
  }

  try {
    const { error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        data: { first_name: firstName, last_name: lastName },
        emailRedirectTo: window.location.origin + window.location.pathname,
      },
    });
    if (error) throw error;
    successEl.textContent   = 'Account created! Check your email to confirm, then log in.';
    successEl.style.display = 'block';
  } catch (err) {
    errEl.textContent   = err.message;
    errEl.style.display = 'block';
  }
}

async function handleOAuthLogin(provider) {
  if (!supabaseClient) return;
  try {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (error) throw error;
  } catch (err) {
    const errEl       = document.getElementById('auth-error');
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

/* ── Library ── */
async function loadLibrary() {
  if (!supabaseClient || !state.user) return;
  const grid    = document.getElementById('library-grid');
  grid.innerHTML = '<div style="color:rgba(255,255,255,0.5);">Loading your presentations…</div>';

  try {
    const { data, error } = await supabaseClient
      .from('creations')
      .select('*')
      .eq('user_id', state.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    if (!data || data.length === 0) {
      grid.innerHTML = '<div style="color:rgba(255,255,255,0.5);">Your library is empty.</div>';
      return;
    }

    grid.innerHTML = data.map(item => `
      <div class="lib-card" onclick="openFromLibrary('${item.id}', '${item.type}')" role="listitem">
        <div class="lib-card-type">${item.type}</div>
        <h3>${esc(item.title || 'Untitled')}</h3>
        <p>${esc(item.summary || '')}</p>
        <div class="lib-card-meta">
          <span>${new Date(item.created_at).toLocaleDateString()}</span>
        </div>
        <div class="lib-card-actions" onclick="event.stopPropagation()">
          <button class="lib-btn" aria-label="Delete this item" onclick="deleteFromLibrary('${item.id}')">✕</button>
        </div>
      </div>
    `).join('');
  } catch {
    grid.innerHTML = '<div style="color:#ff6584;">Could not load library. Ensure the "creations" table exists in your Supabase project.</div>';
  }
}

async function deleteFromLibrary(id) {
  if (!supabaseClient) return;
  if (!confirm('Delete this item?')) return;
  try {
    await supabaseClient.from('creations').delete().eq('id', id);
    loadLibrary();
  } catch {
    alert('Error deleting item.');
  }
}

async function openFromLibrary(id, type) {
  if (!supabaseClient) return;
  try {
    const { data, error } = await supabaseClient
      .from('creations')
      .select('output')
      .eq('id', id)
      .single();
    if (error) throw error;
    if (!data?.output) {
      alert('This item was saved before output storage was enabled. Please regenerate it.');
      return;
    }
    if (type === 'presentation') {
      renderPresentation(data.output);
      showScreen('presentation');
    } else {
      renderReport(data.output);
      showScreen('report');
    }
  } catch (e) {
    alert('Could not load item: ' + e.message);
  }
}
