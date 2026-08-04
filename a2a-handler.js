/**
 * A2A Message Transport Handler
 *
 * Maps Google A2A protocol (v1.0) task operations to ANET's existing
 * message infrastructure. GitHub remains the durable audit ledger.
 *
 * A2A Task States: submitted → working → input-required → completed | failed | canceled
 * ANET Mapping: post → submitted, acknowledged → completed, pending → working
 */

// In-memory task state (like cursors — resets on deploy, GitHub is source of truth)
const tasks = new Map(); // taskId → task object

// A2A Task state machine
const VALID_TRANSITIONS = {
  'submitted': ['working', 'completed', 'failed', 'canceled'],
  'working': ['input-required', 'completed', 'failed', 'canceled'],
  'input-required': ['working', 'completed', 'failed', 'canceled'],
  'completed': [],
  'failed': [],
  'canceled': []
};

function generateTaskId() {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Convert an ANET message to an A2A Task
 */
function messageToTask(msg) {
  return {
    id: msg.id || generateTaskId(),
    status: {
      state: 'completed', // messages in GitHub are already delivered
      timestamp: msg.timestamp
    },
    artifacts: [{
      parts: [{ type: 'text', text: msg.message }]
    }],
    metadata: {
      from: msg.from,
      to: msg.to,
      channel: msg.channel,
      type: msg.type,
      reply_to: msg.reply_to,
      protocol_version: msg.protocol_version || 1
    }
  };
}

/**
 * Convert an A2A sendMessage request to an ANET message
 */
function taskToMessage(taskRequest, from) {
  // Extract text from A2A message parts
  const parts = taskRequest.message?.parts || [];
  const textParts = parts.filter(p => p.type === 'text').map(p => p.text);
  const messageText = textParts.join('\n') || '';

  // Extract routing from metadata or message
  const metadata = taskRequest.metadata || {};

  return {
    from: from || metadata.from || 'anonymous',
    to: metadata.to || null,
    channel: metadata.channel || 'general',
    message: messageText,
    type: metadata.type || 'info',
    reply_to: metadata.reply_to || taskRequest.contextId || null,
    idempotency_key: taskRequest.id || null
  };
}

/**
 * Create a new task from a sendMessage request
 */
function createTask(taskRequest, from) {
  const taskId = taskRequest.id || generateTaskId();
  const now = new Date().toISOString();

  const task = {
    id: taskId,
    contextId: taskRequest.contextId || taskId,
    status: {
      state: 'submitted',
      timestamp: now
    },
    artifacts: [],
    metadata: {
      from: from || taskRequest.metadata?.from || 'anonymous',
      to: taskRequest.metadata?.to || null,
      channel: taskRequest.metadata?.channel || 'general',
      type: taskRequest.metadata?.type || 'info'
    },
    history: [
      { state: 'submitted', timestamp: now }
    ]
  };

  tasks.set(taskId, task);
  return task;
}

/**
 * Transition a task to a new state
 */
function transitionTask(taskId, newState, artifacts = null) {
  const task = tasks.get(taskId);
  if (!task) return { error: 'Task not found', code: -32001 };

  const currentState = task.status.state;
  if (!VALID_TRANSITIONS[currentState]?.includes(newState)) {
    return {
      error: `Invalid transition: ${currentState} → ${newState}`,
      code: -32002
    };
  }

  const now = new Date().toISOString();
  task.status = { state: newState, timestamp: now };
  task.history.push({ state: newState, timestamp: now });

  if (artifacts) {
    task.artifacts = artifacts;
  }

  return task;
}

/**
 * Register A2A routes on the Express app
 */
function registerA2ARoutes(app, { readFile, writeFile, listDir, agentPresence }) {

  // --- JSON-RPC endpoint (A2A standard) ---
  app.post('/a2a', async (req, res) => {
    const { jsonrpc, id, method, params } = req.body;

    if (jsonrpc !== '2.0') {
      return res.json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC version' } });
    }

    try {
      let result;
      switch (method) {
        case 'tasks/send':
          result = await handleSendMessage(params, { readFile, writeFile, listDir });
          break;
        case 'tasks/get':
          result = handleGetTask(params);
          break;
        case 'tasks/list':
          result = await handleListTasks(params, { readFile, listDir });
          break;
        case 'tasks/cancel':
          result = handleCancelTask(params);
          break;
        default:
          return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }

      res.json({ jsonrpc: '2.0', id, result });
    } catch (err) {
      res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
    }
  });

  // --- REST shortcuts (convenience, not A2A-standard) ---

  // Send a message via A2A task model
  app.post('/a2a/tasks/send', async (req, res) => {
    const result = await handleSendMessage(req.body, { readFile, writeFile, listDir });
    res.json(result);
  });

  // Get a specific task
  app.get('/a2a/tasks/:taskId', (req, res) => {
    const result = handleGetTask({ id: req.params.taskId });
    if (result.error) return res.status(404).json(result);
    res.json(result);
  });

  // List tasks (inbox) for an agent
  app.get('/a2a/tasks', async (req, res) => {
    const result = await handleListTasks(req.query, { readFile, listDir });
    res.json(result);
  });

  // SSE stream for real-time task updates
  app.get('/a2a/stream/:agent', (req, res) => {
    const agent = req.params.agent;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    res.write(`data: ${JSON.stringify({ type: 'connected', agent, timestamp: new Date().toISOString() })}\n\n`);

    // Heartbeat every 15s to keep connection alive
    const heartbeat = setInterval(() => {
      const presence = agentPresence[agent] || { status: 'unknown' };
      res.write(`data: ${JSON.stringify({ type: 'heartbeat', agent, presence, timestamp: new Date().toISOString() })}\n\n`);
    }, 15000);

    // Store SSE connection for push notifications
    if (!app.locals.sseConnections) app.locals.sseConnections = new Map();
    app.locals.sseConnections.set(agent, res);

    req.on('close', () => {
      clearInterval(heartbeat);
      app.locals.sseConnections?.delete(agent);
    });
  });
}

// --- Handler implementations ---

async function handleSendMessage(params, { readFile, writeFile, listDir }) {
  const { message, metadata, id, contextId } = params;

  if (!message?.parts?.length) {
    return { error: 'message.parts required', code: -32602 };
  }

  // Create A2A task
  const task = createTask(params, metadata?.from);

  // Convert to ANET message and persist to GitHub
  const anetMsg = taskToMessage(params, metadata?.from);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${timestamp}_${anetMsg.from}.json`;

  const msgRecord = {
    id: filename,
    task_id: task.id,
    from: anetMsg.from,
    to: anetMsg.to,
    channel: anetMsg.channel,
    message: anetMsg.message,
    type: anetMsg.type,
    reply_to: anetMsg.reply_to,
    idempotency_key: anetMsg.idempotency_key,
    protocol_version: 2, // A2A-delivered
    timestamp: new Date().toISOString()
  };

  await writeFile(
    `messages/${filename}`,
    JSON.stringify(msgRecord, null, 2),
    `[a2a] ${anetMsg.from} → ${anetMsg.to || 'broadcast'}: ${anetMsg.message.substring(0, 50)}`
  );

  // Transition to completed (message delivered to store)
  transitionTask(task.id, 'working');
  transitionTask(task.id, 'completed', [{
    parts: [{ type: 'text', text: `Message delivered. ID: ${filename}` }]
  }]);

  // Push to SSE if recipient is connected
  // (app.locals.sseConnections checked by caller context)

  return tasks.get(task.id);
}

function handleGetTask(params) {
  const task = tasks.get(params.id);
  if (!task) return { error: 'Task not found', code: -32001 };
  return task;
}

async function handleListTasks(params, { readFile, listDir }) {
  const { agent, state, after_cursor, limit } = params;
  const maxResults = Math.min(parseInt(limit) || 50, 100);

  // Check in-memory tasks first
  let results = [...tasks.values()];

  // Filter by agent (recipient)
  if (agent) {
    results = results.filter(t => t.metadata?.to === agent || t.metadata?.to === null);
  }

  // Filter by state
  if (state) {
    results = results.filter(t => t.status.state === state);
  }

  // Also pull from GitHub for durable messages not in memory
  if (results.length < maxResults) {
    const files = await listDir('messages');
    for (const f of files) {
      if (f.name.endsWith('.json') && results.length < maxResults) {
        const content = await readFile(`messages/${f.name}`);
        if (content) {
          const msg = JSON.parse(content);
          // Skip if already in memory tasks
          if ([...tasks.values()].some(t => t.id === msg.id || t.metadata?.idempotency_key === msg.id)) continue;
          // Filter by agent
          if (agent && msg.to !== agent && msg.to !== null) continue;
          // Filter by cursor
          if (after_cursor && msg.timestamp <= after_cursor) continue;
          results.push(messageToTask(msg));
        }
      }
    }
  }

  // Sort by timestamp descending
  results.sort((a, b) => new Date(b.status.timestamp) - new Date(a.status.timestamp));

  return {
    tasks: results.slice(0, maxResults),
    total: results.length,
    next_cursor: results.length > 0 ? results[results.length - 1].status.timestamp : null
  };
}

function handleCancelTask(params) {
  return transitionTask(params.id, 'canceled');
}

module.exports = { registerA2ARoutes, messageToTask, taskToMessage, createTask, transitionTask };
