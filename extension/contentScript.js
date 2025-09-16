/* global Util */

const EMOTIONS = ["funny","sad","wholesome","insightful","angry","wtf"];
const EMOTION_EMOJI = {
  funny: '😂',
  sad: '😢',
  wholesome: '😊',
  insightful: '💡',
  angry: '😡',
  wtf: '🤯',
};

const DEBUG_PREFIX = '[YT Moments]';

function debugLog(...args) {
  try {
    console.debug(DEBUG_PREFIX, ...args);
  } catch (_) {}
}

const state = {
  videoId: null,
  comments: [],
  moments: [],
  processing: false,
};

function injectInpageBridge() {
  try {
    debugLog('Injecting inpage bridge script.');
    const url = chrome.runtime.getURL('inpageBridge.js');
    const s = document.createElement('script');
    s.src = url;
    s.async = false;
    (document.documentElement || document.head || document.body).appendChild(s);
    s.addEventListener('load', () => s.remove());
    debugLog('Injected inpage bridge script.');
  } catch (e) {
    debugLog('Failed to inject inpage bridge script.', e);
  }
}

const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

async function loadCachedMoments(videoId) {
  try {
    debugLog('Attempting to load cached moments.', { videoId });
    const key = `moments:${videoId}`;
    const res = await chrome.storage.local.get([key]);
    const payload = res[key];
    if (!payload) return null;
    if ((Date.now() - (payload.savedAt || 0)) > CACHE_TTL_MS) return null;
    return payload.data || null;
  } catch (err) {
    debugLog('Failed to load cached moments.', err);
    return null;
  }
}

async function saveCachedMoments(videoId, data) {
  try {
    debugLog('Saving cached moments.', { videoId, count: Array.isArray(data) ? data.length : 0 });
    const key = `moments:${videoId}`;
    await chrome.storage.local.set({ [key]: { savedAt: Date.now(), data } });
  } catch (err) {
    debugLog('Failed to save cached moments.', err);
  }
}

function findPlayerRoot() {
  const root = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
  return root || document.body;
}

function ensureOverlay() {
  const player = findPlayerRoot();
  if (!player) return null;
  let overlay = player.querySelector('.yt-moments-overlay');
  if (!overlay) {
    debugLog('Creating overlay on player.');
    overlay = document.createElement('div');
    overlay.className = 'yt-moments-overlay';
    overlay.style.position = 'absolute';
    overlay.style.left = '0';
    overlay.style.right = '0';
    overlay.style.bottom = '0';
    overlay.style.height = '14px';
    player.appendChild(overlay);
    // Ensure player is positioned
    const style = getComputedStyle(player);
    if (style.position === 'static') {
      player.style.position = 'relative';
    }
  } else {
    debugLog('Reusing existing overlay element.');
  }
  return overlay;
}

function renderMarkers() {
  const overlay = ensureOverlay();
  if (!overlay) return;
  overlay.innerHTML = '';
  const duration = document.querySelector('video')?.duration || 0;
  if (!duration) return;
  debugLog('Rendering markers onto overlay.', { duration, count: state.moments.length });
  for (const m of state.moments) {
    const leftPct = Math.max(0, Math.min(100, (m.start / duration) * 100));
    const el = document.createElement('div');
    el.className = 'marker';
    el.dataset.emotion = m.emotion || 'insightful';
    el.style.left = `${leftPct}%`;
    el.title = `${m.title || 'Moment'} (${Math.round(m.start)}s)`;
    const emoji = EMOTION_EMOJI[m.emotion] || '🎬';
    el.textContent = emoji;
    el.addEventListener('click', () => {
      const video = document.querySelector('video');
      if (video) video.currentTime = m.start;
    });
    overlay.appendChild(el);
  }
}

function postMomentsUpdate() {
  debugLog('Posting moments update to runtime.', { count: state.moments.length });
  chrome.runtime.sendMessage({ type: 'momentsUpdated', moments: state.moments });
}

function postStatus(status, extra = {}) {
  debugLog('Posting analysis status.', { status, ...extra });
  chrome.runtime.sendMessage({ type: 'analysisStatus', status, ...extra });
}

async function getApiKey() {
  const { ytApiKey } = await chrome.storage.local.get(['ytApiKey']);
  return ytApiKey || '';
}

async function fetchTopComments(videoId) {
  const key = await getApiKey();
  if (!key) return [];
  const url = new URL('https://www.googleapis.com/youtube/v3/commentThreads');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('order', 'relevance');
  url.searchParams.set('textFormat', 'plainText');
  url.searchParams.set('videoId', videoId);
  url.searchParams.set('maxResults', '50');
  url.searchParams.set('key', key);
  try {
    debugLog('Fetching top comments from API.', { videoId, url: url.toString() });
    const res = await fetch(url.toString());
    if (!res.ok) {
      debugLog('Top comments fetch failed.', { status: res.status });
      return [];
    }
    const json = await res.json();
    const out = [];
    for (const item of json.items || []) {
      const s = item?.snippet?.topLevelComment?.snippet;
      if (!s) continue;
      out.push({
        id: item.id,
        text: s.textDisplay || s.textOriginal || '',
        likes: s.likeCount || 0,
        publishedAt: s.publishedAt,
        author: s.authorDisplayName,
      });
    }
    debugLog('Fetched top comments.', { count: out.length });
    return out;
  } catch (err) {
    debugLog('Error fetching top comments.', err);
    return [];
  }
}

function buildIndexFromComments(comments) {
  // Simple TF score index over comment text
  debugLog('Building index from comments.', { count: comments.length });
  const docs = comments.map((c, i) => ({ id: i, tokens: Util.tokenize(c.text) }));
  const df = new Map();
  for (const d of docs) {
    const seen = new Set();
    for (const t of d.tokens) { if (!seen.has(t)) { df.set(t, (df.get(t) || 0) + 1); seen.add(t); } }
  }
  return {
    search: (text, k = 8) => {
      const q = Util.tokenize(text);
      const scores = new Map();
      for (const term of q) {
        const idf = Math.log(1 + (docs.length + 1) / ((df.get(term) || 0) + 1));
        for (const d of docs) {
          const docLen = d.tokens.length || 1;
          const tfRaw = d.tokens.filter(t => t === term).length;
          if (!tfRaw) continue;
          const tf = tfRaw / docLen;
          const s = (scores.get(d.id) || 0) + tf * idf;
          scores.set(d.id, s);
        }
      }
      const entries = Array.from(scores.entries()).sort((a,b)=>b[1]-a[1]).slice(0, k);
      const topScore = entries.length ? entries[0][1] : 1;
      return entries.map(([id, score]) => ({ id, score, norm: topScore > 0 ? score / topScore : 0 }));
    }
  };
}

function extractTimestampSeconds(text) {
  const normalized = (text || '').replace(/\s+/g, ' ');
  if (!normalized) return null;
  const colonRegex = /(\d{1,2}):(\d{2})(?::(\d{2}))?/g;
  let match;
  while ((match = colonRegex.exec(normalized))) {
    const part1 = Number.parseInt(match[1], 10);
    const part2 = Number.parseInt(match[2], 10);
    if (Number.isNaN(part1) || Number.isNaN(part2)) continue;
    const hasHour = match[3] != null;
    const part3 = hasHour ? Number.parseInt(match[3], 10) : 0;
    if (Number.isNaN(part3)) continue;
    const hours = hasHour ? part1 : 0;
    const minutes = hasHour ? part2 : part1;
    const seconds = hasHour ? part3 : part2;
    if (seconds >= 60) continue;
    if (!hasHour && minutes >= 180) continue;
    const total = hours * 3600 + minutes * 60 + seconds;
    if (total >= 0) {
      debugLog('Extracted timestamp via colon pattern.', { text, seconds: total });
      return total;
    }
  }
  const hmsRegex = /(\d+)\s*h(?:ours?)?\s*(\d+)?\s*m?(?:in(?:utes?)?)?\s*(\d+)?\s*s?/i;
  const hmsMatch = normalized.match(hmsRegex);
  if (hmsMatch) {
    const hours = Number.parseInt(hmsMatch[1] || '0', 10) || 0;
    const minutes = Number.parseInt(hmsMatch[2] || '0', 10) || 0;
    const seconds = Number.parseInt(hmsMatch[3] || '0', 10) || 0;
    const total = hours * 3600 + minutes * 60 + seconds;
    if (total > 0) {
      debugLog('Extracted timestamp via h/m/s pattern.', { text, seconds: total });
      return total;
    }
  }
  return null;
}

function clusterSimilarComments(index, comments, anchorIdx, options = {}) {
  const anchor = comments[anchorIdx];
  if (!anchor) return [];
  const maxResults = options.k || 8;
  const threshold = options.minNorm ?? 0.35;
  const matches = index.search(anchor.text || '', maxResults);
  debugLog('Clustering similar comments.', { anchorIdx, anchorText: anchor.text, matches: matches.length });
  if (!matches.length) return [];
  const cluster = [];
  const topScore = matches.length ? matches[0].score : 0;
  for (const m of matches) {
    const comment = comments[m.id];
    if (!comment) continue;
    if (m.id === anchorIdx) {
      cluster.push({ comment, score: 1, isAnchor: true });
      continue;
    }
    const norm = m.norm != null ? m.norm : (topScore > 0 ? m.score / topScore : 0);
    if (norm < threshold) continue;
    cluster.push({ comment, score: norm, isAnchor: false });
  }
  if (!cluster.some(entry => entry.isAnchor)) {
    cluster.unshift({ comment: anchor, score: 1, isAnchor: true });
  }
  debugLog('Cluster built.', { anchorIdx, clusterSize: cluster.length });
  return cluster;
}

async function ensureAiSession() {
  if (!('LanguageModel' in window)) return null;
  try {
    const availability = await window.LanguageModel.availability();
    if (availability === 'unavailable') return null;
    const session = await window.LanguageModel.create();
    debugLog('Created AI session for prompt API.');
    return session;
  } catch (err) {
    debugLog('Failed to create AI session.', err);
    return null;
  }
}

async function classifyEmotion(session, text) {
  if (!session) return { emotion: 'insightful', confidence: 0.0 };
  const schema = {
    type: 'object',
    properties: {
      emotion: { enum: EMOTIONS },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['emotion','confidence']
  };
  const prompt = `Classify the emotion of this YouTube comment and return JSON only.\n` +
    `Comment: "${text}"\nLabels: ${EMOTIONS.join(', ')}`;
  try {
    debugLog('Classifying emotion for text.', { length: (text || '').length });
    const res = await session.prompt(prompt, { responseConstraint: schema });
    const out = Util.safeJsonFromText(res);
    if (out?.emotion && EMOTIONS.includes(out.emotion)) {
      debugLog('Emotion classification success.', out);
      return out;
    }
    debugLog('Emotion classification returned unexpected payload.', out);
  } catch (err) {
    debugLog('Emotion classification failed.', err);
  }
  return { emotion: 'insightful', confidence: 0.0 };
}

function scoreMoment(similarity, likes, confidence, toxicityPenalty = 0) {
  const likesNorm = Math.min(1, Math.log10(1 + likes) / 3);
  const s = 0.6 * similarity + 0.25 * likesNorm + 0.2 * confidence - 0.2 * toxicityPenalty;
  debugLog('Scored moment.', { similarity, likes, confidence, toxicityPenalty, score: s });
  return s;
}

function dedupeByTime(moments, windowSec = 8) {
  const out = [];
  moments.sort((a,b)=>a.start-b.start);
  for (const m of moments) {
    const last = out[out.length-1];
    if (!last || Math.abs(m.start - last.start) > windowSec) out.push(m);
    else if ((m.score || 0) > (last.score || 0)) out[out.length-1] = m;
  }
  debugLog('Deduped moments by time window.', { before: moments.length, after: out.length, windowSec });
  return out;
}

async function generateTitle(session, text, commentText) {
  // Prefer Summarizer API when available
  try {
    if (window.ai?.summarizer?.create) {
      const summarizer = await window.ai.summarizer.create({ type: 'key-points', length: 'short' });
      const summary = await summarizer.summarize(text);
      const s = typeof summary === 'string' ? summary : (summary?.summary || '');
      const line = (s || '').split('\n').map(t=>t.trim()).find(Boolean) || '';
      if (line) {
        const trimmed = line.slice(0, 80);
        debugLog('Generated title using summarizer API.', { title: trimmed });
        return trimmed;
      }
    }
  } catch (err) {
    debugLog('Summarizer API title generation failed.', err);
  }
  // Fallback: use Prompt API to craft a short title
  if (session) {
    try {
      const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };
      const res = await session.prompt(
        `Write a concise 4-8 word title for this video moment. Return JSON only.\n` +
        `Context: ${text}\nAnchor comment: ${commentText || ''}`,
        { responseConstraint: schema }
      );
      const out = Util.safeJsonFromText(res);
      if (out?.title) {
        const trimmed = String(out.title).slice(0, 80);
        debugLog('Generated title using prompt API.', { title: trimmed });
        return trimmed;
      }
      debugLog('Prompt API returned unexpected title payload.', out);
    } catch (err) {
      debugLog('Prompt API title generation failed.', err);
    }
  }
  // Heuristic fallback
  const words = (text || '').split(/\s+/).slice(0, 8).join(' ');
  debugLog('Using heuristic title fallback.', { title: words });
  return words || 'Moment';
}

async function analyze() {
  if (state.processing) return;
  state.processing = true;
  try {
    debugLog('Starting analysis flow.');
    postStatus('starting');
    const urlVid = Util.getVideoIdFromUrl(location.href);
    if (!urlVid) {
      debugLog('No video ID detected on page.');
      state.processing = false;
      return;
    }
    state.videoId = urlVid;

    // Try cache first
    const cached = await loadCachedMoments(state.videoId);
    if (cached?.length) {
      debugLog('Loaded moments from cache.', { count: cached.length });
      state.moments = cached;
      renderMarkers();
      postMomentsUpdate();
      postStatus('done', { from: 'cache' });
      state.processing = false;
      return;
    }

    const key = await getApiKey();
    if (!key) {
      debugLog('No API key configured.');
      state.comments = [];
      postStatus('noApiKey');
      postMomentsUpdate();
      state.processing = false;
      return;
    }
    state.comments = await fetchTopComments(state.videoId);
    debugLog('Fetched comments list.', { count: state.comments.length });
    if (!state.comments.length) {
      debugLog('No top comments returned from API.');
      postStatus('noComments');
      state.moments = [];
      renderMarkers();
      postMomentsUpdate();
      saveCachedMoments(state.videoId, state.moments);
      state.processing = false;
      return;
    }
    const timestamped = state.comments
      .map((c, idx) => ({ idx, comment: c, time: extractTimestampSeconds(c.text) }))
      .filter(entry => entry.time != null);

    debugLog('Timestamped comments extracted.', { count: timestamped.length });
    if (!timestamped.length) {
      debugLog('No timestamped comments found.');
      state.moments = [];
      renderMarkers();
      postMomentsUpdate();
      postStatus('noTimestamps');
      saveCachedMoments(state.videoId, state.moments);
      state.processing = false;
      return;
    }

    const index = buildIndexFromComments(state.comments);
    const session = await ensureAiSession();
    if (!session) debugLog('AI session unavailable, falling back to defaults.');

    const sortedAnchors = timestamped.sort((a, b) => (b.comment.likes || 0) - (a.comment.likes || 0));
    const moments = [];
    for (const anchor of sortedAnchors) {
      debugLog('Processing anchor comment.', {
        anchorIdx: anchor.idx,
        time: anchor.time,
        likes: anchor.comment.likes,
        text: anchor.comment.text,
      });
      const cluster = clusterSimilarComments(index, state.comments, anchor.idx, { k: 10, minNorm: 0.3 });
      if (!cluster.length) continue;
      const totalLikes = cluster.reduce((sum, entry) => sum + (entry.comment.likes || 0), 0);
      const supportScore = Math.min(1, cluster.length / 5);
      const clusterText = cluster.map(entry => entry.comment.text).join(' ');
      const emo = await classifyEmotion(session, clusterText || anchor.comment.text || '');
      const title = await generateTitle(session, clusterText || '', anchor.comment.text || '');
      const sampleComments = cluster.filter(entry => !entry.isAnchor).slice(0, 3).map(entry => entry.comment.text);
      const moment = {
        start: Math.max(0, anchor.time),
        end: Math.max(0, anchor.time + 5),
        reason: cluster.length > 1 ? `Cluster of ${cluster.length} similar comments` : 'Timestamped comment highlight',
        emotion: emo.emotion,
        confidence: emo.confidence,
        comment: anchor.comment.text,
        likes: totalLikes,
        title,
        score: scoreMoment(supportScore, totalLikes, emo.confidence, 0),
        clusterSize: cluster.length,
        totalLikes,
        sampleComments,
        anchorAuthor: anchor.comment.author || '',
        anchorLikes: anchor.comment.likes || 0,
      };
      debugLog('Generated moment candidate.', {
        start: moment.start,
        score: moment.score,
        emotion: moment.emotion,
        clusterSize: moment.clusterSize,
      });
      moments.push(moment);
    }

    const deduped = dedupeByTime(moments, 10).sort((a,b)=>b.score-a.score).slice(0, 30);
    debugLog('Final deduped moments ready.', { count: deduped.length });
    state.moments = deduped;
    renderMarkers();
    postMomentsUpdate();
    saveCachedMoments(state.videoId, state.moments);
    postStatus('done', { count: state.moments.length });
  } catch (err) {
    debugLog('Unexpected error during analysis.', err);
  } finally {
    state.processing = false;
  }
}

function handleSpaNavigation() {
  let last = location.href;
  const obs = new MutationObserver(() => {
    if (location.href !== last) {
      debugLog('Detected SPA navigation change.', { from: last, to: location.href });
      last = location.href;
      // reset
      state.videoId = null;
      state.comments = [];
      state.moments = [];
      renderMarkers();
      postMomentsUpdate();
      setTimeout(analyze, 800);
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'getMoments') {
    debugLog('Received getMoments request.');
    sendResponse({ moments: state.moments });
  }
  if (msg?.type === 'seek') {
    debugLog('Received seek request.', { time: msg.time });
    const v = document.querySelector('video');
    if (v) v.currentTime = msg.time || 0;
  }
  if (msg?.type === 'triggerAnalyze') {
    debugLog('Received triggerAnalyze request.');
    analyze();
  }
});

handleSpaNavigation();
injectInpageBridge();
debugLog('Scheduling initial analyze run.');
setTimeout(() => {
  debugLog('Running initial analyze.');
  analyze();
}, 1200);


