import { app, BrowserWindow, powerMonitor } from 'electron';
import path from 'path';
import { setupSSHIpcHandlers } from './ipc/ssh-handlers';
import { setupAIIpcHandlers } from './ipc/ai-handlers';
import { setupConnectionIpcHandlers } from './ipc/connection-handlers';
import { setupSettingsIpcHandlers } from './ipc/settings-handlers';
import { setupFileIpcHandlers } from './ipc/file-handlers';
import { setupAgentIpcHandlers } from './ipc/agent-handlers';
import { getSettings } from './storage/settings-storage';

let mainWindow: BrowserWindow | null = null;
const APP_NAME = 'AI SSH Client';
const APP_USER_MODEL_ID = 'com.aisshclient.app';

// IPC 通道常量
const DRAG_DROP_CHANNEL = 'drag-drop-files';

app.setName(APP_NAME);
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

async function loadDevURL(window: BrowserWindow, retries = 20) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Attempting to load Vite server... (${i + 1}/${retries})`);
      await window.loadURL('http://localhost:5173');
      console.log('Successfully loaded Vite server!');
      return;
    } catch (error) {
      console.log(`Failed to load, retrying in 1 second...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  console.error('Failed to load Vite server after multiple attempts');
}

function createWindow() {
  console.log('Creating Electron window...');
  console.log('NODE_ENV:', process.env.NODE_ENV);
  console.log('Preload path:', path.join(__dirname, 'preload.js'));

  const settings = getSettings();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // 允许通过 dataTransfer 获取拖拽文件路径
      webviewTag: false,
      // 禁止后台节流：防止窗口最小化/失焦时渲染进程被挂起
      // 避免长时间空闲后恢复时出现白屏和 IPC 消息积压
      backgroundThrottling: false,
    },
    frame: true,
    titleBarStyle: 'default',
    autoHideMenuBar: true, // 默认隐藏菜单栏，按 Alt 显示
    show: false,
    backgroundColor: settings.theme === 'light' ? '#F8FAFC' : '#020617',
  });

  // 处理拖拽文件到窗口的事件 - 阻止导航并获取文件路径
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // 如果拖拽的是文件，阻止导航（避免打开文件）
    if (url.startsWith('file://')) {
      event.preventDefault();
    }
  });

  // 使用 Electron 的原生方式处理文件拖拽
  // 当文件被拖拽到窗口时，Electron 会自动处理
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    // 如果是文件拖拽导致的导航失败，忽略
    if (validatedURL.startsWith('file://')) {
      event.preventDefault();
    }
  });

  mainWindow.once('ready-to-show', () => {
    console.log('Window ready to show');
    mainWindow?.show();
  });

  if (process.env.NODE_ENV === 'development') {
    console.log('Development mode detected');
    // 不默认打开开发者工具，用户可以手动用快捷键打开
    loadDevURL(mainWindow);
  } else {
    console.log('Production mode detected');
    mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  setupSSHIpcHandlers(mainWindow!);
  setupAIIpcHandlers();
  setupConnectionIpcHandlers();
  setupSettingsIpcHandlers(() => mainWindow);
  setupFileIpcHandlers();
  setupAgentIpcHandlers(mainWindow!);

  // 系统从睡眠/挂起恢复时，通知渲染进程检查 SSH 连接
  // SSH keepalive 最多 3 分钟无响应就断开，系统睡眠期间连接必然超时
  powerMonitor.on('resume', () => {
    console.log('System resumed from sleep, notifying renderer to check connections...');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('system-resume', { timestamp: Date.now() });
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
