// app.js
// All logic runs in the browser. The ElevenLabs API key is never used here —
// every request goes to our own /api/generate endpoint.

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------
  const CONFIG = {
    maxChunkChars: 2500, // safe under every current ElevenLabs model's per-request limit
    maxRetries: 3,
    retryBaseDelayMs: 1500,
  };

  const LS_KEYS = {
    savedVoices: 'kavg_saved_voices_v1',
    lastScript: 'kavg_last_script_v1',
    lastVoice: 'kavg_last_voice_v1',
    lastModel: 'kavg_last_model_v1',
    jobPrefix: 'kavg_job_v1_', // + jobId
  };

  const DB_NAME = 'kavg-db';
  const DB_VERSION = 1;
  const STORE = 'audioChunks';

  // ---------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------
  const el = {
    scriptInput: document.getElementById('scriptInput'),
    charCount: document.getElementById('charCount'),
    voiceIdInput: document.getElementById('voiceIdInput'),
    savedVoiceSelect: document.getElementById('savedVoiceSelect'),
    deleteVoiceBtn: document.getElementById('deleteVoiceBtn'),
    voiceNameInput: document.getElementById('voiceNameInput'),
    saveVoiceBtn: document.getElementById('saveVoiceBtn'),
    modelInput: document.getElementById('modelInput'),
    generateBtn: document.getElementById('generateBtn'),

    resumeBanner: document.getElementById('resumeBanner'),
    resumeText: document.getElementById('resumeText'),
    resumeBtn: document.getElementById('resumeBtn'),
    dismissResumeBtn: document.getElementById('dismissResumeBtn'),

    progressSection: document.getElementById('progressSection'),
    progressChunkLabel: document.getElementById('progressChunkLabel'),
    progressPercent: document.getElementById('progressPercent'),
    progressFill: document.getElementById('progressFill'),
    progressChars: document.getElementById('progressChars'),
    progressErrors: document.getElementById('progressErrors'),
    statusBanner: document.getElementById('statusBanner'),

    chunkSection: document.getElementById('chunkSection'),
    chunkList: document.getElementById('chunkList'),
    retryFailedBtn: document.getElementById('retryFailedBtn'),

    finalActions: document.getElementById('finalActions'),
    downloadAllBtn: document.getElementById('downloadAllBtn'),
    mergeAllBtn: document.getElementById('mergeAllBtn'),
    resetBtn: document.getElementById('resetBtn'),
  };

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  let state = {
    jobId: null,
    voiceId: '',
    modelId: '',
    chunks: [], // { index, text, status: pending|loading|success|error, error }
    running: false,
  };

  let pendingResumeJob = null; // job object detected on load, not yet applied

  // ---------------------------------------------------------------------
  // Hashing (for a stable, content-based job id)
  // ---------------------------------------------------------------------
  function hashString(str) {
    let h1 = 0xdeadbeef ^ str.length;
    let h2 = 0x41c6ce57 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  function makeJobId(text, voiceId, modelId) {
    return hashString(`${text}::${voiceId}::${modelId}`);
  }

  // ---------------------------------------------------------------------
  // Kannada-aware chunker
  // Splits on paragraph breaks first, then sentence boundaries, then
  // whitespace — never inside a word — while keeping every chunk under
  // CONFIG.maxChunkChars and preserving original order/content.
  // ---------------------------------------------------------------------
  function splitScript(rawText, maxChars) {
    const text = rawText.replace(/\r\n/g, '\n');
    const len = text.length;
    const chunks = [];
    const isWhitespace = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
    const sentenceEnders = new Set(['।', '॥', '.', '!', '?', '…']);

    let start = 0;
    while (start < len) {
      while (start < len && isWhitespace(text[start])) start++;
      if (start >= len) break;

      if (len - start <= maxChars) {
        const piece = text.slice(start).trim();
        if (piece) chunks.push(piece);
        break;
      }

      const hardLimit = start + maxChars;
      let cut = -1;

      // 1) paragraph break
      const paraBreak = text.lastIndexOf('\n\n', hardLimit);
      if (paraBreak > start) cut = paraBreak + 2;

      // 2) sentence end followed by whitespace/end
      if (cut === -1) {
        for (let i = Math.min(hardLimit, len - 1); i > start; i--) {
          if (sentenceEnders.has(text[i]) && (i + 1 >= len || isWhitespace(text[i + 1]))) {
            cut = i + 1;
            break;
          }
        }
      }

      // 3) nearest whitespace (word boundary)
      if (cut === -1) {
        for (let i = Math.min(hardLimit, len - 1); i > start; i--) {
          if (isWhitespace(text[i])) {
            cut = i;
            break;
          }
        }
      }

      // 4) last resort — a single token longer than maxChars
      if (cut === -1 || cut <= start) cut = hardLimit;

      const piece = text.slice(start, cut).trim();
      if (piece) chunks.push(piece);
      start = cut;
    }

    return chunks;
  }

  // ---------------------------------------------------------------------
  // IndexedDB helpers (stores generated MP3 blobs so a page reload can resume)
  // ---------------------------------------------------------------------
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, blob) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGet(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbDeleteByPrefix(prefix) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          if (String(cursor.key).startsWith(prefix)) cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function chunkAudioKey(jobId, index) {
    return `${jobId}::${index}`;
  }

  // ---------------------------------------------------------------------
  // Job persistence (localStorage holds text + status, IndexedDB holds audio)
  // ---------------------------------------------------------------------
  function saveJobRecord() {
    const record = {
      voiceId: state.voiceId,
      modelId: state.modelId,
      chunks: state.chunks.map((c) => ({
        index: c.index,
        text: c.text,
        status: c.status === 'loading' ? 'pending' : c.status, // don't persist mid-flight state
        error: c.error || null,
      })),
      updatedAt: Date.now(),
    };
    try {
      localStorage.setItem(LS_KEYS.jobPrefix + state.jobId, JSON.stringify(record));
    } catch (e) {
      // Storage full or unavailable — generation still works, resume just won't.
      console.warn('Could not persist job record:', e);
    }
  }

  function loadJobRecord(jobId) {
    try {
      const raw = localStorage.getItem(LS_KEYS.jobPrefix + jobId);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function clearJobRecord(jobId) {
    localStorage.removeItem(LS_KEYS.jobPrefix + jobId);
  }

  // ---------------------------------------------------------------------
  // Saved voices
  // ---------------------------------------------------------------------
  function getSavedVoices() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEYS.savedVoices) || '[]');
    } catch (e) {
      return [];
    }
  }

  function setSavedVoices(list) {
    localStorage.setItem(LS_KEYS.savedVoices, JSON.stringify(list));
  }

  function renderSavedVoices() {
    const voices = getSavedVoices();
    el.savedVoiceSelect.innerHTML = '<option value="">Saved voices…</option>';
    voices.forEach((v, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${v.name} (${v.voiceId})`;
      el.savedVoiceSelect.appendChild(opt);
    });
  }

  el.saveVoiceBtn.addEventListener('click', () => {
    const name = el.voiceNameInput.value.trim();
    const voiceId = el.voiceIdInput.value.trim();
    if (!name || !voiceId) {
      alert('Enter a Voice ID above and a name for it before saving.');
      return;
    }
    const voices = getSavedVoices();
    voices.push({ name, voiceId });
    setSavedVoices(voices);
    renderSavedVoices();
    el.voiceNameInput.value = '';
  });

  el.savedVoiceSelect.addEventListener('change', () => {
    const idx = el.savedVoiceSelect.value;
    if (idx === '') return;
    const voices = getSavedVoices();
    const v = voices[Number(idx)];
    if (v) el.voiceIdInput.value = v.voiceId;
  });

  el.deleteVoiceBtn.addEventListener('click', () => {
    const idx = el.savedVoiceSelect.value;
    if (idx === '') {
      alert('Select a saved voice first.');
      return;
    }
    const voices = getSavedVoices();
    voices.splice(Number(idx), 1);
    setSavedVoices(voices);
    renderSavedVoices();
  });

  // ---------------------------------------------------------------------
  // Script input / char count / autosave
  // ---------------------------------------------------------------------
  function updateCharCount() {
    const n = el.scriptInput.value.length;
    el.charCount.textContent = `${n.toLocaleString('en-IN')} characters`;
  }

  el.scriptInput.addEventListener('input', () => {
    updateCharCount();
    try {
      localStorage.setItem(LS_KEYS.lastScript, el.scriptInput.value);
    } catch (e) {
      /* ignore */
    }
  });

  el.voiceIdInput.addEventListener('input', () => {
    try {
      localStorage.setItem(LS_KEYS.lastVoice, el.voiceIdInput.value);
    } catch (e) {
      /* ignore */
    }
  });

  el.modelInput.addEventListener('input', () => {
    try {
      localStorage.setItem(LS_KEYS.lastModel, el.modelInput.value);
    } catch (e) {
      /* ignore */
    }
  });

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function statusLabel(status) {
    switch (status) {
      case 'success': return 'Done';
      case 'loading': return 'Generating…';
      case 'error': return 'Failed';
      default: return 'Waiting';
    }
  }

  function renderChunkList() {
    el.chunkList.innerHTML = '';
    state.chunks.forEach((c) => {
      const li = document.createElement('li');
      li.className = `chunkrow chunkrow--${c.status}`;
      li.dataset.index = String(c.index);

      const main = document.createElement('div');
      main.className = 'chunkrow__main';

      const title = document.createElement('div');
      title.className = 'chunkrow__title';
      title.textContent = `Chunk ${c.index + 1} of ${state.chunks.length} — ${statusLabel(c.status)}`;
      main.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'chunkrow__meta' + (c.status === 'error' ? ' chunkrow__meta--error' : '');
      meta.textContent = c.status === 'error' && c.error ? c.error : `${c.text.length} characters`;
      main.appendChild(meta);

      li.appendChild(main);

      const actions = document.createElement('div');
      actions.className = 'chunkrow__actions';

      if (c.status === 'success') {
        const dl = document.createElement('button');
        dl.type = 'button';
        dl.className = 'btn btn--ghost btn--small';
        dl.textContent = 'Download';
        dl.addEventListener('click', () => downloadChunk(c.index));
        actions.appendChild(dl);
      }

      if (c.status === 'error') {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn btn--ghost btn--small';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => retryChunk(c.index));
        actions.appendChild(retry);
      }

      li.appendChild(actions);
      el.chunkList.appendChild(li);
    });
  }

  function updateProgressUI() {
    const total = state.chunks.length;
    const done = state.chunks.filter((c) => c.status === 'success').length;
    const errored = state.chunks.filter((c) => c.status === 'error').length;
    const generatedChars = state.chunks
      .filter((c) => c.status === 'success')
      .reduce((sum, c) => sum + c.text.length, 0);
    const currentIndex = state.chunks.findIndex((c) => c.status === 'loading');
    const percent = total ? Math.round(((done + errored) / total) * 100) : 0;

    el.progressChunkLabel.textContent =
      currentIndex >= 0
        ? `Chunk ${currentIndex + 1} / ${total}`
        : `Chunk ${Math.min(done + errored, total)} / ${total}`;
    el.progressPercent.textContent = `${percent}%`;
    el.progressFill.style.width = `${percent}%`;
    el.progressChars.textContent = `${generatedChars.toLocaleString('en-IN')} characters generated`;
    el.progressErrors.textContent = errored ? `${errored} chunk(s) failed` : '';

    el.retryFailedBtn.hidden = errored === 0;

    if (!state.running && total > 0 && done + errored === total) {
      if (errored === 0) {
        el.statusBanner.textContent = '✓ Finished — all chunks generated successfully.';
        el.statusBanner.className = 'statusline statusline--success';
        el.finalActions.hidden = false;
      } else {
        el.statusBanner.textContent = `Finished with ${errored} error(s). Retry failed chunks above, or merge/download the successful ones.`;
        el.statusBanner.className = 'statusline statusline--error';
        el.finalActions.hidden = false;
      }
    } else if (state.running) {
      el.statusBanner.textContent = 'Generating…';
      el.statusBanner.className = 'statusline';
      el.finalActions.hidden = true;
    }
  }

  function renderAll() {
    renderChunkList();
    updateProgressUI();
  }

  // ---------------------------------------------------------------------
  // Generation
  // ---------------------------------------------------------------------
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function generateOneChunk(chunk) {
    const maxAttempts = CONFIG.maxRetries + 1;
    let lastError = 'Unknown error.';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: chunk.text,
            voice_id: state.voiceId,
            model_id: state.modelId,
          }),
        });

        if (resp.ok) {
          const blob = await resp.blob();
          await idbSet(chunkAudioKey(state.jobId, chunk.index), blob);
          return { ok: true };
        }

        let message = `Request failed (status ${resp.status}).`;
        try {
          const errJson = await resp.json();
          if (errJson && errJson.error) message = errJson.error;
        } catch (e) {
          /* keep generic message */
        }
        lastError = message;

        // Don't retry on errors that won't fix themselves (bad voice id, bad key, bad request)
        if ([400, 401, 404].includes(resp.status)) {
          return { ok: false, error: message };
        }
      } catch (networkErr) {
        lastError = `Network error: ${networkErr.message}`;
      }

      if (attempt < maxAttempts) {
        await sleep(CONFIG.retryBaseDelayMs * attempt);
      }
    }

    return { ok: false, error: `${lastError} (gave up after ${maxAttempts} attempts)` };
  }

  async function runGeneration() {
    if (state.running) return;
    state.running = true;
    el.generateBtn.disabled = true;
    el.progressSection.hidden = false;
    el.chunkSection.hidden = false;
    el.finalActions.hidden = true;
    renderAll();

    for (const chunk of state.chunks) {
      if (chunk.status === 'success') continue; // never regenerate a completed chunk
      chunk.status = 'loading';
      chunk.error = null;
      renderAll();

      const result = await generateOneChunk(chunk);
      if (result.ok) {
        chunk.status = 'success';
      } else {
        chunk.status = 'error';
        chunk.error = result.error;
      }
      saveJobRecord();
      renderAll();
    }

    state.running = false;
    el.generateBtn.disabled = false;
    renderAll();
  }

  async function retryChunk(index) {
    if (state.running) return;
    const chunk = state.chunks.find((c) => c.index === index);
    if (!chunk) return;
    state.running = true;
    chunk.status = 'loading';
    chunk.error = null;
    renderAll();

    const result = await generateOneChunk(chunk);
    chunk.status = result.ok ? 'success' : 'error';
    chunk.error = result.ok ? null : result.error;
    saveJobRecord();
    state.running = false;
    renderAll();
  }

  el.retryFailedBtn.addEventListener('click', async () => {
    if (state.running) return;
    state.running = true;
    el.generateBtn.disabled = true;
    for (const chunk of state.chunks) {
      if (chunk.status !== 'error') continue;
      chunk.status = 'loading';
      chunk.error = null;
      renderAll();
      const result = await generateOneChunk(chunk);
      chunk.status = result.ok ? 'success' : 'error';
      chunk.error = result.ok ? null : result.error;
      saveJobRecord();
      renderAll();
    }
    state.running = false;
    el.generateBtn.disabled = false;
    renderAll();
  });

  // ---------------------------------------------------------------------
  // Downloads / merge
  // ---------------------------------------------------------------------
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function padNum(n, width) {
    return String(n).padStart(width, '0');
  }

  async function downloadChunk(index) {
    const blob = await idbGet(chunkAudioKey(state.jobId, index));
    if (!blob) {
      alert('Audio for this chunk was not found. Try regenerating it.');
      return;
    }
    triggerDownload(blob, `chunk_${padNum(index + 1, 3)}.mp3`);
  }

  el.downloadAllBtn.addEventListener('click', async () => {
    const successChunks = state.chunks.filter((c) => c.status === 'success');
    if (!successChunks.length) {
      alert('No generated chunks yet.');
      return;
    }

    if (window.JSZip) {
      const zip = new window.JSZip();
      for (const c of successChunks) {
        const blob = await idbGet(chunkAudioKey(state.jobId, c.index));
        if (blob) zip.file(`chunk_${padNum(c.index + 1, 3)}.mp3`, blob);
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      triggerDownload(zipBlob, 'kannada_audio_chunks.zip');
    } else {
      // Fallback: sequential individual downloads
      for (const c of successChunks) {
        await downloadChunk(c.index);
        await sleep(400);
      }
    }
  });

  el.mergeAllBtn.addEventListener('click', async () => {
    const successChunks = state.chunks
      .filter((c) => c.status === 'success')
      .sort((a, b) => a.index - b.index);

    if (!successChunks.length) {
      alert('No generated chunks yet.');
      return;
    }
    if (successChunks.length < state.chunks.length) {
      const proceed = confirm(
        `${state.chunks.length - successChunks.length} chunk(s) have not been generated yet. Merge only the ${successChunks.length} completed chunk(s) in order?`
      );
      if (!proceed) return;
    }

    const blobs = [];
    for (const c of successChunks) {
      const blob = await idbGet(chunkAudioKey(state.jobId, c.index));
      if (blob) blobs.push(blob);
    }
    const merged = new Blob(blobs, { type: 'audio/mpeg' });
    triggerDownload(merged, 'kannada_narration_merged.mp3');
  });

  // ---------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------
  el.resetBtn.addEventListener('click', async () => {
    const proceed = confirm('Start a new script? This clears the current chunk list (saved voices are kept).');
    if (!proceed) return;
    if (state.jobId) {
      clearJobRecord(state.jobId);
      await idbDeleteByPrefix(state.jobId);
    }
    state = { jobId: null, voiceId: '', modelId: '', chunks: [], running: false };
    el.progressSection.hidden = true;
    el.chunkSection.hidden = true;
    el.finalActions.hidden = true;
    el.chunkList.innerHTML = '';
  });

  // ---------------------------------------------------------------------
  // Generate button / job setup
  // ---------------------------------------------------------------------
  el.generateBtn.addEventListener('click', () => {
    const scriptText = el.scriptInput.value;
    const voiceId = el.voiceIdInput.value.trim();
    const modelId = el.modelInput.value.trim() || 'eleven_multilingual_v2';

    if (!scriptText.trim()) {
      alert('Paste a Kannada script first.');
      return;
    }
    if (!voiceId) {
      alert('Enter an ElevenLabs Voice ID first.');
      return;
    }

    const jobId = makeJobId(scriptText.trim(), voiceId, modelId);
    const existing = loadJobRecord(jobId);

    state.jobId = jobId;
    state.voiceId = voiceId;
    state.modelId = modelId;

    if (existing && existing.chunks && existing.chunks.length) {
      // Same script + voice + model as a previous run: reuse progress.
      state.chunks = existing.chunks.map((c) => ({
        index: c.index,
        text: c.text,
        status: c.status === 'success' ? 'success' : 'pending',
        error: c.error || null,
      }));
    } else {
      const pieces = splitScript(scriptText.trim(), CONFIG.maxChunkChars);
      state.chunks = pieces.map((text, index) => ({ index, text, status: 'pending', error: null }));
      saveJobRecord();
    }

    el.resumeBanner.hidden = true;
    runGeneration();
  });

  // ---------------------------------------------------------------------
  // Resume detection on load
  // ---------------------------------------------------------------------
  function checkForResumableJob() {
    const scriptText = el.scriptInput.value.trim();
    const voiceId = el.voiceIdInput.value.trim();
    const modelId = el.modelInput.value.trim() || 'eleven_multilingual_v2';
    if (!scriptText || !voiceId) return;

    const jobId = makeJobId(scriptText, voiceId, modelId);
    const existing = loadJobRecord(jobId);
    if (!existing || !existing.chunks || !existing.chunks.length) return;

    const done = existing.chunks.filter((c) => c.status === 'success').length;
    if (done === 0) return; // nothing to resume yet

    pendingResumeJob = { jobId, voiceId, modelId, record: existing };
    el.resumeText.textContent = `Found a previous job for this script (${done} / ${existing.chunks.length} chunks already generated).`;
    el.resumeBanner.hidden = false;
  }

  el.resumeBtn.addEventListener('click', () => {
    if (!pendingResumeJob) return;
    const { jobId, voiceId, modelId, record } = pendingResumeJob;
    state.jobId = jobId;
    state.voiceId = voiceId;
    state.modelId = modelId;
    state.chunks = record.chunks.map((c) => ({
      index: c.index,
      text: c.text,
      status: c.status === 'success' ? 'success' : 'pending',
      error: c.error || null,
    }));
    el.resumeBanner.hidden = true;
    runGeneration();
  });

  el.dismissResumeBtn.addEventListener('click', () => {
    el.resumeBanner.hidden = true;
    pendingResumeJob = null;
  });

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  function init() {
    renderSavedVoices();

    try {
      const lastScript = localStorage.getItem(LS_KEYS.lastScript);
      if (lastScript) el.scriptInput.value = lastScript;
      const lastVoice = localStorage.getItem(LS_KEYS.lastVoice);
      if (lastVoice) el.voiceIdInput.value = lastVoice;
      const lastModel = localStorage.getItem(LS_KEYS.lastModel);
      if (lastModel) el.modelInput.value = lastModel;
    } catch (e) {
      /* ignore */
    }

    updateCharCount();
    checkForResumableJob();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
