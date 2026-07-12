import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { reportClientError } from './store/appStore.js';
import { registerM3 } from './contrib/m3-editor.js';
import { registerM4 } from './contrib/m4-search-terminal.js';
import { initRegistry } from './workbench/Workbench.js';
import { useWorkspaceStore } from './store/workspaceStore.js';
import { useEditorStore } from './store/editorStore.js';

registerM3();
registerM4();
initRegistry.push(() => {
  useEditorStore.getState().init();
  void useWorkspaceStore.getState().init();
});
import './styles/theme.css';
import './styles/workbench.css';

window.addEventListener('error', (event) => {
  void reportClientError('RENDERER_ERROR', String(event.message ?? 'unknown'), event.error?.stack);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason as { message?: string; stack?: string } | undefined;
  void reportClientError(
    'RENDERER_UNHANDLED_REJECTION',
    String(reason?.message ?? event.reason ?? 'unknown'),
    reason?.stack,
  );
});

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
