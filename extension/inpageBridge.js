(function () {
  function normalizeTrack(t) {
    try {
      return {
        languageCode: t.languageCode || '',
        kind: t.kind || '',
        name: (t.name && t.name.simpleText) || t.name || '',
        vssId: t.vssId || '',
        baseUrl: t.baseUrl || '',
        isDefault: !!t.isDefault,
      };
    } catch (_) { return {}; }
  }

  function collectTracks() {
    try {
      const win = window;
      const sources = [
        win.ytdApp && win.ytdApp.player_ && win.ytdApp.player_.getPlayerResponse && win.ytdApp.player_.getPlayerResponse(),
        win.ytInitialPlayerResponse,
        document.querySelector('ytd-player') && document.querySelector('ytd-player').playerData,
      ];
      for (const src of sources) {
        const tracks = src && src.captions && src.captions.playerCaptionsTracklistRenderer && src.captions.playerCaptionsTracklistRenderer.captionTracks;
        if (Array.isArray(tracks) && tracks.length) {
          return tracks.map(normalizeTrack);
        }
      }
    } catch (_) {}
    return [];
  }

  function send() {
    try {
      const out = collectTracks();
      window.postMessage({ source: 'yt-moments', type: 'captionTracks', tracks: out }, '*');
    } catch (_) {}
  }

  // Initial send and listeners for SPA events
  send();
  window.addEventListener('yt-navigate-finish', send, true);
  document.addEventListener('yt-page-data-updated', send, true);
  document.addEventListener('yt-rendererstamper-finished', send, true);

  // Try a few times after load as tracks can appear late
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    send();
    if (tries > 8) clearInterval(timer);
  }, 500);
})();


