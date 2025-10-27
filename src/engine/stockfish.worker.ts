/// <reference lib="webworker" />

/**
 * Stockfish Web Worker
 * Creates a nested classic worker to load Stockfish WASM (since module workers can't use importScripts)
 */

let engine: any = null
let isReady = false
const commandQueue: string[] = []

// Debug: Log to main thread
function debug(msg: string) {
  self.postMessage({ type: 'engineLine', data: `[WORKER DEBUG] ${msg}` })
}

function sendCommand(cmd: string) {
  if (!engine) {
    debug('ERROR: Stockfish not initialized when trying to send: ' + cmd)
    return
  }

  if (isReady) {
    debug('Sending command: ' + cmd)
    engine.postMessage(cmd)
  } else {
    debug('Queueing command: ' + cmd)
    commandQueue.push(cmd)
  }
}

function processQueue() {
  debug(`Processing queue with ${commandQueue.length} commands`)
  while (commandQueue.length > 0) {
    const cmd = commandQueue.shift()
    if (cmd && engine) {
      engine.postMessage(cmd)
    }
  }
}

function handleEngineLine(line: string) {
  // Forward all engine output to main thread
  self.postMessage({ type: 'engineLine', data: line })

  // Handle specific responses
  if (line === 'uciok') {
    debug('Received uciok, sending isready')
    engine.postMessage('isready')
  } else if (line === 'readyok') {
    if (!isReady) {
      debug('Engine is ready!')
      isReady = true
      processQueue()
      self.postMessage({ type: 'ready' })
    }
  } else if (line.startsWith('bestmove ')) {
    const parts = line.split(' ')
    const move = parts[1]
    self.postMessage({ type: 'bestmove', data: move })
  }
}

// Initialize Stockfish by creating a nested classic worker
function initStockfish() {
  debug('Starting Stockfish initialization...')

  try {
    // Get absolute URL for Stockfish script
    const stockfishUrl = new URL('/stockfish/stockfish-17.1-lite-single-03e3232.js', self.location.href).href
    debug(`Absolute Stockfish URL: ${stockfishUrl}`)

    // Create a blob with classic worker code that loads Stockfish
    const workerCode = `
      // This is a classic worker that can use importScripts
      console.log('[NESTED WORKER] Loading Stockfish via importScripts...');
      importScripts('${stockfishUrl}');
      console.log('[NESTED WORKER] importScripts completed');

      let stockfishEngine = null;

      // Initialize Stockfish
      if (typeof Stockfish !== 'undefined') {
        console.log('[NESTED WORKER] Found Stockfish function, calling it...');
        const result = Stockfish();

        if (result && typeof result.then === 'function') {
          console.log('[NESTED WORKER] Stockfish() returned a promise, waiting...');
          result.then((sf) => {
            console.log('[NESTED WORKER] Stockfish promise resolved!');
            stockfishEngine = sf;

            // Set up message listener from Stockfish
            sf.addMessageListener((line) => {
              // Forward to parent worker
              self.postMessage({ type: 'engineLine', data: line });
            });

            // Send ready signal
            self.postMessage({ type: 'ready' });

            // Send initial UCI command
            sf.postMessage('uci');
          }).catch((error) => {
            console.error('[NESTED WORKER] Promise rejected:', error);
            self.postMessage({ type: 'error', data: String(error) });
          });
        }
      } else {
        console.error('[NESTED WORKER] Stockfish not found!');
        self.postMessage({ type: 'error', data: 'Stockfish not found' });
      }

      // Handle commands from parent worker
      self.addEventListener('message', (e) => {
        const { type, data } = e.data;
        if (type === 'command' && stockfishEngine) {
          stockfishEngine.postMessage(data);
        }
      });
    `;

    const blob = new Blob([workerCode], { type: 'application/javascript' })
    const workerUrl = URL.createObjectURL(blob)

    debug('Creating nested classic worker...')
    const nestedWorker = new Worker(workerUrl)

    nestedWorker.addEventListener('message', (e: MessageEvent) => {
      const { type, data } = e.data

      if (type === 'ready') {
        debug('Nested worker reports Stockfish is ready')
        engine = nestedWorker
      } else if (type === 'engineLine') {
        handleEngineLine(data)
      } else if (type === 'error') {
        debug(`Nested worker error: ${data}`)
        self.postMessage({ type: 'error', data: `Nested worker failed: ${data}` })
      }
    })

    nestedWorker.addEventListener('error', (e: ErrorEvent) => {
      debug(`Nested worker error event: ${e.message}`)
      self.postMessage({ type: 'error', data: `Nested worker error: ${e.message}` })
    })

    // Override engine.postMessage to send to nested worker
    engine = {
      postMessage: (cmd: string) => {
        nestedWorker.postMessage({ type: 'command', data: cmd })
      }
    }

    debug('Nested worker created successfully')

  } catch (error) {
    debug(`Exception in initStockfish: ${error}`)
    self.postMessage({
      type: 'error',
      data: `Failed to load Stockfish: ${error}`,
    })
  }
}

// Handle messages from main thread
self.addEventListener('message', (e: MessageEvent) => {
  const { type, payload } = e.data

  switch (type) {
    case 'init': {
      debug('Received init message')
      if (!engine) {
        initStockfish()
      }

      // Wait for ready, then set options
      const waitForReady = () => {
        if (isReady) {
          const { multiPv = 3, threads = 1, skill = 20 } = payload || {}
          debug(`Setting options: MultiPV=${multiPv}, Threads=${threads}, Skill=${skill}`)
          sendCommand(`setoption name MultiPV value ${multiPv}`)
          sendCommand(`setoption name Threads value ${threads}`)
          sendCommand(`setoption name Skill Level value ${skill}`)
          sendCommand('isready')
        } else {
          setTimeout(waitForReady, 50)
        }
      }
      waitForReady()
      break
    }

    case 'setPosition': {
      const { fen } = payload
      sendCommand(`position fen ${fen}`)
      break
    }

    case 'setPositionFromMoves': {
      const { moves } = payload
      if (moves && moves.length > 0) {
        sendCommand(`position startpos moves ${moves.join(' ')}`)
      } else {
        sendCommand('position startpos')
      }
      break
    }

    case 'analyze': {
      const { depth, movetimeMs } = payload || {}

      if (movetimeMs) {
        sendCommand(`go movetime ${movetimeMs}`)
      } else if (depth) {
        sendCommand(`go depth ${depth}`)
      } else {
        sendCommand('go depth 20')
      }
      break
    }

    case 'stop':
      sendCommand('stop')
      break

    case 'setOption': {
      const { name, value } = payload
      sendCommand(`setoption name ${name} value ${value}`)
      sendCommand('isready')
      break
    }

    case 'newGame':
      sendCommand('ucinewgame')
      sendCommand('isready')
      break

    default:
      debug(`Unknown message type: ${type}`)
  }
})

debug('Worker script loaded')

export {}
