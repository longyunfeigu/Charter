import React, { useEffect, useState } from 'react';
import { Workbench } from './workbench/Workbench.js';
import { StartupErrorView } from './views/StartupErrorView.js';
import { useAppStore } from './store/appStore.js';
import { useAgentCatalogStore } from './store/agentCatalogStore.js';

function parseStartupError(): { code: string; message: string } | null {
  const hash = window.location.hash;
  if (!hash.startsWith('#/startup-error')) return null;
  const query = new URLSearchParams(hash.split('?')[1] ?? '');
  return {
    code: query.get('code') ?? 'APP_STARTUP_FAILED',
    message: query.get('msg') ?? 'The application failed to start.',
  };
}

export function App(): React.JSX.Element {
  const [startupError] = useState(parseStartupError);
  const ready = useAppStore((s) => s.ready);
  const init = useAppStore((s) => s.init);
  const initAgentCatalog = useAgentCatalogStore((state) => state.init);
  const refreshAgentCatalog = useAgentCatalogStore((state) => state.refresh);

  useEffect(() => {
    if (startupError) return;
    initAgentCatalog();
    void init();
    const detectNewAgents = (): void => void refreshAgentCatalog(true);
    window.addEventListener('focus', detectNewAgents);
    return () => window.removeEventListener('focus', detectNewAgents);
  }, [startupError, init, initAgentCatalog, refreshAgentCatalog]);

  if (startupError) {
    return <StartupErrorView code={startupError.code} message={startupError.message} />;
  }
  if (!ready) {
    return (
      <div className="empty-state" data-testid="app-loading">
        Starting…
      </div>
    );
  }
  return <Workbench />;
}
