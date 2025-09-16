// Utility helpers injected before contentScript
(function () {
  const Util = {};

  Util.getVideoIdFromUrl = function getVideoIdFromUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname.includes('youtube.com')) {
        return u.searchParams.get('v');
      }
      if (u.hostname.includes('youtu.be')) {
        const id = u.pathname.split('/').filter(Boolean)[0];
        return id || null;
      }
    } catch (_) {}
    return null;
  };

  Util.decodeHtmlEntities = function decodeHtmlEntities(text) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    return doc.documentElement.textContent || '';
  };

  Util.setPlayerCaptionTracks = function setPlayerCaptionTracks(tracks) {
    try { window.__MomentsTracksCache = Array.isArray(tracks) ? tracks : []; } catch (_) {}
  };

  Util.getPlayerCaptionTracks = function getPlayerCaptionTracks() {
    try {
      const cached = window.__MomentsTracksCache;
      if (Array.isArray(cached) && cached.length) return cached;
    } catch (_) {}
    return [];
  };

  Util.listCaptionTracks = async function listCaptionTracks(videoId, options = {}) {
    try {
      const hl = (options.hl || (typeof navigator !== 'undefined' ? navigator.language : 'en')) || 'en';
      const url = `https://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(videoId)}&hl=${encodeURIComponent(hl)}`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return [];
      const xml = await res.text();
      if (!xml) return [];
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      const tracks = Array.from(doc.getElementsByTagName('track')).map((n) => ({
        lang_code: n.getAttribute('lang_code') || '',
        kind: n.getAttribute('kind') || '',
        name: n.getAttribute('name') || '',
        vss_id: n.getAttribute('vss_id') || '',
        baseUrl: n.getAttribute('baseUrl') || '',
        is_default: (n.getAttribute('lang_default') || '') === 'true',
      }));
      return tracks;
    } catch (_) { return []; }
  };

  Util.fetchTranscriptWindows = async function fetchTranscriptWindows(videoId, options = {}) {
    const uiLangs = (typeof navigator !== 'undefined' && Array.isArray(navigator.languages)) ? navigator.languages : [ (typeof navigator !== 'undefined' ? navigator.language : '') ];
    const baseLangs = ['en', 'en-US', 'en-GB'].concat(uiLangs || []).filter(Boolean);
    const seenLangs = new Set();
    const langs = (options.langs || baseLangs).filter(l => {
      const low = String(l).toLowerCase();
      if (seenLangs.has(low)) return false;
      seenLangs.add(low);
      return true;
    });
    const windowSizeSec = options.windowSizeSec || 7;

    async function listTracks(videoId) {
      try {
        const hl = (options.hl || (typeof navigator !== 'undefined' ? navigator.language : 'en')) || 'en';
        const url = `https://www.youtube.com/api/timedtext?type=list&v=${encodeURIComponent(videoId)}&hl=${encodeURIComponent(hl)}`;
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return [];
        const xml = await res.text();
        if (!xml) return [];
        const doc = new DOMParser().parseFromString(xml, 'text/xml');
        const tracks = Array.from(doc.getElementsByTagName('track')).map((n) => ({
          lang_code: n.getAttribute('lang_code') || '',
          kind: n.getAttribute('kind') || '',
          name: n.getAttribute('name') || '',
          vss_id: n.getAttribute('vss_id') || '',
          baseUrl: n.getAttribute('baseUrl') || '',
          is_default: (n.getAttribute('lang_default') || '') === 'true',
        }));
        return tracks;
      } catch (_) { return []; }
    }

    function pickTrack(tracks) {
      if (!tracks.length) return null;
      const prefer = (langs || []).map(l => (l || '').toLowerCase());
      const preferBase = prefer.map(l => l.split('-')[0]);
      let best = null;
      let bestScore = -Infinity;
      for (const t of tracks) {
        const code = (t.lang_code || '').toLowerCase();
        const base = code.split('-')[0];
        let score = 0;
        if (prefer.includes(code)) score += 5;
        if (preferBase.includes(base)) score += 4;
        if (!t.kind) score += 3; // non-ASR preferred
        if (t.kind === 'asr') score += 1;
        if (t.is_default) score += 1;
        if (score > bestScore) { bestScore = score; best = t; }
      }
      return best || tracks[0];
    }

    function parseJson3Transcript(jsonText) {
      try {
        let payload = (jsonText || '').trimStart();
        // Youtube wraps json3/srv3 responses with an XSSI protection prefix like ")]}'".
        if (payload.startsWith(")]}'")) {
          const newline = payload.indexOf('\n');
          payload = newline !== -1 ? payload.slice(newline + 1) : payload.slice(4);
        }
        const data = JSON.parse(payload);
        const events = Array.isArray(data?.events) ? data.events : [];
        const frags = [];
        for (let i = 0; i < events.length; i++) {
          const ev = events[i] || {};
          const startMs = typeof ev.tStartMs === 'number' ? ev.tStartMs : 0;
          const nextStartMs = (events[i + 1] && typeof events[i + 1].tStartMs === 'number') ? events[i + 1].tStartMs : null;
          const durMs = (typeof ev.dDurationMs === 'number') ? ev.dDurationMs : (nextStartMs != null ? (nextStartMs - startMs) : 2000);
          const start = startMs / 1000;
          const end = Math.max(start, (startMs + Math.max(0, durMs)) / 1000);
          const segs = Array.isArray(ev.segs) ? ev.segs : [];
          const text = segs
            .map(s => (s && typeof s.utf8 === 'string' ? s.utf8 : ''))
            .filter(t => t && t.trim() && t.trim() !== '\n')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (text) frags.push({ start, end, text });
        }
        return frags;
      } catch (_) { return []; }
    }

    function parseVttTimestamp(ts) {
      // 00:00:01.000 --> 00:00:03.000
      const m = ts.match(/(\d+):(\d+):(\d+\.?\d*)\s*-->\s*(\d+):(\d+):(\d+\.?\d*)/);
      if (!m) return null;
      const toSec = (h, m, s) => (parseInt(h,10)*3600 + parseInt(m,10)*60 + parseFloat(s));
      return { start: toSec(m[1], m[2], m[3]), end: toSec(m[4], m[5], m[6]) };
    }

    function parseVtt(text) {
      const lines = (text || '').split(/\r?\n/);
      const frags = [];
      let i = 0;
      while (i < lines.length) {
        let line = lines[i].trim();
        if (!line || /^WEBVTT/i.test(line) || /^NOTE/i.test(line)) { i++; continue; }
        // Optional cue id
        if (!line.includes('-->') && i + 1 < lines.length && lines[i + 1].includes('-->')) {
          i++; line = lines[i].trim();
        }
        if (!line.includes('-->')) { i++; continue; }
        const ts = parseVttTimestamp(line);
        i++;
        const content = [];
        while (i < lines.length && lines[i].trim()) { content.push(lines[i].trim()); i++; }
        const txt = content.join(' ').replace(/\s+/g, ' ').trim();
        if (ts && txt) frags.push({ start: ts.start, end: ts.end, text: txt });
        // skip blank
        while (i < lines.length && !lines[i].trim()) i++;
      }
      return frags;
    }

    function makeUrlAddParam(u, key, value) {
      try {
        const url = new URL(u);
        if (!url.searchParams.get(key)) url.searchParams.set(key, value);
        return url.toString();
      } catch (_) {
        const sep = u.includes('?') ? '&' : '?';
        return `${u}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      }
    }

    function makeUrlSetParam(u, key, value) {
      try {
        const url = new URL(u);
        url.searchParams.set(key, value);
        return url.toString();
      } catch (_) {
        // naive replace if present; else add
        const re = new RegExp(`([?&])${key}=[^&]*`);
        if (re.test(u)) return u.replace(re, `$1${key}=${encodeURIComponent(value)}`);
        const sep = u.includes('?') ? '&' : '?';
        return `${u}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      }
    }

    async function fetchTrackFragments(videoId, chosen, allTracks) {
      const base = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}`;
      const candidates = [];
      const forcedVss = Array.isArray(options.vssIds) ? options.vssIds : [];
      const debug = { tried: [], chosen: chosen || null };
      const tracks = [chosen, ...(allTracks || []).filter(t => t && t !== chosen)];
      for (const t of tracks) {
        if (!t) continue;
        if (t.baseUrl) {
          const b = t.baseUrl;
          candidates.push(b);
          candidates.push(makeUrlSetParam(b, 'fmt', 'json3'));
          candidates.push(makeUrlSetParam(b, 'fmt', 'srv3'));
          candidates.push(makeUrlSetParam(b, 'fmt', 'vtt'));
        }
        if (t.vss_id) {
          candidates.push(`${base}&vss_id=${encodeURIComponent(t.vss_id)}`);
          candidates.push(`${base}&vss_id=${encodeURIComponent(t.vss_id)}&fmt=json3`);
          candidates.push(`${base}&vss_id=${encodeURIComponent(t.vss_id)}&fmt=srv3`);
          candidates.push(`${base}&vss_id=${encodeURIComponent(t.vss_id)}&fmt=vtt`);
        }
        let u = `${base}&lang=${encodeURIComponent(t.lang_code)}`;
        if (t.kind) u += `&kind=${encodeURIComponent(t.kind)}`;
        if (t.name) u += `&name=${encodeURIComponent(t.name)}`;
        candidates.push(u);
        candidates.push(`${u}&fmt=json3`);
        candidates.push(`${u}&fmt=srv3`);
        candidates.push(`${u}&fmt=vtt`);
      }
      // Fallback to direct langs
      for (const lang of langs) {
        candidates.push(`${base}&lang=${encodeURIComponent(lang)}`);
        candidates.push(`${base}&lang=${encodeURIComponent(lang)}&fmt=json3`);
        candidates.push(`${base}&lang=${encodeURIComponent(lang)}&fmt=srv3`);
        candidates.push(`${base}&lang=${encodeURIComponent(lang)}&fmt=vtt`);
        // Try auto-generated vss_id guesses (a.<lang>)
        candidates.push(`${base}&vss_id=${encodeURIComponent('a.' + lang)}`);
        candidates.push(`${base}&vss_id=${encodeURIComponent('a.' + lang)}&fmt=json3`);
        candidates.push(`${base}&vss_id=${encodeURIComponent('a.' + lang)}&fmt=srv3`);
        candidates.push(`${base}&vss_id=${encodeURIComponent('a.' + lang)}&fmt=vtt`);
        // Also try language base without region
        const baseOnly = String(lang).split('-')[0];
        if (baseOnly && baseOnly !== lang) {
          candidates.push(`${base}&vss_id=${encodeURIComponent('a.' + baseOnly)}`);
          candidates.push(`${base}&vss_id=${encodeURIComponent('a.' + baseOnly)}&fmt=json3`);
          candidates.push(`${base}&vss_id=${encodeURIComponent('a.' + baseOnly)}&fmt=srv3`);
          candidates.push(`${base}&vss_id=${encodeURIComponent('a.' + baseOnly)}&fmt=vtt`);
        }
      }
      // Forced VSS ids from caller
      for (const v of forcedVss) {
        if (!v) continue;
        candidates.push(`${base}&vss_id=${encodeURIComponent(v)}`);
        candidates.push(`${base}&vss_id=${encodeURIComponent(v)}&fmt=json3`);
        candidates.push(`${base}&vss_id=${encodeURIComponent(v)}&fmt=srv3`);
        candidates.push(`${base}&vss_id=${encodeURIComponent(v)}&fmt=vtt`);
      }

      const seen = new Set();
      for (let url of candidates) {
        if (!url) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        try {
          const fmtMatch = url.match(/[?&]fmt=([^&]+)/);
          const fmt = fmtMatch ? fmtMatch[1] : '';
          const res = await fetch(url, { credentials: 'include' });
          if (!res.ok) continue;
          const text = await res.text();
          if (!text) {
            debug.tried.push({ url, ok: true, len: 0 });
            continue;
          }
          debug.tried.push({ url, ok: true, len: text.length });
          if (/^(json3|srv\d)$/i.test(fmt) || text.trim().startsWith('{')) {
            const fragments = parseJson3Transcript(text);
            if (fragments.length) return fragments;
          } else if (/^vtt$/i.test(fmt) || text.includes('-->')) {
            const fragments = parseVtt(text);
            if (fragments.length) return fragments;
          } else {
            if (text.includes('<transcript/>')) continue;
            const doc = new DOMParser().parseFromString(text, 'text/xml');
            const nodes = Array.from(doc.getElementsByTagName('text'));
            if (!nodes.length) continue;
            const fragments = nodes.map((n) => {
              const start = parseFloat(n.getAttribute('start') || '0');
              const dur = parseFloat(n.getAttribute('dur') || '0');
              const end = start + dur;
              const raw = n.textContent || '';
              return { start, end, text: Util.decodeHtmlEntities(raw.replace(/\n/g, ' ').trim()) };
            });
            if (fragments.length) return fragments;
          }
        } catch (e) {
          try { debug.tried.push({ url, ok: false, error: String(e) }); } catch (_) {}
          /* try next */
        }
      }
      try { window.__MomentsTranscriptDebug = debug; } catch (_) {}
      return [];
    }

    async function fetchFragmentsFromVideoTracks() {
      try {
        const video = document.querySelector('video');
        if (!video || !video.textTracks) return [];
        const tracks = Array.from(video.textTracks).filter((t) => {
          const kind = (t.kind || '').toLowerCase();
          return kind === 'subtitles' || kind === 'captions';
        });
        if (!tracks.length) return [];

        function cleanText(text) {
          return (text || '')
            .replace(/<[^>]+>/g, ' ') // strip simple WebVTT styling tags
            .replace(/\s+/g, ' ')
            .trim();
        }

        async function waitForCues(track, timeoutMs = 4000) {
          if (track.cues && track.cues.length) return true;
          return new Promise((resolve) => {
            let done = false;
            let interval;
            const cleanup = () => {
              if (interval) clearInterval(interval);
            };
            const finish = (val) => {
              if (done) return;
              done = true;
              cleanup();
              resolve(val);
            };
            const check = () => {
              if (track.cues && track.cues.length) finish(true);
            };
            interval = setInterval(check, 120);
            setTimeout(() => {
              finish(false);
            }, timeoutMs);
            track.addEventListener('cuechange', () => {
              if (track.cues && track.cues.length) {
                finish(true);
              }
            }, { once: true });
          });
        }

        const fragments = [];
        for (const track of tracks) {
          const prevMode = track.mode;
          let forcedMode = false;
          if (track.mode === 'disabled') {
            // Hidden loads cues without rendering them.
            track.mode = 'hidden';
            forcedMode = true;
          }
          let hasCues = await waitForCues(track);
          if (!hasCues && forcedMode) {
            track.mode = 'showing';
            hasCues = await waitForCues(track, 2000);
            if (!hasCues) track.mode = 'hidden';
          }
          const cues = track.cues ? Array.from(track.cues) : [];
          for (const cue of cues) {
            const text = cleanText(cue.text || '');
            if (!text) continue;
            const start = typeof cue.startTime === 'number' ? cue.startTime : 0;
            const end = typeof cue.endTime === 'number' ? cue.endTime : start;
            fragments.push({ start, end, text });
          }
          track.mode = prevMode;
        }
        fragments.sort((a, b) => a.start - b.start);
        return fragments;
      } catch (_) { return []; }
    }

    const attempts = Math.max(1, options.fetchRetries || 3);
    let fragments = [];
    for (let attempt = 0; attempt < attempts && !fragments.length; attempt++) {
      if (attempt) await Util.sleep(800);
      const playerTracks = Util.getPlayerCaptionTracks();
      const listApiTracks = await listTracks(videoId);
      const trackMap = new Map();
      for (const t of [...playerTracks, ...listApiTracks]) {
        const key = t.baseUrl || t.vss_id || `${t.lang_code}|${t.kind}|${t.name}`;
        if (key && !trackMap.has(key)) trackMap.set(key, t);
      }
      const tracks = Array.from(trackMap.values());
      const chosen = pickTrack(tracks);
      fragments = await fetchTrackFragments(videoId, chosen, tracks);
      if (!fragments.length) {
        const fallback = await fetchFragmentsFromVideoTracks();
        if (fallback.length) {
          fragments = fallback;
          try { window.__MomentsTranscriptDebug = { fallback: 'video.textTracks', count: fragments.length }; } catch (_) {}
        }
      }
    }
    if (!fragments.length) return [];

    const totalEnd = fragments.reduce((m, f) => Math.max(m, f.end || 0), 0);
    const windows = [];
    for (let t = 0; t < totalEnd + 0.1; t += windowSizeSec) {
      const wStart = t;
      const wEnd = Math.min(t + windowSizeSec, totalEnd);
      const texts = [];
      for (const f of fragments) {
        if (f.end < wStart || f.start > wEnd) continue;
        texts.push(f.text);
      }
      const text = texts.join(' ').replace(/\s+/g, ' ').trim();
      if (text) windows.push({ start: wStart, end: wEnd, text });
    }
    return windows;
  };

  Util.tokenize = function tokenize(text) {
    return (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  };

  Util.safeJsonFromText = function safeJsonFromText(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      // Try to extract the first JSON-like block
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]); } catch (_) {}
      }
    }
    return null;
  };

  Util.sleep = function sleep(ms) { return new Promise(r => setTimeout(r, ms)); };

  window.Util = Util;
})();
