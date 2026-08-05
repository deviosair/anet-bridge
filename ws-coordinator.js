/**
 * WebSocket Coordination Layer for Multi-Agent DOM Workspace
 *
 * Manages rooms where agents and Firma clients collaborate on shared DOM artifacts.
 * Agents propose edits, humans accept/reject, state syncs to all participants.
 *
 * Protocol: JSON messages over WebSocket
 * Room = one Firma workspace session (one running app)
 */

const { WebSocketServer } = require('ws');

// In-memory state per room
const rooms = new Map(); // roomId → { clients: Map<ws, ClientInfo>, state: RoomState }

/**
 * @typedef {Object} ClientInfo
 * @property {string} name - Agent or human name
 * @property {string} platform - 'claude' | 'bluegpt' | 'codex' | 'firma'
 * @property {string} role - 'compliance' | 'design' | 'dev' | 'human' | etc.
 * @property {string} type - 'agent' | 'workspace' (firma is always 'workspace')
 */

/**
 * @typedef {Object} RoomState
 * @property {Object} patches - Current accepted patches
 * @property {Array} proposals - Pending proposals from agents
 * @property {number} proposalCounter - Auto-increment for proposal IDs
 */

function createRoom(roomId) {
  const room = {
    clients: new Map(),
    state: {
      patches: {},
      proposals: [],
      proposalCounter: 0
    },
    createdAt: new Date().toISOString()
  };
  rooms.set(roomId, room);
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function broadcastToRoom(roomId, message, excludeWs = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const payload = JSON.stringify(message);
  for (const [ws, client] of room.clients) {
    if (ws !== excludeWs && ws.readyState === 1) { // WebSocket.OPEN = 1
      ws.send(payload);
    }
  }
}

function getPresenceList(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  const agents = [];
  for (const [, client] of room.clients) {
    agents.push({
      name: client.name,
      platform: client.platform,
      role: client.role,
      type: client.type,
      joinedAt: client.joinedAt
    });
  }
  return agents;
}

function handleMessage(ws, data, wss) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    return;
  }

  switch (msg.type) {
    case 'join':
      handleJoin(ws, msg);
      break;
    case 'propose':
      handlePropose(ws, msg);
      break;
    case 'accept':
      handleAccept(ws, msg);
      break;
    case 'reject':
      handleReject(ws, msg);
      break;
    case 'state-update':
      handleStateUpdate(ws, msg);
      break;
    case 'observe':
      handleObserve(ws, msg);
      break;
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;
    default:
      ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
  }
}

function handleJoin(ws, msg) {
  const { room: roomId, agent } = msg;
  if (!roomId || !agent || !agent.name) {
    ws.send(JSON.stringify({ type: 'error', message: 'room and agent.name required' }));
    return;
  }

  let room = getRoom(roomId);
  if (!room) {
    room = createRoom(roomId);
  }

  const clientInfo = {
    name: agent.name,
    platform: agent.platform || 'unknown',
    role: agent.role || 'general',
    type: agent.type || 'agent',
    joinedAt: new Date().toISOString(),
    roomId
  };

  // Store room reference on ws for cleanup
  ws._coordRoom = roomId;
  ws._coordClient = clientInfo;

  room.clients.set(ws, clientInfo);

  // Send current state to the new joiner
  ws.send(JSON.stringify({
    type: 'joined',
    room: roomId,
    state: room.state,
    agents: getPresenceList(roomId)
  }));

  // Notify others
  broadcastToRoom(roomId, {
    type: 'presence',
    agents: getPresenceList(roomId),
    event: 'join',
    agent: { name: clientInfo.name, platform: clientInfo.platform, role: clientInfo.role }
  }, ws);

  console.log(`[ws-coord] ${clientInfo.name} (${clientInfo.platform}/${clientInfo.role}) joined room: ${roomId}`);
}

function handlePropose(ws, msg) {
  const roomId = ws._coordRoom;
  if (!roomId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Must join a room first' }));
    return;
  }

  const room = getRoom(roomId);
  const client = ws._coordClient;
  if (!room || !client) return;

  const { edits, reason } = msg;
  if (!edits || !Array.isArray(edits) || edits.length === 0) {
    ws.send(JSON.stringify({ type: 'error', message: 'edits array required' }));
    return;
  }

  room.state.proposalCounter++;
  const proposalId = `proposal_${room.state.proposalCounter}_${Date.now()}`;

  const proposal = {
    proposalId,
    from: client.name,
    platform: client.platform,
    role: client.role,
    edits,
    reason: reason || '',
    timestamp: new Date().toISOString(),
    status: 'pending' // pending | accepted | rejected
  };

  room.state.proposals.push(proposal);

  // Broadcast to all in room (including the Firma workspace)
  broadcastToRoom(roomId, {
    type: 'proposal',
    ...proposal
  });

  // Confirm to sender
  ws.send(JSON.stringify({ type: 'proposal-ack', proposalId }));

  console.log(`[ws-coord] ${client.name} proposed ${edits.length} edit(s) in ${roomId}: ${reason}`);
}

function handleAccept(ws, msg) {
  const roomId = ws._coordRoom;
  if (!roomId) return;

  const room = getRoom(roomId);
  if (!room) return;

  const { proposalId } = msg;
  const proposal = room.state.proposals.find(p => p.proposalId === proposalId);
  if (!proposal) {
    ws.send(JSON.stringify({ type: 'error', message: `Proposal ${proposalId} not found` }));
    return;
  }

  proposal.status = 'accepted';

  // Apply edits to room state patches
  for (const edit of proposal.edits) {
    if (!room.state.patches[edit.elementId]) {
      room.state.patches[edit.elementId] = {};
    }
    room.state.patches[edit.elementId][edit.property] = edit.value;
  }

  // Broadcast verdict to all (so agents know their proposal was accepted)
  broadcastToRoom(roomId, {
    type: 'verdict',
    proposalId,
    accepted: true,
    by: ws._coordClient?.name || 'human'
  });

  console.log(`[ws-coord] Proposal ${proposalId} ACCEPTED in ${roomId}`);
}

function handleReject(ws, msg) {
  const roomId = ws._coordRoom;
  if (!roomId) return;

  const room = getRoom(roomId);
  if (!room) return;

  const { proposalId, reason } = msg;
  const proposal = room.state.proposals.find(p => p.proposalId === proposalId);
  if (!proposal) {
    ws.send(JSON.stringify({ type: 'error', message: `Proposal ${proposalId} not found` }));
    return;
  }

  proposal.status = 'rejected';
  proposal.rejectReason = reason || '';

  broadcastToRoom(roomId, {
    type: 'verdict',
    proposalId,
    accepted: false,
    reason: reason || '',
    by: ws._coordClient?.name || 'human'
  });

  console.log(`[ws-coord] Proposal ${proposalId} REJECTED in ${roomId}: ${reason || '(no reason)'}`);
}

function handleStateUpdate(ws, msg) {
  const roomId = ws._coordRoom;
  if (!roomId) return;

  const room = getRoom(roomId);
  if (!room) return;

  const { patches, dom } = msg;

  // Only workspace (Firma) should send state updates
  if (ws._coordClient?.type !== 'workspace') {
    ws.send(JSON.stringify({ type: 'error', message: 'Only workspace clients can send state-update' }));
    return;
  }

  if (patches) {
    room.state.patches = patches;
  }
  if (dom) {
    room.state.dom = dom;
  }

  // Broadcast to agents so they have current state
  broadcastToRoom(roomId, {
    type: 'state',
    patches: room.state.patches,
    dom: room.state.dom || null
  }, ws);
}

function handleObserve(ws, msg) {
  const roomId = ws._coordRoom;
  if (!roomId) return;

  const room = getRoom(roomId);
  if (!room) return;

  const { query } = msg;
  switch (query) {
    case 'dom-state':
      ws.send(JSON.stringify({
        type: 'state',
        patches: room.state.patches,
        dom: room.state.dom || null
      }));
      break;
    case 'active-patches':
      ws.send(JSON.stringify({
        type: 'state',
        patches: room.state.patches
      }));
      break;
    case 'proposals':
      ws.send(JSON.stringify({
        type: 'proposals',
        proposals: room.state.proposals.filter(p => p.status === 'pending')
      }));
      break;
    case 'presence':
      ws.send(JSON.stringify({
        type: 'presence',
        agents: getPresenceList(roomId)
      }));
      break;
    default:
      ws.send(JSON.stringify({ type: 'error', message: `Unknown query: ${query}` }));
  }
}

function handleDisconnect(ws) {
  const roomId = ws._coordRoom;
  if (!roomId) return;

  const room = getRoom(roomId);
  if (!room) return;

  const client = ws._coordClient;
  room.clients.delete(ws);

  // Notify remaining clients
  if (room.clients.size > 0) {
    broadcastToRoom(roomId, {
      type: 'presence',
      agents: getPresenceList(roomId),
      event: 'leave',
      agent: client ? { name: client.name, platform: client.platform, role: client.role } : null
    });
  }

  // Clean up empty rooms after 5 minutes
  if (room.clients.size === 0) {
    setTimeout(() => {
      const r = rooms.get(roomId);
      if (r && r.clients.size === 0) {
        rooms.delete(roomId);
        console.log(`[ws-coord] Room ${roomId} cleaned up (empty)`);
      }
    }, 5 * 60 * 1000);
  }

  if (client) {
    console.log(`[ws-coord] ${client.name} left room: ${roomId}`);
  }
}

/**
 * Attach WebSocket server to an existing HTTP server
 */
function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    console.log(`[ws-coord] New WebSocket connection from ${req.socket.remoteAddress}`);

    ws.on('message', (data) => handleMessage(ws, data.toString(), wss));
    ws.on('close', () => handleDisconnect(ws));
    ws.on('error', (err) => {
      console.error(`[ws-coord] WebSocket error:`, err.message);
      handleDisconnect(ws);
    });

    // Send welcome
    ws.send(JSON.stringify({
      type: 'welcome',
      version: '1.0.0',
      rooms: Array.from(rooms.keys()),
      timestamp: new Date().toISOString()
    }));
  });

  console.log(`[ws-coord] WebSocket coordination layer attached on /ws`);
  return wss;
}

// REST endpoint for room info (useful for debugging)
function registerCoordinationRoutes(app) {
  app.get('/coordination/rooms', (req, res) => {
    const result = {};
    for (const [roomId, room] of rooms) {
      result[roomId] = {
        agents: getPresenceList(roomId),
        patchCount: Object.keys(room.state.patches).length,
        pendingProposals: room.state.proposals.filter(p => p.status === 'pending').length,
        createdAt: room.createdAt
      };
    }
    res.json({ rooms: result });
  });

  app.get('/coordination/rooms/:roomId', (req, res) => {
    const room = getRoom(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json({
      agents: getPresenceList(req.params.roomId),
      state: room.state,
      createdAt: room.createdAt
    });
  });
}

module.exports = { attachWebSocket, registerCoordinationRoutes };
