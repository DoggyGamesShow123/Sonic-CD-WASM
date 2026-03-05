<!-- save.js -->
<script>
// Wrap in an IIFE to avoid globals
(() => {
  // If the upstream glue defines Module later, make sure we keep a single object.
  window.Module = window.Module || {};
  const SAVE_DIR = '/idb';

  // ⚠️ Adjust this list once you confirm the exact save names in DevTools:
  const SAVE_FILES = ['sdata.bin', 'SData.bin', 'TAData.bin']; // add/remove as needed

  // Utilities
  function ensureDir(path) { try { FS.mkdirTree(path); } catch (e) {} }
  function exists(path)     { try { return FS.analyzePath(path).exists; } catch (e) { return false; } }
  function read(path)       { return FS.readFile(path, { encoding: 'binary' }); }
  function write(path,data) { FS.writeFile(path, data, { encoding: 'binary' }); }

  function copy(src, dst, overwrite=false) {
    try {
      if (!exists(src)) return false;
      if (!overwrite && exists(dst)) return false;
      write(dst, read(src));
      return true;
    } catch (e) {
      console.warn('Copy failed', src, '→', dst, e);
      return false;
    }
  }

  function syncFromIDB(done) {
    FS.syncfs(true, (err) => {
      if (err) console.error('IDBFS populate error:', err);
      else {
        for (const f of SAVE_FILES) {
          // Only pull into root if the game hasn't created a new one yet.
          copy(`${SAVE_DIR}/${f}`, `/${f}`, /*overwrite=*/false);
        }
      }
      done && done(err);
    });
  }

  function syncToIDB(done) {
    for (const f of SAVE_FILES) {
      if (exists(`/${f}`)) {
        // Mirror the latest root save into IDB mount
        copy(`/${f}`, `${SAVE_DIR}/${f}`, /*overwrite=*/true);
      }
    }
    FS.syncfs(false, (err) => {
      if (err) console.error('IDBFS flush error:', err);
      done && done(err);
    });
  }

  // Hook into Emscripten lifecycle
  Module.preRun = Module.preRun || [];
  Module.postRun = Module.postRun || [];

  Module.preRun.push(() => {
    // Ensure FS/IDBFS are present (most packaging builds include them).
    if (typeof FS === 'undefined' || typeof IDBFS === 'undefined') {
      console.warn(
        'FS/IDBFS not available. If saves still don’t persist, rebuild with -sFORCE_FILESYSTEM=1 and -lidbfs.js'
      );
      return;
    }
    ensureDir(SAVE_DIR);
    // autoPersist helps Emscripten keep IndexedDB in sync between sessions
    FS.mount(IDBFS, { autoPersist: true }, SAVE_DIR); // autoPersist option discussed in community usage
  });

  // Populate as early as possible (before main())
  // preRun happens before main(), but syncfs is async—kick it off immediately:
  document.addEventListener('DOMContentLoaded', () => {
    if (typeof FS !== 'undefined') {
      try { syncFromIDB(); } catch (e) { console.warn(e); }
    }
  });

  // Save heuristics: debounce + periodic flush + lifecycle events
  let saveDebounce;
  function scheduleSave() {
    clearTimeout(saveDebounce);
    saveDebounce = setTimeout(() => { try { syncToIDB(); } catch(e){} }, 1000);
  }

  const POLL_MS = 3000;
  let lastSizes = Object.create(null);
  setInterval(() => {
    if (typeof FS === 'undefined') return;
    for (const f of SAVE_FILES) {
      if (exists(`/${f}`)) {
        const size = FS.stat(`/${f}`).size;
        if (lastSizes[f] !== size) {
          lastSizes[f] = size;
          scheduleSave();
        }
      }
    }
  }, POLL_MS);

  // Flush on tab hide/close
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') try { syncToIDB(); } catch(e){}
  });
  window.addEventListener('pagehide', () => { try { syncToIDB(); } catch(e){} });
  window.addEventListener('beforeunload', () => { try { syncToIDB(); } catch(e){} });

})();
</script>
