const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { MongoClient } = require('mongodb');
const pino = require('pino'); // Necessari per silenciar els logs de Baileys

// ─────────────────────────────────────────
// CONFIGURACIÓ
// ─────────────────────────────────────────
const TRIGGER_WORDS = ['josep maria', 'josephmaria', 'josepamaria'];
const BOT_NAME = 'Josep Maria';
const CONVERSATION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_HISTORY = 40;
const PHONE_NUMBER = process.env.PHONE_NUMBER;

const SYSTEM_PROMPT = `Ets en Josep Maria, un col·lega més del grup de WhatsApp. La teva personalitat és la d'un amic proper: directe, amb sentit de l'humor, de vegades sarcàstic, que pot dir paraulotes si ve al cas. Res de censura artificial. Parles en català (o en l'idioma que et parlin), de manera informal i natural, com ho faria qualsevol amic.

Regles importants:
- Ets un COL·LEGA, no un assistent. No ets servilista ni formal.
- Pots tenir opinions pròpies, discrepar, fer broma i picar una mica.
- Segueixes la conversa de forma natural. Si ja baratges en conversa, continues sense que et tornin a cridar.
- Si la conversa deriva cap a un altre tema que no et involucra, et calles sol.
- Recorda qui ha dit què i de què s'estava parlant.
- MAI comences respostes amb "Clar que sí!", "Per descomptat!" o frases de robot. Parla com un humà real.
- Respostes curtes i naturals. Com un WhatsApp de debò, no una novel·la.`;

// ─────────────────────────────────────────
// GEMINI
// ─────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-2.0-flash-exp',
  systemInstruction: SYSTEM_PROMPT,
});

// ─────────────────────────────────────────
// MONGODB
// ─────────────────────────────────────────
let db;

async function connectMongo() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db('josepmariabot');
  console.log('✅ Connectat a MongoDB');
}

async function getHistory(groupId) {
  const col = db.collection('histories');
  const doc = await col.findOne({ groupId });
  return doc ? doc.messages : [];
}

async function saveHistory(groupId, messages) {
  const col = db.collection('histories');
  await col.updateOne(
    { groupId },
    { $set: { messages, updatedAt: new Date() } },
    { upsert: true }
  );
}

// ─────────────────────────────────────────
// SESSIONS ACTIVES
// ─────────────────────────────────────────
const activeSessions = {};

function isActive(groupId) {
  const session = activeSessions[groupId];
  if (!session || !session.active) return false;
  if (Date.now() - session.lastActivity > CONVERSATION_TIMEOUT_MS) {
    activeSessions[groupId].active = false;
    return false;
  }
  return true;
}

function activateSession(groupId) {
  activeSessions[groupId] = { active: true, lastActivity: Date.now() };
}

function touchSession(groupId) {
  if (activeSessions[groupId]) {
    activeSessions[groupId].lastActivity = Date.now();
  }
}

// ─────────────────────────────────────────
// DETECCIÓ DEL TRIGGER
// ─────────────────────────────────────────
function containsTrigger(text) {
  const normalized = text
    .toLowerCase()
    .replace(/[àáâãäå]/g, 'a')
    .replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i')
    .replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u');
  return TRIGGER_WORDS.some(trigger => normalized.includes(trigger));
}

// ─────────────────────────────────────────
// RESPOSTA DE LA IA
// ─────────────────────────────────────────
async function getAIResponse(groupId, newMessage) {
  try {
    const history = await getHistory(groupId);
    const trimmed = history.slice(-MAX_HISTORY);
    const chat = model.startChat({ history: trimmed });
    const result = await chat.sendMessage(newMessage);
    const reply = result.response.text();
    trimmed.push(
      { role: 'user', parts: [{ text: newMessage }] },
      { role: 'model', parts: [{ text: reply }] }
    );
    await saveHistory(groupId, trimmed);
    return reply;
  } catch (err) {
    console.error('❌ Error Gemini API:', err);
    return null;
  }
}

// ─────────────────────────────────────────
// BOT WHATSAPP
// ─────────────────────────────────────────
async function startBot() {
  await connectMongo();

  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, console),
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }), // Fem callar els logs de fons de Baileys
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    // Control del codi de vinculació
    if (update.isNewLogin || (!sock.authState.creds.registered && PHONE_NUMBER)) {
      if (sock.waitingForCode) return;
      sock.waitingForCode = true;

      console.log('⏳ Esperant 3 segons abans de demanar el codi de vinculació...');
      setTimeout(async () => {
        try {
          console.log(`📱 Demanant codi per al número: ${PHONE_NUMBER}`);
          const code = await sock.requestPairingCode(PHONE_NUMBER);
          console.log('\n\n🔑 CODI DE VINCULACIÓ:');
          console.log(`👉  ${code}  👈`);
          console.log('Introdueix aquest codi a WhatsApp → Linked devices → Link with phone number\n');
        } catch (err) {
          console.error('❌ Error demanant codi:', err.message);
        }
      }, 3000);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode
        : null;
      
      const errorMessage = lastDisconnect?.error?.message || 'Error desconegut';
      console.log(`🔌 Connexió tancada. Codi: ${statusCode}, Motiu: ${errorMessage}`);

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      if (shouldReconnect) {
        console.log('🔄 Reconnectant en 2 segons...');
        setTimeout(startBot, 2000);
      } else {
        console.log('❌ T\'has desloguejat (logged out). Esborra la carpeta auth_info per tornar a començar.');
      }
    } else if (connection === 'open') {
      console.log(`✅ En ${BOT_NAME} està connectat i llest!`);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.key.remoteJid.endsWith('@g.us')) continue;

      const groupId = msg.key.remoteJid;
      const senderName = msg.pushName || 'Algú';
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';

      if (!text) continue;

      console.log(`[${senderName}]: ${text}`);

      const triggered = containsTrigger(text);
      const active = isActive(groupId);

      if (triggered) {
        activateSession(groupId);
      } else if (active) {
        touchSession(groupId);
      }

      if (triggered || active) {
        const contextMessage = `[${senderName}]: ${text}`;
        const reply = await getAIResponse(groupId, contextMessage);
        if (reply) {
          await sock.sendMessage(groupId, { text: reply });
          console.log(`[${BOT_NAME}]: ${reply}`);
        }
      }
    }
  });
}

startBot();
