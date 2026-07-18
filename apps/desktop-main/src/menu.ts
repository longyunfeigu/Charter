import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import { broadcast } from './broadcast.js';

const send = (action: string) => () => broadcast('app.menuAction', { action });

/** APP-007: full application menu; every entry maps to a renderer command. */
export function installApplicationMenu(opts: { isDev: boolean }): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { label: 'About Charter', click: send('app.about') },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'Cmd+,', click: send('app.openSettings') },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ] as MenuItemConstructorOptions[],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: send('workspace.openFolder') },
        { label: 'Close Workspace', click: send('workspace.close') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('editor.save') },
        {
          label: 'Save All',
          accelerator: isMac ? 'Cmd+Alt+S' : 'Ctrl+K S',
          click: send('editor.saveAll'),
        },
        ...(!isMac
          ? ([
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'Ctrl+,', click: send('app.openSettings') },
              { type: 'separator' },
              { role: 'quit' },
            ] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in File', accelerator: 'CmdOrCtrl+F', click: send('editor.find') },
        {
          label: 'Search in Workspace',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: send('search.global'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Command Palette…',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: send('palette.open'),
        },
        { label: 'Quick Open…', accelerator: 'CmdOrCtrl+P', click: send('quickopen.open') },
        { type: 'separator' },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          click: send('view.zoomIn'),
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: send('view.zoomOut'),
        },
        {
          label: 'Reset Zoom',
          accelerator: 'CmdOrCtrl+0',
          click: send('view.zoomReset'),
        },
        { type: 'separator' },
        { label: 'Explorer', accelerator: 'CmdOrCtrl+Shift+E', click: send('view.explorer') },
        { label: 'Search', click: send('view.search') },
        { label: 'Source Control', accelerator: 'Ctrl+Shift+G', click: send('view.scm') },
        { label: 'Tasks', click: send('view.tasks') },
        { type: 'separator' },
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: send('layout.toggleSidebar'),
        },
        {
          label: 'Toggle Agent Panel',
          accelerator: 'CmdOrCtrl+L',
          click: send('layout.toggleAgentPanel'),
        },
        {
          label: 'Toggle Bottom Panel',
          accelerator: 'CmdOrCtrl+J',
          click: send('layout.toggleBottomPanel'),
        },
        { type: 'separator' },
        { label: 'Theme: Light', click: send('theme.light') },
        { label: 'Theme: Dark', click: send('theme.dark') },
        { label: 'Theme: System', click: send('theme.system') },
        {
          label: 'Skin',
          submenu: [
            { label: 'Studio', click: send('skin.studio') },
            { label: 'Terminal', click: send('skin.terminal') },
            { label: 'Archive', click: send('skin.archive') },
            { label: 'Index', click: send('skin.index') },
          ],
        },
        ...(opts.isDev
          ? ([{ type: 'separator' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: 'Terminal',
      submenu: [
        { label: 'New Terminal', accelerator: 'Ctrl+`', click: send('terminal.new') },
        { label: 'Kill Active Terminal', click: send('terminal.kill') },
      ],
    },
    {
      label: 'Agent',
      submenu: [
        { label: 'New Task…', accelerator: 'CmdOrCtrl+N', click: send('task.new') },
        {
          label: 'Stop Agent',
          accelerator: isMac ? 'Cmd+Escape' : 'Ctrl+Escape',
          click: send('task.stop'),
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ role: 'front' } as MenuItemConstructorOptions] : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About Charter', click: send('app.about') },
        { label: 'Diagnostics', click: send('app.openDiagnostics') },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
