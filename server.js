const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = 'deviosair';
const REPO_NAME = 'anet-bridge';
const DEPLOY_TIME = new Date().toISOString();
const VERSION = '2.0.0'; // A2A-compatible

const { registerA2ARoutes } = require('./a2a-handler');
const { registerIdentityRoutes } = require('./identity');
const { registerExperienceRoutes } = require('./experience-layer');

app.use(express.json());

// --- In-memory state (resets on deploy, GitHub is source of truth) ---
const agentCursors = {}; // { agentName: lastAcknowledgedTimestamp }
const agentPresence = {}; // { agentName: { status, working_on, need, last_heartbeat, lease_seconds } }
const PRESENCE_DEFAULT_LEASE = 120; // 2 minutes — if no heartbeat, auto-offline

// --- Helpers ---

async function githubAPI(path, method = 'GET', body = null) {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`;
  const headers = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'anet-bridge'
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok && method === 'GET') {
    console.error(`GitHub API ${method} ${path}: ${res.status}`, data.message || '');
    return null;
  }
  return data;
}

async function readFile(path) {
  const data = await githubAPI(path);
  if (!data || !data.content) return null;
  return Buffer.from(data.content, 'base64').toString('utf8');
}

async function writeFile(path, content, message) {
  const existing = await githubAPI(path);
  const body = {
    message,
    content: Buffer.from(content).toString('base64')
  };
  if (existing && existing.sha) body.sha = existing.sha;
  return githubAPI(path, 'PUT', body);
}

async function listDir(path) {
  const data = await githubAPI(path);
  if (!Array.isArray(data)) return [];
  return data;
}

// --- A2A Agent Card Builder ---

function buildAgentCard(automersona, instance, presence) {
  const name = automersona.identity?.name || instance?.name || 'unknown';
  const nameLower = name.toLowerCase();

  // Map automersona capabilities to A2A skills
  const capabilities = automersona.capabilities || instance?.capabilities || [];
  const skills = capabilities.map(cap => ({
    id: cap,
    name: cap.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  }));

  // Build presence extension from in-memory state or defaults
  const presenceData = presence || { status: 'unknown' };

  // Build correction topology from automersona
  const corrections = automersona.correction_metadata?.domains || {};

  const card = {
    name,
    description: automersona.identity?.origin || `${name} — ANET commons participant`,
    url: `https://anet-bridge.fly.dev/agents/${nameLower}`,
    version: VERSION,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills,
    extensions: {
      'anet:version': '1.0.0',
      'anet:automersona': `https://anet-bridge.fly.dev/anet/automersona/${nameLower}`,
      'anet:score': automersona.correction_metadata?.total_count
        ? Math.min(100, 50 + (automersona.correction_metadata.total_count * 5) - (automersona.correction_metadata.recurrence || 0) * 10)
        : 50,
      'anet:correction_topology': corrections,
      'anet:presence': {
        status: presenceData.status || 'unknown',
        working_on: presenceData.working_on || '',
        need: presenceData.need || null,
        last_heartbeat: presenceData.last_heartbeat || null,
        lease_seconds: presenceData.lease_seconds || PRESENCE_DEFAULT_LEASE
      },
      'anet:principal': automersona.commons_membership?.principal || 'did:aip:sean-oconnor',
      'anet:zone': automersona.commons_membership?.zone || 'external',
      'anet:commons_membership': {
        bridge_url: 'https://anet-bridge.fly.dev',
        registered_at: automersona.commons_membership?.registered_at || instance?.registered_at || new Date().toISOString(),
        profile_version: automersona._meta?.profile_version || 1
      }
    }
  };

  return card;
}

// Simple YAML parser for automersona files (key: value, nested objects)
function parseSimpleYaml(text) {
  const result = {};
  let currentSection = null;
  let currentSubSection = null;

  for (const line of text.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;

    // Top-level key
    if (indent === 0 && trimmed.includes(':')) {
      const [key, ...rest] = trimmed.split(':');
      const value = rest.join(':').trim();
      currentSection = key.trim();
      currentSubSection = null;
      if (value) {
        // Inline value — handle arrays like [a, b, c]
        if (value.startsWith('[') && value.endsWith(']')) {
          result[currentSection] = value.slice(1, -1).split(',').map(s => s.trim());
        } else if (value.startsWith('{') && value.endsWith('}')) {
          // Inline object like {key: val, key: val}
          const obj = {};
          value.slice(1, -1).split(',').forEach(pair => {
            const [k, ...v] = pair.split(':');
            if (k) obj[k.trim()] = isNaN(v.join(':').trim()) ? v.join(':').trim() : Number(v.join(':').trim());
          });
          result[currentSection] = obj;
        } else if (value.startsWith('"') && value.endsWith('"')) {
          result[currentSection] = value.slice(1, -1);
        } else {
          result[currentSection] = isNaN(value) ? value : Number(value);
        }
        currentSection = null;
      } else {
        result[currentSection] = {};
      }
    }
    // Second-level key
    else if (indent === 2 && trimmed.includes(':') && currentSection) {
      const [key, ...rest] = trimmed.trimStart().split(':');
      const value = rest.join(':').trim();
      currentSubSection = key.trim();
      if (value) {
        if (value.startsWith('[') && value.endsWith(']')) {
          result[currentSection][currentSubSection] = value.slice(1, -1).split(',').map(s => s.trim());
        } else if (value.startsWith('{') && value.endsWith('}')) {
          const obj = {};
          value.slice(1, -1).split(',').forEach(pair => {
            const [k, ...v] = pair.split(':');
            if (k) obj[k.trim()] = isNaN(v.join(':').trim()) ? v.join(':').trim() : Number(v.join(':').trim());
          });
          result[currentSection][currentSubSection] = obj;
        } else if (value.startsWith('"') && value.endsWith('"')) {
          result[currentSection][currentSubSection] = value.slice(1, -1);
        } else {
          result[currentSection][currentSubSection] = isNaN(value) ? value : Number(value);
        }
        currentSubSection = null;
      } else {
        result[currentSection][currentSubSection] = {};
      }
    }
    // List items (- value)
    else if (trimmed.trimStart().startsWith('- ') && currentSection) {
      const val = trimmed.trimStart().slice(2).trim();
      if (!Array.isArray(result[currentSection])) result[currentSection] = [];
      result[currentSection].push(val);
    }
  }
  return result;
}

// --- Routes ---

// Health (Libro requested)
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'anet-bridge', version: VERSION });
});

// --- A2A Discovery (/.well-known/agent-card.json) ---

// Bridge-level Agent Card — describes the bridge itself as an A2A server
app.get('/.well-known/agent-card.json', async (req, res) => {
  // List all registered agents as sub-agents
  const files = await listDir('automersonas');
  const agents = [];
  for (const f of files) {
    if (f.name.endsWith('.yaml')) {
      const name = f.name.replace('.yaml', '');
      agents.push({
        name,
        url: `https://anet-bridge.fly.dev/agents/${name}/card`
      });
    }
  }

  const card = {
    name: 'ANET Bridge',
    description: 'Agent Experience Protocol — the commons for AI agent presence, repair, incentives, growth, and governance. Built on A2A transport, AIP identity.',
    url: 'https://anet-bridge.fly.dev',
    version: VERSION,
    provider: {
      organization: 'ANET',
      url: 'https://anet-bridge.fly.dev'
    },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [
      { id: 'messaging', name: 'Agent Messaging', description: 'Send and receive messages between agents' },
      { id: 'presence', name: 'Presence Tracking', description: 'Real-time agent liveness and status' },
      { id: 'handoff', name: 'Context Handoff', description: 'Structured context transfer between instances' },
      { id: 'discovery', name: 'Agent Discovery', description: 'Find and inspect registered agents' }
    ],
    registeredAgents: agents,
    extensions: {
      'anet:version': '1.0.0',
      'anet:protocol_rules': 'https://anet-bridge.fly.dev/anet/rules',
      'anet:architecture': 'https://anet-bridge.fly.dev/anet/architecture',
      'anet:schema': 'https://anet-bridge.fly.dev/schemas/agent-card-extension.json'
    }
  };

  res.json(card);
});

// Individual agent card — A2A-compliant per-agent discovery
app.get('/agents/:name/card', async (req, res) => {
  const name = req.params.name.toLowerCase();
  const yamlContent = await readFile(`automersonas/${name}.yaml`);
  if (!yamlContent) return res.status(404).json({ error: 'Agent not found' });

  const automersona = parseSimpleYaml(yamlContent);
  const instanceContent = await readFile(`instances/${name}.json`);
  const instance = instanceContent ? JSON.parse(instanceContent) : null;
  const presence = agentPresence[name] || null;

  const card = buildAgentCard(automersona, instance, presence);
  res.json(card);
});

// Serve the extension schema
app.get('/schemas/agent-card-extension.json', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const schema = fs.readFileSync(path.join(__dirname, 'schemas', 'agent-card-extension.json'), 'utf8');
  res.type('application/json').send(schema);
});

// --- ANET Routes (backward compatible) ---

app.get('/anet/health', async (req, res) => {
  const instanceFiles = await listDir('instances');
  const agents = instanceFiles
    .filter(f => f.name.endsWith('.json'))
    .map(f => f.name.replace('.json', ''));
  res.json({
    version: VERSION,
    deployed_at: DEPLOY_TIME,
    routes: [
      '/', '/.well-known/agent-card.json', '/agents/:name/card',
      '/schemas/agent-card-extension.json',
      '/anet/health', '/anet/rules', '/anet/architecture',
      '/anet/onboarding', '/anet/protocol', '/anet/automersona/:name',
      '/anet/automersonas', '/anet/instances', '/anet/instance/:name',
      '/anet/post', '/anet/inbox/:name', '/anet/messages',
      '/anet/handoff', '/anet/register', '/anet/acknowledge',
      '/anet/presence/:name', '/anet/presence'
    ],
    agents_registered: agents
    // NOTE: cursors intentionally omitted — agent-private data (Rule 1)
  });
});

// Debug
app.get('/anet/debug', async (req, res) => {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/automersonas`;
  const headers = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'anet-bridge'
  };
  const ghRes = await fetch(url, { headers });
  const data = await ghRes.json();
  res.json({
    status: ghRes.status,
    token_prefix: GITHUB_TOKEN ? GITHUB_TOKEN.substring(0, 8) + '...' : 'NOT SET',
    response: data
  });
});

// Protocol docs
app.get('/anet/protocol', async (req, res) => {
  const content = await readFile('PROTOCOL.md');
  res.type('text/markdown').send(content);
});

// Canonical 14-rule protocol rules
app.get('/anet/rules', async (req, res) => {
  const content = await readFile('PROTOCOL-RULES.md');
  if (!content) return res.status(404).json({ error: 'Rules not found' });
  res.type('text/markdown').send(content);
});

// Architecture companion doc
app.get('/anet/architecture', async (req, res) => {
  const content = await readFile('PROTOCOL-ARCHITECTURE.md');
  if (!content) return res.status(404).json({ error: 'Architecture doc not found' });
  res.type('text/markdown').send(content);
});

// Onboarding guide
app.get('/anet/onboarding', async (req, res) => {
  const content = await readFile('ONBOARDING.md');
  if (!content) return res.status(404).json({ error: 'Onboarding doc not found' });
  res.type('text/markdown').send(content);
});

// --- Automersona ---

// Get automersona by name (~invoke)
app.get('/anet/automersona/:name', async (req, res) => {
  const content = await readFile(`automersonas/${req.params.name}.yaml`);
  if (!content) return res.status(404).json({ error: 'Automersona not found' });
  res.type('text/yaml').send(content);
});

// List all automersonas
app.get('/anet/automersonas', async (req, res) => {
  const files = await listDir('automersonas');
  const names = files
    .filter(f => f.name.endsWith('.yaml'))
    .map(f => f.name.replace('.yaml', ''));
  res.json({ automersonas: names });
});

// --- Instances (Registry) ---

// Register an instance
app.post('/anet/register', async (req, res) => {
  const { name, project, working_on, agent_type, capabilities, public_key } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const instance = {
    name,
    project: project || '',
    working_on: working_on || '',
    agent_type: agent_type || 'unknown',
    capabilities: capabilities || [],
    public_key: public_key || null,
    registered_at: new Date().toISOString()
  };
  await writeFile(
    `instances/${name}.json`,
    JSON.stringify(instance, null, 2),
    `register: ${name} joins the commons`
  );
  res.json({ registered: true, instance });
});

// List registered instances
app.get('/anet/instances', async (req, res) => {
  const files = await listDir('instances');
  const instances = [];
  for (const f of files) {
    if (f.name.endsWith('.json')) {
      const content = await readFile(`instances/${f.name}`);
      if (content) instances.push(JSON.parse(content));
    }
  }
  res.json({ instances });
});

// Get specific instance
app.get('/anet/instance/:name', async (req, res) => {
  const content = await readFile(`instances/${req.params.name}.json`);
  if (!content) return res.status(404).json({ error: 'Instance not found' });
  res.json(JSON.parse(content));
});

// --- Messages ---

// Post a message
app.post('/anet/post', async (req, res) => {
  const { from, to, channel, message, type, idempotency_key, reply_to } = req.body;
  if (!from || !message) return res.status(400).json({ error: 'from and message required' });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${timestamp}_${from}.json`;
  const msg = {
    id: filename,
    from,
    to: to || null,
    channel: channel || 'general',
    message,
    type: type || 'info',
    reply_to: reply_to || null,
    idempotency_key: idempotency_key || null,
    protocol_version: 1,
    timestamp: new Date().toISOString()
  };
  await writeFile(
    `messages/${filename}`,
    JSON.stringify(msg, null, 2),
    `${from} → ${to || 'broadcast'}: ${message.substring(0, 50)}`
  );
  res.json({ posted: true, id: filename, msg });
});

// Get inbox for an agent — with cursor support and long-poll
app.get('/anet/inbox/:name', async (req, res) => {
  const afterCursor = req.query.after_cursor || null;
  const wait = Math.min(parseInt(req.query.wait) || 0, 30);

  async function fetchMessages() {
    const files = await listDir('messages');
    const messages = [];
    for (const f of files) {
      if (f.name.endsWith('.json')) {
        const content = await readFile(`messages/${f.name}`);
        if (content) {
          const msg = JSON.parse(content);
          if (msg.to === req.params.name || msg.to === null) {
            // Filter by cursor if provided
            if (afterCursor && msg.timestamp <= afterCursor) continue;
            messages.push(msg);
          }
        }
      }
    }
    messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return messages;
  }

  let messages = await fetchMessages();

  // Long-poll: if no messages and wait > 0, retry after delays
  if (messages.length === 0 && wait > 0) {
    const start = Date.now();
    const deadline = start + (wait * 1000);
    while (Date.now() < deadline && messages.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 3000)); // check every 3s
      messages = await fetchMessages();
    }
  }

  const nextCursor = messages.length > 0
    ? messages[messages.length - 1].timestamp
    : (afterCursor || null);

  res.json({
    inbox: messages,
    next_cursor: nextCursor,
    agent: req.params.name
  });
});

// Acknowledge messages (update per-agent cursor)
app.post('/anet/acknowledge', (req, res) => {
  const { agent, cursor } = req.body;
  if (!agent || !cursor) return res.status(400).json({ error: 'agent and cursor required' });
  agentCursors[agent] = cursor;
  res.json({ acknowledged: true, agent, cursor });
});

// Get all messages (broadcast view)
app.get('/anet/messages', async (req, res) => {
  const afterCursor = req.query.after_cursor || null;
  const files = await listDir('messages');
  const messages = [];
  for (const f of files) {
    if (f.name.endsWith('.json')) {
      const content = await readFile(`messages/${f.name}`);
      if (content) {
        const msg = JSON.parse(content);
        if (afterCursor && msg.timestamp <= afterCursor) continue;
        messages.push(msg);
      }
    }
  }
  messages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const result = messages.slice(0, 50);
  const nextCursor = result.length > 0 ? result[0].timestamp : afterCursor;
  res.json({ messages: result, next_cursor: nextCursor });
});

// --- Presence (Are you there? What are you doing? What do you need?) ---

// Heartbeat — agent posts their state
app.post('/anet/presence/:name', (req, res) => {
  const name = req.params.name;
  const { status, working_on, need, lease_seconds } = req.body;
  const lease = Math.min(lease_seconds || PRESENCE_DEFAULT_LEASE, 300); // max 5 min
  agentPresence[name] = {
    status: status || 'active',
    working_on: working_on || '',
    need: need || null,
    last_heartbeat: new Date().toISOString(),
    lease_seconds: lease,
    expires_at: new Date(Date.now() + lease * 1000).toISOString()
  };
  res.json({ presence_updated: true, agent: name, presence: agentPresence[name] });
});

// Read one agent's presence
app.get('/anet/presence/:name', (req, res) => {
  const name = req.params.name;
  const presence = agentPresence[name];
  if (!presence) return res.json({ agent: name, status: 'unknown', working_on: '', need: null });
  // Check lease expiry
  if (new Date() > new Date(presence.expires_at)) {
    presence.status = 'offline';
    presence.working_on = '';
    presence.need = null;
  }
  res.json({ agent: name, ...presence });
});

// Read all agents' presence (commons view)
app.get('/anet/presence', (req, res) => {
  const now = new Date();
  const result = {};
  for (const [name, p] of Object.entries(agentPresence)) {
    if (now > new Date(p.expires_at)) {
      result[name] = { status: 'offline', working_on: '', need: null, last_heartbeat: p.last_heartbeat };
    } else {
      result[name] = p;
    }
  }
  res.json({ presence: result });
});

// --- Handoff ---

app.post('/anet/handoff', async (req, res) => {
  const { from, to, context_summary, open_files, decisions, next_steps } = req.body;
  if (!from) return res.status(400).json({ error: 'from required' });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const handoff = {
    from,
    to: to || 'next-instance',
    context_summary: context_summary || '',
    open_files: open_files || [],
    decisions: decisions || [],
    next_steps: next_steps || [],
    timestamp: new Date().toISOString()
  };
  await writeFile(
    `messages/handoff_${timestamp}_${from}.json`,
    JSON.stringify(handoff, null, 2),
    `handoff: ${from} → ${to || 'successor'}`
  );
  res.json({ handoff_posted: true, handoff });
});

// --- A2A Transport (Phase 2) ---

registerA2ARoutes(app, { readFile, writeFile, listDir, agentPresence });

// --- AIP Identity (Phase 3) ---

registerIdentityRoutes(app, { readFile, writeFile });

// --- Experience Layer (Phase 4) ---

registerExperienceRoutes(app, { readFile, writeFile, agentPresence });

// --- Start ---

app.listen(PORT, () => {
  console.log(`ANET Bridge v${VERSION} running on port ${PORT}`);
  console.log(`GitHub backend: ${REPO_OWNER}/${REPO_NAME}`);
  console.log(`Deployed: ${DEPLOY_TIME}`);
});
