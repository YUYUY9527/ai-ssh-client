const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const posixPath = require('node:path').posix;

const express = require('express');
const multer = require('multer');
const { Client } = require('ssh2');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.WEB_PORT || 5060);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'config.json');
const STATIC_DIR = path.join(__dirname, '..', 'dist', 'renderer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.SFTP_UPLOAD_LIMIT || 200 * 1024 * 1024) },
});

const defaultSettings = {
  language: 'zh-CN',
  theme: 'dark',
  fontSize: 14,
  fontFamily: "Consolas, 'Courier New', monospace",
  keepaliveInterval: 60,
  keepaliveCountMax: 3,
  autoReconnect: true,
  maxReconnectAttempts: 5,
  showTerminalOutputPrompt: true,
  terminalTheme: 'dark',
  maxPersistedSessions: 8,
  maxScrollbackBytesPerSession: 150 * 1024,
};

const sessions = new Map();
const sockets = new Set();

function success(data) {
  return data === undefined ? { success: true } : { success: true, data };
}

function failure(error) {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

function readStore() {
  try {
    return {
      connections: [],
      settings: defaultSettings,
      commandHistory: [],
      quickCommands: [],
      quickCommandGroups: [],
      aiProviders: [],
      agentTasks: [],
      ...JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')),
    };
  } catch {
    return {
      connections: [],
      settings: defaultSettings,
      commandHistory: [],
      quickCommands: [],
      quickCommandGroups: [],
      aiProviders: [],
      agentTasks: [],
    };
  }
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`);
}

function updateStore(update) {
  const store = readStore();
  update(store);
  writeStore(store);
  return store;
}

function broadcast(type, payload) {
  const data = JSON.stringify({ type, payload });
  sockets.forEach((socket) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(data);
    }
  });
}

function stateFor(connectionId, patch = {}) {
  const session = sessions.get(connectionId);

  return {
    connectionId,
    isConnected: Boolean(session?.ready),
    isConnecting: Boolean(session && !session.ready),
    reconnectAttempts: 0,
    ...patch,
  };
}

function closeSession(connectionId) {
  const session = sessions.get(connectionId);
  if (!session) {
    return;
  }

  sessions.delete(connectionId);
  session.stream?.end();
  session.client.end();
  broadcast('ssh-close', connectionId);
}

function emitSessionClose(connectionId) {
  if (sessions.delete(connectionId)) {
    broadcast('ssh-close', connectionId);
  }
}

function connectSsh(connection, cols, rows, settings = defaultSettings) {
  return new Promise((resolve, reject) => {
    closeSession(connection.id);

    const client = new Client();
    const session = { client, stream: null, sftp: null, ready: false };
    sessions.set(connection.id, session);
    broadcast('ssh-data', {
      connectionId: connection.id,
      data: '',
      type: 'state',
      state: stateFor(connection.id),
    });

    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    client
      .on('ready', () => {
        client.shell(
          {
            term: 'xterm-256color',
            cols: cols || 120,
            rows: rows || 32,
          },
          (error, stream) => {
            if (error) {
              reject(error);
              return;
            }

            session.stream = stream;
            session.ready = true;
            stream
              .on('data', (data) => {
                broadcast('ssh-data', {
                  connectionId: connection.id,
                  data: data.toString('utf8'),
                });
              })
              .on('close', () => {
                emitSessionClose(connection.id);
              })
              .stderr.on('data', (data) => {
                broadcast('ssh-error', {
                  connectionId: connection.id,
                  error: data.toString('utf8'),
                });
              });

            broadcast('ssh-data', {
              connectionId: connection.id,
              data: '',
              type: 'state',
              state: stateFor(connection.id),
            });
            finish(success({ sessionId: connection.id }));
          },
        );
      })
      .on('error', (error) => {
        sessions.delete(connection.id);
        broadcast('ssh-error', { connectionId: connection.id, error: error.message });
        if (!settled) {
          reject(error);
        }
      })
      .on('close', () => {
        emitSessionClose(connection.id);
      })
      .connect({
        host: connection.host,
        port: connection.port || 22,
        username: connection.username,
        password: connection.password || undefined,
        privateKey: connection.privateKey || undefined,
        passphrase: connection.passphrase || undefined,
        keepaliveInterval: Math.max(0, Number(settings.keepaliveInterval || 0)) * 1000,
        keepaliveCountMax: settings.keepaliveCountMax || 3,
        readyTimeout: 20000,
      });
  });
}

function getSession(connectionId) {
  const session = sessions.get(connectionId);
  if (!session?.ready) {
    throw new Error('SSH session is not connected');
  }
  return session;
}

function getSftp(connectionId) {
  const session = getSession(connectionId);
  if (session.sftp) {
    return Promise.resolve(session.sftp);
  }

  return new Promise((resolve, reject) => {
    session.client.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }
      session.sftp = sftp;
      resolve(sftp);
    });
  });
}

function route(handler) {
  return async (request, response) => {
    try {
      response.json(await handler(request, response));
    } catch (error) {
      response.json(failure(error));
    }
  };
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_request, response) => response.json(success({ ok: true })));

app.get('/api/connections', route(() => success({ connections: readStore().connections })));
app.post('/api/connections', route((request) => {
  updateStore((store) => {
    const next = request.body.connection;
    store.connections = [
      ...store.connections.filter((item) => item.id !== next.id),
      next,
    ];
  });
  return success();
}));
app.delete('/api/connections/:id', route((request) => {
  updateStore((store) => {
    store.connections = store.connections.filter((item) => item.id !== request.params.id);
  });
  closeSession(request.params.id);
  return success();
}));

app.get('/api/settings', route(() => success({ settings: readStore().settings })));
app.post('/api/settings', route((request) => {
  updateStore((store) => {
    store.settings = { ...defaultSettings, ...request.body.settings };
  });
  return success();
}));

app.get('/api/command-history', route(() => success({ history: readStore().commandHistory })));
app.post('/api/command-history', route((request) => {
  updateStore((store) => {
    store.commandHistory = [request.body.item, ...store.commandHistory].slice(0, 500);
  });
  return success();
}));
app.delete('/api/command-history', route(() => {
  updateStore((store) => {
    store.commandHistory = [];
  });
  return success();
}));

app.get('/api/quick-commands', route(() => success({ commands: readStore().quickCommands })));
app.post('/api/quick-commands', route((request) => {
  updateStore((store) => {
    const next = request.body.command;
    store.quickCommands = [
      ...store.quickCommands.filter((item) => item.id !== next.id),
      next,
    ];
  });
  return success();
}));
app.delete('/api/quick-commands/:id', route((request) => {
  updateStore((store) => {
    store.quickCommands = store.quickCommands.filter((item) => item.id !== request.params.id);
  });
  return success();
}));

app.get('/api/quick-command-groups', route(() => success({ groups: readStore().quickCommandGroups })));
app.post('/api/quick-command-groups', route((request) => {
  updateStore((store) => {
    const next = request.body.group;
    store.quickCommandGroups = [
      ...store.quickCommandGroups.filter((item) => item.id !== next.id),
      next,
    ];
  });
  return success();
}));
app.delete('/api/quick-command-groups/:id', route((request) => {
  updateStore((store) => {
    store.quickCommandGroups = store.quickCommandGroups.filter((item) => item.id !== request.params.id);
  });
  return success();
}));

app.post('/api/ssh/connect', route((request) => (
  connectSsh(request.body.connection, request.body.cols, request.body.rows, request.body.settings)
)));
app.post('/api/ssh/:id/disconnect', route((request) => {
  closeSession(request.params.id);
  return success();
}));
app.post('/api/ssh/:id/write', route((request) => {
  getSession(request.params.id).stream.write(request.body.command || '');
  return success();
}));
app.post('/api/ssh/:id/resize', route((request) => {
  const { cols, rows } = request.body;
  getSession(request.params.id).stream.setWindow(rows, cols);
  return success();
}));
app.get('/api/ssh/sessions', route(() => success({
  sessions: Array.from(sessions.keys()).map((connectionId) => stateFor(connectionId)),
})));
app.post('/api/ssh/test', route((request) => new Promise((resolve) => {
  const client = new Client();
  client
    .on('ready', () => {
      client.end();
      resolve(success());
    })
    .on('error', (error) => resolve(failure(error)))
    .connect({
      host: request.body.connection.host,
      port: request.body.connection.port || 22,
      username: request.body.connection.username,
      password: request.body.connection.password || undefined,
      privateKey: request.body.connection.privateKey || undefined,
      passphrase: request.body.connection.passphrase || undefined,
      readyTimeout: 20000,
    });
})));

app.get('/api/sftp/:id/list', route(async (request) => {
  const remotePath = String(request.query.path || '/');
  const sftp = await getSftp(request.params.id);

  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (error, list) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(success({
        files: list.map((item) => ({
          name: item.filename,
          path: posixPath.join(remotePath, item.filename),
          size: item.attrs.size,
          isDirectory: item.attrs.isDirectory(),
          isSymbolicLink: item.attrs.isSymbolicLink(),
          mode: String(item.attrs.mode),
          mtime: item.attrs.mtime * 1000,
          atime: item.attrs.atime * 1000,
          fileType: item.attrs.isDirectory() ? 'directory' : 'file',
        })),
      }));
    });
  });
}));

app.get('/api/sftp/:id/download', async (request, response) => {
  try {
    const remotePath = String(request.query.path || '');
    const filename = posixPath.basename(remotePath);
    const sftp = await getSftp(request.params.id);
    response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    sftp.createReadStream(remotePath).pipe(response);
  } catch (error) {
    response.status(500).json(failure(error));
  }
});

app.post('/api/sftp/:id/upload', upload.single('file'), route(async (request) => {
  if (!request.file) {
    throw new Error('No file uploaded');
  }

  const sftp = await getSftp(request.params.id);
  const filename = request.file.originalname;
  const remotePath = posixPath.join(request.body.remoteDir || '/', filename);
  const taskId = request.body.taskId;

  // ponytail: memory upload is simple for LAN use; stream multipart if large uploads matter.
  await new Promise((resolve, reject) => {
    const writeStream = sftp.createWriteStream(remotePath);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    writeStream.end(request.file.buffer);
  });

  broadcast('sftp-upload-progress', {
    connectionId: request.params.id,
    taskId,
    filename,
    progress: 100,
  });
  broadcast('sftp-transfer-complete', {
    connectionId: request.params.id,
    taskId,
    filename,
    transferType: 'upload',
    success: true,
    remotePath,
  });

  return success({ remotePath });
}));

app.get('/api/ai/providers', route(() => success({ providers: readStore().aiProviders })));
app.post('/api/ai/providers', route((request) => {
  updateStore((store) => {
    const next = request.body.provider;
    store.aiProviders = [
      ...store.aiProviders.map((item) => ({ ...item, isActive: false })).filter((item) => item.id !== next.id),
      next,
    ];
  });
  return success();
}));
app.delete('/api/ai/providers/:id', route((request) => {
  updateStore((store) => {
    store.aiProviders = store.aiProviders.filter((item) => item.id !== request.params.id);
  });
  return success();
}));
app.post('/api/unsupported', route(() => failure('This feature is only available in the desktop app')));

app.use(express.static(STATIC_DIR));
app.use((_request, response) => response.sendFile(path.join(STATIC_DIR, 'index.html')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/api/events' });

wss.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === 'ssh-write') {
        getSession(message.connectionId).stream.write(message.data || '');
      }
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', payload: failure(error) }));
    }
  });
  socket.on('close', () => sockets.delete(socket));
});

server.listen(PORT, '0.0.0.0', () => {
  console.info(`AI SSH Client web server listening on ${PORT}`);
});
