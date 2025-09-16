async function load() {
  const { ytApiKey } = await chrome.storage.local.get(['ytApiKey']);
  if (ytApiKey) document.getElementById('apiKey').value = ytApiKey;
}

async function save() {
  const val = document.getElementById('apiKey').value.trim();
  await chrome.storage.local.set({ ytApiKey: val });
  const s = document.getElementById('status');
  s.textContent = 'Saved';
  setTimeout(() => (s.textContent = ''), 1200);
}

document.getElementById('save').addEventListener('click', save);
load();


