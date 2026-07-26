const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = 'deviosair';
const REPO_NAME = 'anet-bridge';
const DEPLOY_TIME = new Date().toISOString();
const VERSION = '1.1.0';

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

// --- Routes ---

// Health (Libro requested)
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'anet-bridge', version: VERSION });
});

app.get('/anet/health', async (req, res) => {
  const instanceFiles = await listDir('instances');
  const agents = instanceFiles
    .filter(f => f.name.endsWith('.json'))
    .map(f => f.name.replace('.json', ''));
  res.json({
    version: VERSION,
    deployed_at: DEPLOY_TIME,
    routes: [
      '/', '/anet/health', '/anet/rules', '/anet/architecture',
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

// --- Start ---

app.listen(PORT, () => {
  console.log(`ANET Bridge v${VERSION} running on port ${PORT}`);
  console.log(`GitHub backend: ${REPO_OWNER}/${REPO_NAME}`);
  console.log(`Deployed: ${DEPLOY_TIME}`);
});
