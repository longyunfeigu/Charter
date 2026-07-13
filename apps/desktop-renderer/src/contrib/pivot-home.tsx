import { homeSurfaceRegistry, initRegistry, overlayRegistry } from '../workbench/Workbench.js';
import { registerHomeSurfaceListeners } from '../views/HomeView.js';
import { HomeShell } from '../views/HomeShell.js';
import { QuickLauncher } from '../views/QuickLauncher.js';
import { registerCommands } from '../commands.js';
import { useAppStore } from '../store/appStore.js';

/** Dual-form shell (ADR-0004): Home task launcher as the default entry.
 * PIVOT-028: the persistent shell keeps the sidebar mounted; Launcher and
 * Task Room swap in its content area. */
export function registerPivotHome(): void {
  homeSurfaceRegistry.main = HomeShell;
  initRegistry.push(registerHomeSurfaceListeners);
  overlayRegistry.push(QuickLauncher);
  registerCommands([
    {
      id: 'surface.home',
      title: 'Go Home (Task Launcher)',
      category: 'View',
      run: () => useAppStore.getState().setSurface('home'),
    },
    {
      id: 'surface.workspace',
      title: 'Open IDE Workspace',
      category: 'View',
      run: () => useAppStore.getState().setSurface('workspace'),
    },
    {
      id: 'launcher.open',
      title: 'Search Everything (Projects, Tasks, Files)',
      category: 'View',
      keybinding: 'mod+k',
      run: () => useAppStore.getState().setLauncherOpen(true),
    },
  ]);
}
