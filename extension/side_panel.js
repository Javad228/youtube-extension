import './util.js';

const state = {
  tabId: undefined,
  moments: [],
  filters: new Set(),
  minConfidence: 0,
  status: 'idle',
};

const EMOTIONS = ["funny","sad","wholesome","insightful","angry","wtf"];

async function getActiveTabId() {
  const res = await chrome.runtime.sendMessage({ type: 'getActiveTabId' });
  return res?.tabId;
}

function renderFilters() {
  const filtersEl = document.getElementById('filters');
  filtersEl.innerHTML = '';
  for (const e of EMOTIONS) {
    const id = `f-${e}`;
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" id="${id}" ${state.filters.has(e) ? 'checked' : ''}/> <span class="dot ${e}"></span> ${e}`;
    label.querySelector('input').addEventListener('change', (ev) => {
      if (ev.target.checked) state.filters.add(e); else state.filters.delete(e);
      renderList();
    });
    filtersEl.appendChild(label);
  }
}

function renderList() {
  const list = document.getElementById('list');
  list.innerHTML = '';
  const confMin = state.minConfidence;
  const activeFilters = state.filters.size ? state.filters : new Set(EMOTIONS);
  for (const m of state.moments) {
    if (!activeFilters.has(m.emotion)) continue;
    if ((m.confidence ?? 0) < confMin) continue;
    const item = document.createElement('div');
    item.className = 'sp-item';
    const mins = Math.floor(m.start / 60);
    const secs = Math.floor(m.start % 60).toString().padStart(2, '0');
    const ts = `${mins}:${secs}`;
    item.innerHTML = `
      <div class="row">
        <span class="dot ${m.emotion}"></span>
        <strong>${m.title || 'Moment'}</strong>
        <span style="margin-left:auto;color:#666">${ts}</span>
      </div>
      <div style="margin-top:4px;color:#333">${m.comment || ''}</div>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button data-act="seek">Play</button>
        <span style="color:#666">${m.reason ? Util.decodeHtmlEntities(m.reason) : ''}</span>
      </div>
    `;
    item.querySelector('button[data-act="seek"]').addEventListener('click', async () => {
      try {
        await chrome.tabs.sendMessage(state.tabId, { type: 'seek', time: m.start });
      } catch (err) {}
    });
    list.appendChild(item);
  }
}

function setStatus(text) {
  document.getElementById('status').textContent = text || '';
}

async function init() {
  document.getElementById('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  state.tabId = await getActiveTabId();
  renderFilters();
  const confSlider = document.getElementById('confSlider');
  const confVal = document.getElementById('confVal');
  confSlider.addEventListener('input', () => {
    state.minConfidence = Number(confSlider.value);
    confVal.textContent = confSlider.value;
    renderList();
  });

  // Add a force fetch row
  const statusEl = document.getElementById('status');
  const force = document.createElement('div');
  force.style.marginTop = '6px';
  force.innerHTML = `
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <button id="forceEn">Force en</button>
      <button id="forceEnUS">Force en-US</button>
      <button id="forceAuto">Force auto (a.en)</button>
      <button id="forceAutoUS">Force auto (a.en-US)</button>
      <button id="retryAnalyze">Retry</button>
    </div>`;
  statusEl.parentElement?.appendChild(force);
  const sendForce = async (vssIds) => {
    try { await chrome.tabs.sendMessage(state.tabId, { type: 'forceFetchTranscript', vssIds }); } catch (e) {}
  };
  document.getElementById('forceEn').addEventListener('click', () => sendForce(['en']));
  document.getElementById('forceEnUS').addEventListener('click', () => sendForce(['en-US']));
  document.getElementById('forceAuto').addEventListener('click', () => sendForce(['a.en']));
  document.getElementById('forceAutoUS').addEventListener('click', () => sendForce(['a.en-US']));
  document.getElementById('retryAnalyze').addEventListener('click', async () => {
    await chrome.tabs.sendMessage(state.tabId, { type: 'triggerAnalyze' });
  });

  setStatus('Waiting for analysis...');
  try {
    const res = await chrome.tabs.sendMessage(state.tabId, { type: 'getMoments' });
    if (res?.moments?.length) {
      state.moments = res.moments;
      setStatus('');
      renderList();
    } else {
      setStatus('No moments yet. Loading...');
      await chrome.tabs.sendMessage(state.tabId, { type: 'triggerAnalyze' });
    }
  } catch (err) {
    setStatus('Open a YouTube video page.');
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'momentsUpdated') {
      state.moments = msg.moments || [];
      setStatus('');
      renderList();
    }
    if (msg?.type === 'analysisStatus') {
      state.status = msg.status;
      if (msg.status === 'noApiKey') setStatus('Add a YouTube API key in Options.');
      else if (msg.status === 'noTranscript') {
        const tracks = msg.tracks || {};
        const p = JSON.stringify(tracks.player || []);
        const l = JSON.stringify(tracks.list || []);
        const dbg = (typeof window !== 'undefined' && window.__MomentsTranscriptDebug) ? JSON.stringify(window.__MomentsTranscriptDebug) : '';
        setStatus(`No transcript available for this video. Tracks player=${p} list=${l} ${dbg ? ` debug=${dbg}` : ''}`);
      }
      else if (msg.status === 'starting') setStatus('Analyzing…');
      else if (msg.status === 'noComments') setStatus('No top comments found.');
      else if (msg.status === 'done') setStatus(state.moments.length ? '' : 'No moments found for this video.');
    }
  });
}

init();


