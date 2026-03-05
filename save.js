<script>
(() => {
  // Make sure we have a Module object to extend
  window.Module = window.Module || {};

  // -------------------- Configuration --------------------
  // Where we mount IndexedDB-backed filesystem
  const SAVE_MOUNT_DIR = '/idb';

  // Filenames we consider "save/config data" for Sonic CD builds
  // (Your build uses UData.bin; we include others for robustness.)
  const CANDIDATE_NAMES = [
    'UData.bin',     // ← your actual save file
    'settings.ini',  // options/config (often present)
    'SData.bin',     // alt names seen in other forks/builds
    'sdata.bin',
    'TAData.bin'
  ];

  // Poll frequency (ms) to detect when the game writes/updates a save
  const POLL_MS = 2000;
  // Debounce window (ms) before flushing changes to IndexedDB
  const FLUSH_DEBOUNCE_MS = 800;

  // -------------------- FS helpers --------------------
  function ensureDir(path) { try { FS.mkdirTree(path); } catch (e) {} }
  function exists(path)     { try { return FS.analyzePath(path).exists; } catch (e) { return false; } }
  function isDir(path)      { try { const s = FS.stat(path); return !!(s.mode & 0x4000); } catch (e) { return false; } }
  function read(path)       { return FS.readFile(path, { encoding: 'binary' }); }
  function write(path,data) { FS.writeFile(path, data, { encoding: 'binary' }); }
  function safeList(path)   { try { return FS.readdir(path).filter(n => n !== '.' && n !== '..'); } catch (e) { return []; } }

  function join(a, b) { return a === '/' ? `/${b}` : `${a}/${b}`; }

  // Recursively list files under a directory (best‑effort)
  function listRecursive(root) {
    const out = [];
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      for (const name of safeList(dir)) {
        const p = join(dir, name);
        if (isDir(p)) stack.push(p);
        else out.push(p);
      }
    }
    return out;
  }

  // Locate any candidate save files anywhere in common roots
  function findCandidatePaths() {
    const roots = ['/', '/home', '/home/web_user', '/tmp'];
    const found = new Set();
    for (const r of roots) {
      for (const p of listRecursive(r)) {
        const base = p.split('/').pop();
        if (CANDIDATE_NAMES.includes(base)) found.add(p);
      }
    }
    return Array.from(found);
  }

  // Copy with overwrite control
  function copy(src, dst, overwrite=false) {
    try {
      if (!exists(src)) return false;
      if (!overwrite && exists(dst)) return false;
      write(dst, read(src));
      return true;
    } catch (e) {
      console.warn('[save.js] Copy failed', src, '→', dst, e);
      return false;
    }
  }

  // -------------------- IDBFS Sync helpers --------------------
  function populateFromIDB(done) {
    // Direction: IndexedDB → memory
    FS.syncfs(true, (err) => {
      if (err) {
        console.error('[save.js] IDBFS populate error:', err);
        return done && done(err);
      }

      // After populate, copy known files from /idb back to their expected root names if missing.
      try {
        const names = safeList(SAVE_MOUNT_DIR);
        for (const name of names) {
          if (!CANDIDATE_NAMES.includes(name)) continue;
          const idbPath  = join(SAVE_MOUNT_DIR, name);
          const rootPath = `/${name}`;
          if (!exists(rootPath)) {
            copy(idbPath, rootPath, /*overwrite=*/false);
          }
        }
      } catch (e) {
        console.warn('[save.js] post-populate copy-back failed:', e);
      }

      done && done(null);
    });
  }

  function flushToIDB(done) {
    // Mirror discovered candidates into /idb before flush
    try {
      const candidates = findCandidatePaths();
      for (const full of candidates) {
        const name = full.split('/').pop();
        copy(full, join(SAVE_MOUNT_DIR, name), /*overwrite=*/true);
      }
    } catch (e) {
      console.warn('[save.js] mirroring to /idb failed:', e);
    }

    // Direction: memory → IndexedDB
    FS.syncfs(false, (err) => {
      if (err) console.error('[save.js] IDBFS flush error:', err);
      done && done(err);
    });
  }

  // -------------------- Change detection & lifecycle --------------------
  let lastSizes = Object.create(null);
  let flushTimer;

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      try { flushToIDB(); } catch (e) {}
    }, FLUSH_DEBOUNCE_MS);
  }

  function pollForChanges() {
    try {
      const candidates = findCandidatePaths();
      for (const p of candidates) {
        try {
          const size = FS.stat(p).size;
          if (lastSizes[p] !== size) {
            lastSizes[p] = size;
            scheduleFlush();
          }
        } catch (_) {/* transient; ignore */}
      }
    } catch (e) {/* ignore */}
  }

  // Flush on tab/page lifecycle events as a safety net
  function attachLifecycleFlush() {
    const safeFlush = () => { try { flushToIDB(); } catch (e) {} };
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') safeFlush();
    });
    window.addEventListener('pagehide', safeFlush);
    window.addEventListener('beforeunload', safeFlush);
  }

  // -------------------- Wire into Emscripten lifecycle --------------------
  Module.preRun  = Module.preRun  || [];
  Module.postRun = Module.postRun || [];

  Module.preRun.push(() => {
    // At this point, FS & runtime are ready to be configured
    if (typeof FS === 'undefined' || typeof IDBFS === 'undefined') {
      console.warn('[save.js] FS/IDBFS not available. If persistence fails, rebuild with: -sFORCE_FILESYSTEM=1 -lidbfs.js');
      return;
    }

    // Mount /idb (IDBFS)
    try { ensureDir(SAVE_MOUNT_DIR); } catch (e) {}
    FS.mount(IDBFS, { autoPersist: true }, SAVE_MOUNT_DIR);

    // Populate from IndexedDB → memory before the game starts
    populateFromIDB((err) => {
      if (!err) {
        // Start polling once populated
        setInterval(pollForChanges, POLL_MS);
      }
    });

    // Ensure lifecycle flushing is active
    attachLifecycleFlush();
  });

})();
</script>
