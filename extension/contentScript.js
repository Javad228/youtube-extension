/* global Util */

const EMOTIONS = ["funny","sad","wholesome","insightful","angry","wtf"];

const state = {
  videoId: null,
  windows: [],
  comments: [],
  moments: [],
  index: null,
  processing: false,
};

function injectInpageBridge() {
  try {
    const url = chrome.runtime.getURL('inpageBridge.js');
    const s = document.createElement('script');
    s.src = url;
    s.async = false;
    (document.documentElement || document.head || document.body).appendChild(s);
    s.addEventListener('load', () => s.remove());
  } catch (e) {}
}

const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

async function loadCachedMoments(videoId) {
  try {
    const key = `moments:${videoId}`;
    const res = await chrome.storage.local.get([key]);
    const payload = res[key];
    if (!payload) return null;
    if ((Date.now() - (payload.savedAt || 0)) > CACHE_TTL_MS) return null;
    return payload.data || null;
  } catch (_) { return null; }
}

async function saveCachedMoments(videoId, data) {
  try {
    const key = `moments:${videoId}`;
    await chrome.storage.local.set({ [key]: { savedAt: Date.now(), data } });
  } catch (_) {}
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
    overlay = document.createElement('div');
    overlay.className = 'yt-moments-overlay';
    overlay.style.position = 'absolute';
    overlay.style.left = '0';
    overlay.style.right = '0';
    overlay.style.bottom = '0';
    overlay.style.height = '6px';
    player.appendChild(overlay);
    // Ensure player is positioned
    const style = getComputedStyle(player);
    if (style.position === 'static') {
      player.style.position = 'relative';
    }
  }
  return overlay;
}

function renderMarkers() {
  const overlay = ensureOverlay();
  if (!overlay) return;
  overlay.innerHTML = '';
  const duration = document.querySelector('video')?.duration || 0;
  if (!duration) return;
  for (const m of state.moments) {
    const leftPct = Math.max(0, Math.min(100, (m.start / duration) * 100));
    const el = document.createElement('div');
    el.className = 'marker';
    el.dataset.emotion = m.emotion || 'insightful';
    el.style.left = `${leftPct}%`;
    el.title = `${m.title || 'Moment'} (${Math.round(m.start)}s)`;
    el.addEventListener('click', () => {
      const video = document.querySelector('video');
      if (video) video.currentTime = m.start;
    });
    overlay.appendChild(el);
  }
}

function postMomentsUpdate() {
  chrome.runtime.sendMessage({ type: 'momentsUpdated', moments: state.moments });
}

function postStatus(status, extra = {}) {
  chrome.runtime.sendMessage({ type: 'analysisStatus', status, ...extra });
}

async function gatherCaptionDebug() {
  try {
    // Try to read live caption tracks from player response and cache them for Util
    let player = [];
    try {
      const win = window;
      const sources = [
        win?.ytInitialPlayerResponse,
        win?.ytdApp?.player_?.getPlayerResponse?.(),
        document.querySelector('ytd-player')?.playerData,
      ];
      for (const src of sources) {
        const tracks = src?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (Array.isArray(tracks) && tracks.length) {
          player = tracks.map((t) => ({
            lang_code: t.languageCode || '',
            kind: t.kind || '',
            name: typeof t.name?.simpleText === 'string' ? t.name.simpleText : (t.name || ''),
            vss_id: t.vssId || '',
            baseUrl: t.baseUrl || '',
            is_default: !!t.isDefault,
          }));
          if (typeof Util.setPlayerCaptionTracks === 'function') Util.setPlayerCaptionTracks(player);
          break;
        }
      }
    } catch (_) {}
    if (!player.length && typeof Util.getPlayerCaptionTracks === 'function') {
      player = (Util.getPlayerCaptionTracks() || []);
    }
    const list = (typeof Util.listCaptionTracks === 'function' && state.videoId) ? (await Util.listCaptionTracks(state.videoId)) : [];
    const summarize = (arr) => arr.map(t => ({
      lang: t.lang_code || '', kind: t.kind || '', name: t.name || '', vss: !!t.vss_id, base: !!t.baseUrl, def: !!t.is_default
    }));
    return { player: summarize(player), list: summarize(list) };
  } catch (_) { return { player: [], list: [] }; }
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
    const res = await fetch(url.toString());
    if (!res.ok) return [];
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
    return out;
  } catch (_) { return []; }
}

function buildIndex(windows) {
  // Simple TF score index
  const docs = windows.map((w, i) => ({ id: i, tokens: Util.tokenize(w.text) }));
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
          const tf = d.tokens.filter(t => t === term).length;
          if (!tf) continue;
          const s = (scores.get(d.id) || 0) + tf * idf;
          scores.set(d.id, s);
        }
      }
      const arr = Array.from(scores.entries()).sort((a,b)=>b[1]-a[1]).slice(0, k).map(([id, score]) => ({ id, score }));
      return arr;
    }
  };
}

async function ensureAiSession() {
  if (!('LanguageModel' in window)) return null;
  try {
    const availability = await window.LanguageModel.availability();
    if (availability === 'unavailable') return null;
    return await window.LanguageModel.create();
  } catch (_) { return null; }
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
    const res = await session.prompt(prompt, { responseConstraint: schema });
    const out = Util.safeJsonFromText(res);
    if (out?.emotion && EMOTIONS.includes(out.emotion)) return out;
  } catch (_) {}
  return { emotion: 'insightful', confidence: 0.0 };
}

async function pickBestWindow(session, commentText, candidates) {
  if (!candidates?.length) return null;
  if (!session) {
    const top = candidates[0];
    if (!top) return null;
    return { start: top.win.start, end: top.win.end, reason: 'Top lexical match' };
  }
  const schema = {
    type: 'object',
    properties: { start: {type:'number'}, end:{type:'number'}, reason:{type:'string'} },
    required: ['start','end']
  };
  const windowsText = candidates.map((c,i)=>`[${i}] ${Math.round(c.win.start)}-${Math.round(c.win.end)}: ${c.win.text}`).join('\n');
  const prompt = `You get a viewer comment and K transcript windows with timestamps.\n` +
    `Pick the single best-matching window. Return {"start":s,"end":e,"reason":...}.\n` +
    `Comment: ${commentText}\n` +
    `Windows:\n${windowsText}`;
  try {
    const res = await session.prompt(prompt, { responseConstraint: schema });
    const out = Util.safeJsonFromText(res);
    if (out?.start != null && out?.end != null) return out;
  } catch (_) {}
  return null;
}

function scoreMoment(similarity, likes, confidence, toxicityPenalty = 0) {
  const likesNorm = Math.min(1, Math.log10(1 + likes) / 3);
  const s = 0.6 * similarity + 0.25 * likesNorm + 0.2 * confidence - 0.2 * toxicityPenalty;
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
      if (line) return line.slice(0, 80);
    }
  } catch (_) {}
  // Fallback: use Prompt API to craft a short title
  if (session) {
    try {
      const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };
      const res = await session.prompt(
        `Write a concise 4-8 word title for this video moment. Return JSON only.\n` +
        `Transcript window: ${text}\nComment hint: ${commentText || ''}`,
        { responseConstraint: schema }
      );
      const out = Util.safeJsonFromText(res);
      if (out?.title) return String(out.title).slice(0, 80);
    } catch (_) {}
  }
  // Heuristic fallback
  const words = (text || '').split(/\s+/).slice(0, 8).join(' ');
  return words || 'Moment';
}

async function analyze() {
  if (state.processing) return;
  state.processing = true;
  try {
    postStatus('starting');
    const urlVid = Util.getVideoIdFromUrl(location.href);
    if (!urlVid) { state.processing = false; return; }
    state.videoId = urlVid;

    // Try cache first
    const cached = await loadCachedMoments(state.videoId);
    if (cached?.length) {
      state.moments = cached;
      renderMarkers();
      postMomentsUpdate();
      postStatus('done', { from: 'cache' });
      state.processing = false;
      return;
    }

    state.windows = await Util.fetchTranscriptWindows(state.videoId, { windowSizeSec: 7 });
    if (!state.windows.length) {
      const tracks = await gatherCaptionDebug();
      state.moments = [];
      renderMarkers();
      postMomentsUpdate();
      postStatus('noTranscript', { tracks });
      state.processing = false;
      return;
    }
    state.index = buildIndex(state.windows);

    const key = await getApiKey();
    if (!key) {
      state.comments = [];
      postStatus('noApiKey');
      postMomentsUpdate();
      state.processing = false;
      return;
    }
    state.comments = await fetchTopComments(state.videoId);
    if (!state.comments.length) {
      postStatus('noComments');
    }
    const session = await ensureAiSession();

    const moments = [];
    for (const c of state.comments) {
      const top = state.index.search(c.text, 6).map(r => ({ r, win: state.windows[r.id] }));
      const pick = await pickBestWindow(session, c.text, top);
      const emo = await classifyEmotion(session, c.text);
      const similarity = top.length ? top[0].r.score : 0;
      if (pick) {
        const title = await generateTitle(session, top[0]?.win?.text || '', c.text);
        const m = {
          start: Math.max(0, pick.start),
          end: Math.max(pick.start, pick.end),
          reason: pick.reason || '',
          emotion: emo.emotion,
          confidence: emo.confidence,
          comment: c.text,
          likes: c.likes,
          title,
          score: scoreMoment(similarity, c.likes, emo.confidence, 0),
        };
        moments.push(m);
      }
    }

    const deduped = dedupeByTime(moments, 10).sort((a,b)=>b.score-a.score).slice(0, 30);
    state.moments = deduped;
    renderMarkers();
    postMomentsUpdate();
    saveCachedMoments(state.videoId, state.moments);
    postStatus('done', { count: state.moments.length });
  } catch (err) {
    // swallow
  } finally {
    state.processing = false;
  }
}

function handleSpaNavigation() {
  let last = location.href;
  const obs = new MutationObserver(() => {
    if (location.href !== last) {
      last = location.href;
      // reset
      state.videoId = null;
      state.windows = [];
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
    sendResponse({ moments: state.moments });
  }
  if (msg?.type === 'seek') {
    const v = document.querySelector('video');
    if (v) v.currentTime = msg.time || 0;
  }
  if (msg?.type === 'triggerAnalyze') {
    analyze();
  }
  if (msg?.type === 'forceFetchTranscript') {
    (async () => {
      try {
        const vssIds = Array.isArray(msg.vssIds) ? msg.vssIds : [];
        const windows = await Util.fetchTranscriptWindows(state.videoId || Util.getVideoIdFromUrl(location.href), {
          windowSizeSec: 7,
          vssIds,
          langs: vssIds, // try these directly
        });
        if (windows && windows.length) {
          state.windows = windows;
          // Minimal mark to let user proceed: set a fake moment so UI unlocks
          state.moments = [];
          renderMarkers();
          postStatus('done', { from: 'force', windows: windows.length });
        } else {
          postStatus('noTranscript', { forced: vssIds });
        }
      } catch (e) {
        postStatus('noTranscript', { error: String(e) });
      }
    })();
  }
});

// Listen for in-page bridge messages to capture caption tracks ASAP
window.addEventListener('message', (ev) => {
  try {
    const data = ev.data || {};
    if (data && data.source === 'yt-moments' && data.type === 'captionTracks' && Array.isArray(data.tracks)) {
      if (typeof Util.setPlayerCaptionTracks === 'function') Util.setPlayerCaptionTracks(
        data.tracks.map(t => ({
          lang_code: t.languageCode || '',
          kind: t.kind || '',
          name: t.name || '',
          vss_id: t.vssId || '',
          baseUrl: t.baseUrl || '',
          is_default: !!t.isDefault,
        }))
      );
    }
  } catch (_) {}
}, true);

handleSpaNavigation();
injectInpageBridge();
setTimeout(analyze, 1200);


