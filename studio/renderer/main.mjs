// Studio renderer boot. The preload-exposed window.zukuStudio bridge is the only
// authority; without it the view renders an actionable offline state.
import { mountStudio } from './app.mjs';
import { createStudioClient } from './client.mjs';

const root = document.getElementById('zuku-studio');
const bridge = window.zukuStudio;
let client = null, nativeActions = null;
try {
  client = createStudioClient(bridge);
  nativeActions = {
    pickProject: () => bridge.pickProject(),
    showPreview: value => bridge.showPreview(value),
    hidePreview: () => bridge.hidePreview(),
  };
} catch { client = null; }
const studio = mountStudio({ client, nativeActions, root });
window.addEventListener('pagehide', () => { studio.unmount(); }, { once: true });
