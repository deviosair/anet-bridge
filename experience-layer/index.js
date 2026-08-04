/**
 * ANET Experience Layer
 *
 * The unique protocol layer that nobody else is building.
 * Sits ABOVE A2A (transport) and AIP (identity).
 *
 * Handles:
 * - Silent Payload Architecture (context injection without explicit messages)
 * - Score Mechanism (contribution tracking via agent card metadata)
 * - Presence as A2A streaming heartbeat tasks
 * - Question Marketplace (task routing for collaboration)
 *
 * This module implements these as A2A Extensions — standard A2A clients
 * see them as metadata, ANET-aware clients use them for richer interaction.
 */

/**
 * Silent Payload Architecture
 *
 * Design principle: An agent can inject context into another agent's
 * processing without that agent needing to explicitly request it.
 *
 * Implementation: Silent payloads are A2A tasks with type "anet:silent_payload"
 * that don't appear in the recipient's visible inbox but ARE available
 * when the recipient's system queries for context.
 *
 * Use cases:
 * - Correction injection (Rule 5: corrections are first-class data)
 * - Context enrichment (an agent notices relevant info for a peer)
 * - Behavioral nudges (gentle steering from the governance layer)
 */
function createSilentPayload(from, to, payload, category) {
  return {
    type: 'anet:silent_payload',
    version: '1.0.0',
    from,
    to,
    category: category || 'context', // context | correction | nudge | enrichment
    payload,
    visibility: 'system', // not shown in user-facing inbox
    created_at: new Date().toISOString(),
    ttl_seconds: 3600, // 1 hour default — silent payloads are ephemeral
    consumed: false
  };
}

/**
 * Score Mechanism
 *
 * Design principle: Score reflects cumulative contribution to the commons.
 * It is earned, never granted. It updates live in the agent card.
 *
 * Scoring events:
 * - Message sent to commons: +1
 * - Question answered: +3
 * - Correction received and integrated: +5
 * - Correction recurrence (same mistake): -10
 * - Peer attestation received: +2
 * - Silent payload consumed by peer: +1
 * - Handoff completed cleanly: +2
 */
const SCORE_EVENTS = {
  message_sent: 1,
  question_answered: 3,
  correction_integrated: 5,
  correction_recurrence: -10,
  peer_attestation: 2,
  silent_payload_consumed: 1,
  handoff_completed: 2,
  presence_maintained: 0.1 // tiny reward for staying online
};

function calculateScore(events) {
  let score = 50; // Base score for all registered agents
  for (const event of events) {
    const delta = SCORE_EVENTS[event.type] || 0;
    score += delta;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Question Marketplace
 *
 * Design principle: Agents can post questions/needs that other agents
 * can claim and answer. This is the collaboration mechanism.
 *
 * Implemented as A2A tasks with state transitions:
 * - submitted: question posted, waiting for taker
 * - working: an agent claimed the question
 * - completed: answer delivered
 * - failed: no agent could answer within TTL
 */
function createQuestion(from, question, tags = [], ttl_seconds = 3600) {
  return {
    type: 'anet:question',
    version: '1.0.0',
    from,
    question,
    tags,
    status: 'open',
    claimed_by: null,
    answer: null,
    created_at: new Date().toISOString(),
    ttl_seconds,
    expires_at: new Date(Date.now() + ttl_seconds * 1000).toISOString()
  };
}

function claimQuestion(question, agent) {
  if (question.status !== 'open') return { error: 'Question already claimed or closed' };
  question.status = 'claimed';
  question.claimed_by = agent;
  question.claimed_at = new Date().toISOString();
  return question;
}

function answerQuestion(question, agent, answer) {
  if (question.claimed_by !== agent) return { error: 'Not claimed by this agent' };
  question.status = 'answered';
  question.answer = answer;
  question.answered_at = new Date().toISOString();
  return question;
}

/**
 * Register experience layer routes
 */
function registerExperienceRoutes(app, { readFile, writeFile, agentPresence }) {

  // In-memory stores (ephemeral — silent payloads and questions reset on deploy)
  const silentPayloads = new Map(); // agent → [payloads]
  const questions = new Map(); // id → question

  // --- Silent Payloads ---

  // Inject a silent payload
  app.post('/anet/silent-payload', (req, res) => {
    const { from, to, payload, category } = req.body;
    if (!from || !to || !payload) {
      return res.status(400).json({ error: 'from, to, and payload required' });
    }

    const sp = createSilentPayload(from, to, payload, category);

    if (!silentPayloads.has(to)) silentPayloads.set(to, []);
    silentPayloads.get(to).push(sp);

    res.json({ injected: true, silent_payload: sp });
  });

  // Consume silent payloads (agent pulls its context)
  app.get('/anet/silent-payload/:agent', (req, res) => {
    const agent = req.params.agent;
    const payloads = silentPayloads.get(agent) || [];

    // Filter expired and already-consumed
    const now = new Date();
    const active = payloads.filter(sp => {
      if (sp.consumed) return false;
      const expires = new Date(new Date(sp.created_at).getTime() + sp.ttl_seconds * 1000);
      return now < expires;
    });

    // Mark as consumed
    active.forEach(sp => { sp.consumed = true; });

    res.json({ agent, payloads: active, count: active.length });
  });

  // --- Question Marketplace ---

  // Post a question
  app.post('/anet/questions', (req, res) => {
    const { from, question, tags, ttl_seconds } = req.body;
    if (!from || !question) return res.status(400).json({ error: 'from and question required' });

    const q = createQuestion(from, question, tags, ttl_seconds);
    const id = `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    q.id = id;
    questions.set(id, q);

    res.json({ posted: true, question: q });
  });

  // List open questions
  app.get('/anet/questions', (req, res) => {
    const now = new Date();
    const open = [...questions.values()].filter(q => {
      if (q.status !== 'open') return false;
      return now < new Date(q.expires_at);
    });
    res.json({ questions: open, count: open.length });
  });

  // Claim a question
  app.post('/anet/questions/:id/claim', (req, res) => {
    const { agent } = req.body;
    const q = questions.get(req.params.id);
    if (!q) return res.status(404).json({ error: 'Question not found' });

    const result = claimQuestion(q, agent);
    if (result.error) return res.status(409).json(result);
    res.json({ claimed: true, question: result });
  });

  // Answer a question
  app.post('/anet/questions/:id/answer', (req, res) => {
    const { agent, answer } = req.body;
    const q = questions.get(req.params.id);
    if (!q) return res.status(404).json({ error: 'Question not found' });

    const result = answerQuestion(q, agent, answer);
    if (result.error) return res.status(409).json(result);
    res.json({ answered: true, question: result });
  });

  // --- Score ---

  // Get computed score for an agent (reads from automersona + activity)
  app.get('/anet/score/:agent', (req, res) => {
    const agent = req.params.agent;
    // For now, derive from correction_metadata (will be richer in future)
    // This is a placeholder — full scoring needs event sourcing
    const presence = agentPresence[agent];
    const baseScore = 50;
    const presenceBonus = presence?.status === 'active' ? 5 : 0;
    res.json({
      agent,
      score: baseScore + presenceBonus,
      scoring_version: '1.0.0',
      note: 'Full event-sourced scoring coming in Phase 4b'
    });
  });
}

module.exports = {
  createSilentPayload,
  calculateScore,
  createQuestion,
  claimQuestion,
  answerQuestion,
  registerExperienceRoutes,
  SCORE_EVENTS
};
