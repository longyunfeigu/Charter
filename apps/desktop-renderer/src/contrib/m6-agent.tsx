import {
  viewRegistry,
  agentPanelRegistry,
  initRegistry,
  overlayRegistry,
} from '../workbench/Workbench.js';
import { registerCommands } from '../commands.js';
import { TasksView } from '../views/TasksView.js';
import { AgentPanel } from '../views/AgentPanel.js';
import { ReviewView } from '../views/ReviewView.js';
import { ReplayView } from '../views/ReplayView.js';
import { PrDraftCard } from '../views/PrDraftCard.js';
import { useTaskStore } from '../store/taskStore.js';
import { useAppStore } from '../store/appStore.js';
import { useSkillsStore } from '../store/skillsStore.js';

export function registerM6(): void {
  viewRegistry.tasks = TasksView;
  agentPanelRegistry.main = AgentPanel;
  // Review/Replay overlay both surfaces (ADR-0008): they must open from the
  // Task Room (Home surface) as well as from the Editor's agent panel.
  // The PR draft card (ADR-0022) opens only from its durable timeline entry.
  overlayRegistry.push(ReviewView, ReplayView, PrDraftCard);
  initRegistry.push(() => {
    useTaskStore.getState().init();
    useSkillsStore.getState().init();
  });
  registerCommands([
    {
      // ADR-0008 entry consolidation: "new task" means the Home composer.
      // (The Editor's agent panel keeps its own "+ Task" dialog button.)
      id: 'task.new',
      title: 'New Task',
      category: 'Agent',
      keybinding: 'mod+n',
      run: () => {
        const app = useAppStore.getState();
        app.openSessionHome();
        app.focusComposer();
      },
    },
    {
      id: 'task.stop',
      title: 'Stop Agent',
      category: 'Agent',
      keybinding: 'mod+escape',
      run: () => void useTaskStore.getState().stop(),
    },
  ]);
}
