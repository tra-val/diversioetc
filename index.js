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
- Segueixes la conversa de forma natural. Si ja estàs en conversa, continues sense que et tornin a cridar.
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
