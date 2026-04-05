// ============================================================
//  AI Stream Moderator Bot
//  Connects to your Twitch chat and moderates with Claude AI
// ============================================================

const tmi = require("tmi.js");
const Anthropic = require("@anthropic-ai/sdk");

// ============================================================
//  STEP 1 — Paste your keys here
// ============================================================
const CONFIG = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  TWITCH_BOT_USERNAME: process.env.TWITCH_BOT_USERNAME,
  TWITCH_OAUTH_TOKEN: process.env.TWITCH_OAUTH_TOKEN,
  TWITCH_CHANNEL: process.env.TWITCH_CHANNEL,
};

// ============================================================
//  STEP 2 — Customize your moderation rules
// ============================================================
const RULES = {
  hate_speech:    true,   // slurs, racism, bigotry
  harassment:     true,   // personal attacks, threats
  spam:           true,   // flooding, repeated characters
  nsfw:           true,   // sexual or explicit content
  self_promotion: true,   // unsolicited links, ads
  spoilers:       false,  // game/story spoilers

  // Add any words you always want blocked
  custom_blocked_words: [],

  // "lenient" | "balanced" | "strict"
  sensitivity: "balanced",
};

// ============================================================
//  STEP 3 — Customize bot responses (what it says in chat)
// ============================================================
const MESSAGES = {
  timeout: (user) => `/timeout ${user} 600`,             // 10 minute timeout command
  ban:     (user) => `/ban ${user}`,                     // permanent ban command
  warning: (user, reason) =>
    `@${user} ⚠️ Warning: ${reason}. Further violations may result in a timeout.`,
};

// ============================================================
//  Bot logic — no need to edit below this line
// ============================================================

const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

// Track recent messages per user to detect spam
const userMessageHistory = {};
const SPAM_WINDOW_MS = 5000;    // 5 seconds
const SPAM_MSG_LIMIT  = 5;      // max messages in that window

function buildSystemPrompt() {
  const activeRules = [];
  if (RULES.hate_speech)    activeRules.push("hate speech, slurs, racism, bigotry");
  if (RULES.harassment)     activeRules.push("personal harassment, threats, telling someone to harm themselves");
  if (RULES.spam)           activeRules.push("chat spam, excessive repetition, flooding");
  if (RULES.nsfw)           activeRules.push("sexual or explicit content");
  if (RULES.self_promotion) activeRules.push("self-promotion, unsolicited links or ads");
  if (RULES.spoilers)       activeRules.push("game or story spoilers");

  const wordNote = RULES.custom_blocked_words.length
    ? `Also always flag messages containing any of these words: ${RULES.custom_blocked_words.join(", ")}.`
    : "";

  return `You are an AI chat moderator for a live Twitch stream.

Rules to enforce: ${activeRules.join("; ")}.
${wordNote}
Sensitivity: ${RULES.sensitivity} (lenient = obvious violations only; balanced = standard; strict = flag borderline content).

Respond ONLY with valid JSON, no markdown, no extra text:
{"safe": true/false, "reason": "brief reason if unsafe, else empty", "action": "ban/timeout/warn/none"}

Action guide:
- "ban" — hate speech, severe threats, repeated extreme violations
- "timeout" — spam, flooding, promotional links, moderate harassment  
- "warn" — borderline content, first mild offense
- "none" — message is fine`;
}

function isSpam(username) {
  const now = Date.now();
  if (!userMessageHistory[username]) userMessageHistory[username] = [];

  // Clear old entries outside the window
  userMessageHistory[username] = userMessageHistory[username].filter(
    (t) => now - t < SPAM_WINDOW_MS
  );

  userMessageHistory[username].push(now);
  return userMessageHistory[username].length > SPAM_MSG_LIMIT;
}

async function moderateMessage(username, message) {
  // Fast local spam check before hitting the API
  if (RULES.spam && isSpam(username)) {
    return { safe: false, reason: "chat flooding / spam", action: "timeout" };
  }

  // Fast local custom word check
  if (RULES.custom_blocked_words.length) {
    const lower = message.toLowerCase();
    const hit = RULES.custom_blocked_words.find((w) => lower.includes(w));
    if (hit) {
      return { safe: false, reason: `blocked word: ${hit}`, action: "timeout" };
    }
  }

  // Ask Claude for everything else
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001", // Haiku is fast and cheap for this task
      max_tokens: 100,
      system: buildSystemPrompt(),
      messages: [
        {
          role: "user",
          content: `Username: ${username}\nMessage: ${message}`,
        },
      ],
    });

    const raw = response.content.map((b) => b.text || "").join("");
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error("[Claude error]", err.message);
    return { safe: true, reason: "", action: "none" }; // fail open — don't punish on API error
  }
}

// Set up Twitch client
const client = new tmi.Client({
  options: { debug: false },
  identity: {
    username: CONFIG.TWITCH_BOT_USERNAME,
    password: CONFIG.TWITCH_OAUTH_TOKEN,
  },
  channels: [CONFIG.TWITCH_CHANNEL],
});

client.on("message", async (channel, tags, message, self) => {
  if (self) return; // ignore the bot's own messages

  const username = tags["display-name"] || tags.username;

  // Skip moderation for the broadcaster and existing mods
  if (tags.badges?.broadcaster || tags.mod) return;

  console.log(`[chat] ${username}: ${message}`);

  const result = await moderateMessage(username, message);

  if (!result.safe) {
    console.log(`[action] ${result.action.toUpperCase()} ${username} — ${result.reason}`);

    if (result.action === "ban") {
      await client.say(channel, MESSAGES.ban(username));
    } else if (result.action === "timeout") {
      await client.say(channel, MESSAGES.timeout(username));
    } else if (result.action === "warn") {
      await client.say(channel, MESSAGES.warning(username, result.reason));
    }
  }
});

client.on("connected", (addr, port) => {
  console.log(`✅ Bot connected to #${CONFIG.TWITCH_CHANNEL} at ${addr}:${port}`);
  console.log(`🤖 AI moderation is active. Sensitivity: ${RULES.sensitivity}`);
});

client.on("disconnected", (reason) => {
  console.log(`❌ Disconnected: ${reason}`);
});

client.connect().catch(console.error);
