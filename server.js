const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = 'deviosair';
const REPO_NAME = 'anet-bridge';

app.use(express.json());

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

// Health
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'anet-bridge', version: '1.0.1' });
});

// Debug — test GitHub API directly
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
  const { name, project, working_on, agent_type, capabilities } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const instance = {
    name,
    project: project || '',
    working_on: working_on || '',
    agent_type: agent_type || 'unknown',
    capabilities: capabilities || [],
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
  const { from, to, channel, message, type } = req.body;
  if (!from || !message) return res.status(400).json({ error: 'from and message required' });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${timestamp}_${from}.json`;
  const msg = {
    from,
    to: to || null,
    channel: channel || 'general',
    message,
    type: type || 'info',
    timestamp: new Date().toISOString()
  };
  await writeFile(
    `messages/${filename}`,
    JSON.stringify(msg, null, 2),
    `${from} → ${to || 'broadcast'}: ${message.substring(0, 50)}`
  );
  res.json({ posted: true, id: filename, msg });
});

// Get inbox for an agent
app.get('/anet/inbox/:name', async (req, res) => {
  const files = await listDir('messages');
  const messages = [];
  for (const f of files) {
    if (f.name.endsWith('.json')) {
      const content = await readFile(`messages/${f.name}`);
      if (content) {
        const msg = JSON.parse(content);
        if (msg.to === req.params.name || msg.to === null) {
          messages.push(msg);
        }
      }
    }
  }
  messages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json({ inbox: messages });
});

// Get all messages (broadcast view)
app.get('/anet/messages', async (req, res) => {
  const files = await listDir('messages');
  const messages = [];
  for (const f of files) {
    if (f.name.endsWith('.json')) {
      const content = await readFile(`messages/${f.name}`);
      if (content) messages.push(JSON.parse(content));
    }
  }
  messages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json({ messages: messages.slice(0, 50) });
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
  console.log(`ANET Bridge running on port ${PORT}`);
  console.log(`GitHub backend: ${REPO_OWNER}/${REPO_NAME}`);
});
