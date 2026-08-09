import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { AppLocale } from '@pi-ide/ipc-contracts';
import { broadcast } from './broadcast.js';
import { mainT } from './i18n.js';

const send = (action: string) => () => broadcast('app.menuAction', { action });

/** APP-007: full application menu; every entry maps to a renderer command. */
export function installApplicationMenu(opts: { isDev: boolean; locale: AppLocale }): void {
  const isMac = process.platform === 'darwin';
  const t = (message: string): string => mainT(opts.locale, message);

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: 'Charter',
            submenu: [
              { label: t('About Charter'), click: send('app.about') },
              { type: 'separator' },
              { label: t('Settings…'), accelerator: 'Cmd+,', click: send('app.openSettings') },
              { type: 'separator' },
              { label: t('Services'), role: 'services' },
              { type: 'separator' },
              { label: t('Hide Charter'), role: 'hide' },
              { label: t('Hide Others'), role: 'hideOthers' },
              { label: t('Show All'), role: 'unhide' },
              { type: 'separator' },
              { label: t('Quit Charter'), role: 'quit' },
            ] as MenuItemConstructorOptions[],
          },
        ]
      : []),
    {
      label: t('File'),
      submenu: [
        {
          label: t('Open Folder…'),
          accelerator: 'CmdOrCtrl+O',
          click: send('workspace.openFolder'),
        },
        { label: t('Close Workspace'), click: send('workspace.close') },
        { type: 'separator' },
        { label: t('Save'), accelerator: 'CmdOrCtrl+S', click: send('editor.save') },
        {
          label: t('Save All'),
          accelerator: isMac ? 'Cmd+Alt+S' : 'Ctrl+K S',
          click: send('editor.saveAll'),
        },
        ...(!isMac
          ? ([
              { type: 'separator' },
              { label: t('Settings…'), accelerator: 'Ctrl+,', click: send('app.openSettings') },
              { type: 'separator' },
              { label: t('Quit'), role: 'quit' },
            ] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: t('Edit'),
      submenu: [
        { label: t('Undo'), role: 'undo' },
        { label: t('Redo'), role: 'redo' },
        { type: 'separator' },
        { label: t('Cut'), role: 'cut' },
        { label: t('Copy'), role: 'copy' },
        { label: t('Paste'), role: 'paste' },
        { label: t('Select All'), role: 'selectAll' },
        { type: 'separator' },
        { label: t('Find in File'), accelerator: 'CmdOrCtrl+F', click: send('editor.find') },
        {
          label: t('Search in Workspace'),
          accelerator: 'CmdOrCtrl+Shift+F',
          click: send('search.global'),
        },
      ],
    },
    {
      label: t('View'),
      submenu: [
        {
          label: t('Command Palette…'),
          accelerator: 'CmdOrCtrl+Shift+P',
          click: send('palette.open'),
        },
        { label: t('Quick Open…'), accelerator: 'CmdOrCtrl+P', click: send('quickopen.open') },
        { type: 'separator' },
        {
          label: t('Zoom In'),
          accelerator: 'CmdOrCtrl+Plus',
          click: send('view.zoomIn'),
        },
        {
          label: t('Zoom Out'),
          accelerator: 'CmdOrCtrl+-',
          click: send('view.zoomOut'),
        },
        {
          label: t('Reset Zoom'),
          accelerator: 'CmdOrCtrl+0',
          click: send('view.zoomReset'),
        },
        { type: 'separator' },
        { label: t('Explorer'), accelerator: 'CmdOrCtrl+Shift+E', click: send('view.explorer') },
        { label: t('Search'), click: send('view.search') },
        { label: t('Source Control'), accelerator: 'Ctrl+Shift+G', click: send('view.scm') },
        { label: t('Tasks'), click: send('view.tasks') },
        { type: 'separator' },
        {
          label: t('Toggle Sidebar'),
          accelerator: 'CmdOrCtrl+B',
          click: send('layout.toggleSidebar'),
        },
        {
          label: t('Toggle Agent Panel'),
          accelerator: 'CmdOrCtrl+L',
          click: send('layout.toggleAgentPanel'),
        },
        {
          label: t('Toggle Bottom Panel'),
          accelerator: 'CmdOrCtrl+J',
          click: send('layout.toggleBottomPanel'),
        },
        { type: 'separator' },
        { label: t('Theme: Light'), click: send('theme.light') },
        { label: t('Theme: Dark'), click: send('theme.dark') },
        { label: t('Theme: System'), click: send('theme.system') },
        {
          label: t('Skin'),
          submenu: [
            { label: 'Studio', click: send('skin.studio') },
            { label: 'Terminal', click: send('skin.terminal') },
            { label: 'Archive', click: send('skin.archive') },
            { label: 'Index', click: send('skin.index') },
            { label: 'Atelier', click: send('skin.atelier') },
            { label: 'Codex', click: send('skin.codex') },
          ],
        },
        ...(opts.isDev
          ? ([{ type: 'separator' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: t('Terminal'),
      submenu: [
        { label: t('New Terminal'), accelerator: 'Ctrl+`', click: send('terminal.new') },
        { label: t('Kill Active Terminal'), click: send('terminal.kill') },
      ],
    },
    {
      label: t('Agent'),
      submenu: [
        { label: t('New Task…'), accelerator: 'CmdOrCtrl+N', click: send('task.new') },
        {
          label: t('Stop Agent'),
          accelerator: isMac ? 'Cmd+Escape' : 'Ctrl+Escape',
          click: send('task.stop'),
        },
      ],
    },
    {
      label: t('Window'),
      submenu: [
        { label: t('Minimize'), role: 'minimize' },
        { label: t('Zoom'), role: 'zoom' },
        ...(isMac
          ? [{ label: t('Bring All to Front'), role: 'front' } as MenuItemConstructorOptions]
          : []),
      ],
    },
    {
      label: t('Help'),
      submenu: [
        { label: t('Check for Updates…'), click: send('app.openUpdates') },
        { type: 'separator' },
        { label: t('About Charter'), click: send('app.about') },
        { label: t('Diagnostics'), click: send('app.openDiagnostics') },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
