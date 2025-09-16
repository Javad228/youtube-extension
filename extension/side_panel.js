import './util.js';

const state = {
  tabId: undefined,
  moments: [],
  filters: new Set(),
  minConfidence: 0,
  status: 'idle',
};

const DEBUG_PREFIX = '[YT Moments:Panel]';

function debugLog(...args) {
  try {
    console.debug(DEBUG_PREFIX, ...args);
  } catch (_) {}
}

const EMOTIONS = ["funny","sad","wholesome","insightful","angry","wtf"];
const EMOTION_EMOJI = {
  funny: '😂',
  sad: '😢',
  wholesome: '😊',
  insightful: '💡',
  angry: '😡',
  wtf: '🤯',
};

function decodeText(text) {
  try {
    if (typeof Util !== 'undefined' && typeof Util.decodeHtmlEntities === 'function') {
      return Util.decodeHtmlEntities(text || '');
    }
  } catch (_) {}
  return text || '';
}

async function getActiveTabId() {
  debugLog('Requesting active tab ID from background.');
  const res = await chrome.runtime.sendMessage({ type: 'getActiveTabId' });
  debugLog('Received active tab ID response.', res);
  return res?.tabId;
}

function renderFilters() {
  debugLog('Rendering emotion filter checkboxes.', { activeFilters: Array.from(state.filters) });
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
  debugLog('Rendering moments list.', {
    total: state.moments.length,
    filters: Array.from(activeFilters),
    minConfidence: confMin,
  });
  for (const m of state.moments) {
    if (!activeFilters.has(m.emotion)) continue;
    if ((m.confidence ?? 0) < confMin) continue;
    const item = document.createElement('div');
    item.className = 'sp-item';
    const mins = Math.floor(m.start / 60);
    const secs = Math.floor(m.start % 60).toString().padStart(2, '0');
    const ts = `${mins}:${secs}`;
    const emoji = EMOTION_EMOJI[m.emotion] || '🎬';

    const row = document.createElement('div');
    row.className = 'row';
    const dot = document.createElement('span');
    dot.className = `dot ${m.emotion}`;
    row.appendChild(dot);
    const titleEl = document.createElement('strong');
    titleEl.textContent = `${emoji} ${m.title || 'Moment'}`;
    row.appendChild(titleEl);
    const timeEl = document.createElement('span');
    timeEl.style.marginLeft = 'auto';
    timeEl.style.color = '#666';
    timeEl.textContent = ts;
    row.appendChild(timeEl);
    item.appendChild(row);

    const clusterMeta = document.createElement('div');
    clusterMeta.className = 'cluster-meta';
    const count = m.clusterSize ?? 1;
    const totalLikes = m.totalLikes ?? m.likes ?? 0;
    const parts = [];
    parts.push(`${count} comment${count === 1 ? '' : 's'}`);
    parts.push(`${totalLikes} like${totalLikes === 1 ? '' : 's'}`);
    clusterMeta.textContent = parts.join(' • ');
    item.appendChild(clusterMeta);

    const authorBits = [];
    if (m.anchorAuthor) authorBits.push(decodeText(m.anchorAuthor));
    if (m.anchorLikes) {
      authorBits.push(`${m.anchorLikes} like${m.anchorLikes === 1 ? '' : 's'}`);
    }
    if (authorBits.length) {
      const authorEl = document.createElement('div');
      authorEl.className = 'comment-author';
      authorEl.textContent = authorBits.join(' • ');
      item.appendChild(authorEl);
    }

    const commentEl = document.createElement('div');
    commentEl.className = 'comment-snippet';
    commentEl.textContent = decodeText(m.comment || '');
    item.appendChild(commentEl);

    if (Array.isArray(m.sampleComments) && m.sampleComments.length) {
      const samplesEl = document.createElement('ul');
      samplesEl.className = 'sample-comments';
      for (const sample of m.sampleComments) {
        const li = document.createElement('li');
        li.textContent = decodeText(sample);
        samplesEl.appendChild(li);
      }
      item.appendChild(samplesEl);
    }

    const actions = document.createElement('div');
    actions.className = 'sp-actions';
    const button = document.createElement('button');
    button.dataset.act = 'seek';
    button.textContent = 'Play';
    actions.appendChild(button);
    if (m.reason) {
      const reason = document.createElement('span');
      reason.className = 'reason';
      reason.textContent = m.reason;
      actions.appendChild(reason);
    }
    item.appendChild(actions);

    button.addEventListener('click', async () => {
      try {
        debugLog('Play button clicked for moment.', { start: m.start });
        await chrome.tabs.sendMessage(state.tabId, { type: 'seek', time: m.start });
      } catch (err) {
        debugLog('Failed to send seek request.', err);
      }
    });
    list.appendChild(item);
  }
}

function setStatus(text) {
  debugLog('Updating status text.', { text });
  document.getElementById('status').textContent = text || '';
}

async function init() {
  debugLog('Initializing side panel script.');
  document.getElementById('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  state.tabId = await getActiveTabId();
  debugLog('Active tab ID resolved.', { tabId: state.tabId });
  renderFilters();
  const confSlider = document.getElementById('confSlider');
  const confVal = document.getElementById('confVal');
  confSlider.addEventListener('input', () => {
    state.minConfidence = Number(confSlider.value);
    confVal.textContent = confSlider.value;
    debugLog('Confidence slider changed.', { value: state.minConfidence });
    renderList();
  });

  setStatus('Waiting for comment analysis...');
  const statusEl = document.getElementById('status');
  const retryBtn = document.createElement('button');
  retryBtn.id = 'retryAnalyze';
  retryBtn.textContent = 'Retry';
  retryBtn.className = 'retry-button';
  retryBtn.addEventListener('click', async () => {
    try {
      debugLog('Retry button clicked.');
      await chrome.tabs.sendMessage(state.tabId, { type: 'triggerAnalyze' });
    } catch (err) {
      debugLog('Failed to request re-analysis from content script.', err);
    }
  });
  statusEl.parentElement?.insertBefore(retryBtn, statusEl.nextSibling);
  try {
    debugLog('Requesting existing moments from content script.');
    const res = await chrome.tabs.sendMessage(state.tabId, { type: 'getMoments' });
    if (res?.moments?.length) {
      debugLog('Received precomputed moments.', { count: res.moments.length });
      state.moments = res.moments;
      setStatus('');
      renderList();
    } else {
      debugLog('No moments returned immediately, triggering analysis.');
      setStatus('No moments yet. Loading...');
      await chrome.tabs.sendMessage(state.tabId, { type: 'triggerAnalyze' });
    }
  } catch (err) {
    debugLog('Failed to communicate with content script during init.', err);
    setStatus('Open a YouTube video page.');
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'momentsUpdated') {
      debugLog('Received momentsUpdated broadcast.', { count: msg.moments?.length || 0 });
      state.moments = msg.moments || [];
      setStatus('');
      renderList();
    }
    if (msg?.type === 'analysisStatus') {
      debugLog('Received analysis status update.', msg);
      state.status = msg.status;
      if (msg.status === 'noApiKey') setStatus('Add a YouTube API key in Options.');
      else if (msg.status === 'starting') setStatus('Analyzing comments…');
      else if (msg.status === 'noComments') setStatus('No top comments found.');
      else if (msg.status === 'noTimestamps') setStatus('No timestamped comments found yet.');
      else if (msg.status === 'done') setStatus(state.moments.length ? '' : 'No moments found for this video.');
    }
  });
}

init();


