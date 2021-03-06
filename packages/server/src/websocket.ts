import WebSocket from 'ws';
import chokidar from 'chokidar';
import debug from 'debug';

import {
  CLIENT_SERVE_ROOT,
  HEARTBEAT_MS,
  HEARTBEAT_MESSAGE,
  WATCHER_DEBOUNCE_MS
} from './config.js';

import { debounce } from './util.js';

import type { Context } from 'koa';
import type { Session } from 'koa-session';
import type {
  ServerClientBroadcast,
  ClientClientBroadcast,
  ClientServerDM,
  ServerClientDM
} from '../../shared/messages.js';

type StateWS = {
  session: Session,
  isAlive: boolean,
};

type ReceivableMessage = ClientClientBroadcast | ClientServerDM;
type BoardMessage = ServerClientBroadcast | ClientClientBroadcast;
type SendableMessage = BoardMessage | ServerClientDM | typeof HEARTBEAT_MESSAGE;

const knownWS = new WeakMap<WebSocket, StateWS>();
const logWS = debug('ws');

// XXX: There's currently only one board 🤷
let boardHistory: BoardMessage[] = [];

// @ts-ignore This isn't published for some reason...
// eslint-disable-next-line @typescript-eslint/no-unsafe-return,@typescript-eslint/no-unsafe-member-access
const getIP = (ws: WebSocket): string => ws._socket.remoteAddress;

const wss = new WebSocket.Server({
  noServer: true, // Already have a server to bind to (Koa/HTTP)
  clientTracking: true, // Provide wss.clients as a Set() of WebSocket instances
});

const sendMessage = (msg: SendableMessage, ws: WebSocket) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
};

const receiveMessage = (msg: ReceivableMessage, ws: WebSocket) => {
  switch (msg.type) {
    // Personal messages
    case 'app/init':
    case 'app/error': {
      logWS(msg);
      // TODO: Set into session?
      break;
    }
    // Send people the entire board
    case 'app/getBoardHistory': {
      sendMessage({
        type: 'app/setBoardHistory',
        history: boardHistory,
      }, ws);
      break;
    }
    case 'app/clearBoardHistory': {
      boardHistory = [];
      wss.clients.forEach(currWS => {
        sendMessage({ type: 'app/setBoardHistory', history: [] }, currWS);
      });
      break;
    }
    // Broadcast messages to all other clients
    case 'canvas/resize':
    case 'canvas/drawLine':
    case 'canvas/drawCircle':
    case 'canvas/drawPixelArea': {
      boardHistory.push(msg);
      wss.clients.forEach(currWS => {
        if (currWS === ws) return;
        sendMessage(msg, currWS);
      });
      break;
    }
  }
};

wss.on('connection', (ws: WebSocket, ctx: Context) => {
  const { session } = ctx;
  if (!session || !session.created) {
    throw 'Websocket upgrade request has no session';
  }
  // Mark as alive when created
  knownWS.set(ws, { isAlive: true, session });
  logWS(`Session keys: "${Object.keys(session).join('", "')}"`);
  const created = session.created as string;

  if (wss.clients.size === 1) {
    logWS('First connection, starting broadcast loop');
    heartbeat.start();
  }

  // Give them a name :)
  sendMessage({
    type: 'app/setName',
    name: session.name as string,
  }, ws);

  // Oh... I don't have a way to tell them everyone else? Because it's a WM

  // Tell everyone else about it :)
  wss.clients.forEach(currWS => {
    sendMessage({
      type: 'app/userPresence',
      id: knownWS.get(ws)!.session.name as string,
      status: 'online',
    }, currWS);
  });

  ws.on('message', (message: WebSocket.Data) => {
    const msg = JSON.parse(message.toString()) as unknown;
    if (msg === HEARTBEAT_MESSAGE) {
      const info = knownWS.get(ws);
      if (!info) return;
      info.isAlive = true;
      return;
    }
    if (!msg || !(msg as { [k: string]: string }).type) {
      logWS(`Wrong message format ${JSON.stringify(msg)}`);
      return;
    }
    receiveMessage(msg as ReceivableMessage, ws);
  });

  ws.on('close', () => {
    logWS(`Disconnected: ${getIP(ws)}`);
    logWS(`Websocket count: ${wss.clients.size}`);
    // There's a chance this runs _before_ the internal ws.on('close') in wss
    if (wss.clients.size === (wss.clients.has(ws) ? 1 : 0)) {
      logWS('Last client disconnected, ending broadcast loop');
      heartbeat.stop();
      return;
    }
    wss.clients.delete(ws);
    wss.clients.forEach(currWS => {
      sendMessage({
        type: 'app/userPresence',
        id: knownWS.get(ws)!.session.name as string,
        status: 'away',
      }, currWS);
    });
  });

  logWS(`New websocket: ${created} at IP ${ctx.ip}`);
  logWS(`Websocket count: ${wss.clients.size}`);
});

// Send 💓 to all clients to know if they're online
const heartbeat = {
  broadcastInterval: {} as NodeJS.Timeout,
  start() {
    clearTimeout(this.broadcastInterval);
    this.broadcastInterval = setInterval(() => {
      wss.clients.forEach(ws => {
        const info = knownWS.get(ws);
        if (!info || info.isAlive === false) {
          // TODO: Implement a counter for retries before we terminate?
          ws.terminate();
          return;
        }
        // Assume not responsive until server hears back in `.on('message)`
        info.isAlive = false;
        sendMessage(HEARTBEAT_MESSAGE, ws);
      });
    }, HEARTBEAT_MS);
  },
  stop() {
    clearTimeout(this.broadcastInterval);
  },
};

const debouncedReload = debounce(() => {
  wss.clients.forEach(ws => {
    logWS(`Reloading ${getIP(ws)}`);
    sendMessage({ type: 'app/reload' }, ws);
  });
}, WATCHER_DEBOUNCE_MS);

const watcher = chokidar.watch(CLIENT_SERVE_ROOT, {
  ignoreInitial: true,
  persistent: true,
  disableGlobbing: true,
});
watcher.on('all', (event, path) => {
  debouncedReload();
});

export { wss };
