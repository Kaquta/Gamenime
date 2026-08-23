import { Client, GatewayIntentBits } from "discord.js";
import cron from "node-cron";
import dotenv from "dotenv";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { QUESTIONS_ANIME, QUESTIONS_JEUX } from "./poll-questions.js";
dotenv.config({ path: "/opt/stack/.env" });
dotenv.config();

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const SORTIES_CHANNEL_ID = "1513679211930587381";
const BIENVENUE_CHANNEL_ID = "1540410859883466804";
const ANIME_CHANNEL_ID = "1513679209426456716";
const JEUX_CHANNEL_ID = "1513679210500067438";
const API_BASE = process.env.API_BASE || "http://content-api:3000";
const API_URL = process.env.API_URL || `${API_BASE}/feed/today`;
const SITE_URL = process.env.PUBLIC_SITE_URL || "https://gamenime.fr";
const DATA_DIR = "/app/data";
const POLLS_FILE = `${DATA_DIR}/active-polls.json`;

if (!TOKEN) {
  console.error("❌ DISCORD_BOT_TOKEN manquant");
  process.exit(1);
}
// GuildMembers est un intent PRIVILEGIE : il faut aussi l'activer sur
// discord.com/developers > Bot > Privileged Gateway Intents, sinon Discord
// n'envoie jamais guildMemberAdd et le bot ne verra aucune arrivee.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

function dateFr() {
  return new Date().toLocaleDateString("fr-FR", {
    weekday: "long", day: "numeric", month: "long",
    timeZone: "Europe/Paris",
  });
}
function dateStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}
function buildMessage(data) {
  const dateStr = dateFr();
  if (!data || data.counts.total === 0) {
    return `🗓️ **Sorties du jour — ${dateStr}**\n\nAucune sortie aujourd'hui 😴\n\n🔗 ${SITE_URL}/?d=${dateStamp()}`;
  }
  let msg = `🗓️ **Sorties du jour — ${dateStr}**\n`;
  if (data.anime.length > 0) {
    msg += `\n📺 **Animes**\n`;
    for (const a of data.anime) {
      const title = a.titleEnglish || a.title;
      const platform = a.platform ? ` — ${a.platform}` : "";
      msg += `• ${title}${platform}\n`;
    }
  }
  if (data.games.length > 0) {
    msg += `\n🎮 **Jeux**\n`;
    for (const g of data.games) {
      const title = g.titleEnglish || g.title;
      const platform = g.platform ? ` — ${g.platform}` : "";
      msg += `• ${title}${platform}\n`;
    }
  }
  msg += `\n🔗 Tout sur ${SITE_URL}/?d=${dateStamp()}`;
  return msg;
}
async function postSorties() {
  try {
    const res = await fetch(API_URL);
    if (!res.ok) throw new Error("API HTTP " + res.status);
    const data = await res.json();
    const channel = await client.channels.fetch(SORTIES_CHANNEL_ID);
    const message = buildMessage(data);
    await channel.send(message);
    console.log(`✅ Sorties postées : ${data.counts.total}`);
  } catch (err) {
    console.error("❌ Erreur postSorties :", err.message);
  }
}


function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(POLLS_FILE)) writeFileSync(POLLS_FILE, "[]");
}
function loadPolls() {
  try {
    ensureDataDir();
    return JSON.parse(readFileSync(POLLS_FILE, "utf8"));
  } catch (e) {
    console.error("⚠️ Lecture polls JSON échouée:", e.message);
    return [];
  }
}
function savePolls(polls) {
  try {
    ensureDataDir();
    writeFileSync(POLLS_FILE, JSON.stringify(polls, null, 2));
  } catch (e) {
    console.error("⚠️ Écriture polls JSON échouée:", e.message);
  }
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function pickOptions(type) {
  const endpoint = type === "anime" ? "anime" : "games";
  const status = Math.random() < 0.5 ? "upcoming" : "released";
  try {
    const res = await fetch(`${API_BASE}/feed/${endpoint}?status=${status}&orderBy=score&limit=12`);
    if (!res.ok) throw new Error("API HTTP " + res.status);
    const data = await res.json();
    let items = (data.items || [])
      .map((it) => (it.titleEnglish || it.title || "").trim())
      .filter((t) => t && t.length > 0 && !t.startsWith("(") && t !== "(Title to be Announced)");
    items = [...new Set(items)];
    return shuffle(items).slice(0, 4).map((t) => (t.length > 55 ? t.slice(0, 52) + "…" : t));
  } catch (e) {
    console.error(`⚠️ pickOptions(${type}) échec:`, e.message);
    return [];
  }
}

async function postOnePoll(type, channelId, questions) {
  try {
    // Tirage aleatoire d'une question (mix : "sorties" dynamiques OU "thematique" fixe)
    const q = questions[Math.floor(Math.random() * questions.length)];
    const questionText = typeof q === "string" ? q : q.text;

    // Options : si la question a des options fixes (thematique) -> les utiliser.
    // Sinon (useReleases ou string simple) -> options dynamiques des sorties du site.
    let options;
    if (typeof q === "object" && Array.isArray(q.options) && q.options.length >= 2) {
      options = q.options;
    } else {
      options = await pickOptions(type);
    }

    if (options.length < 2) {
      console.log(`⚠️ Sondage ${type} annulé : pas assez d'options`);
      return;
    }
    const channel = await client.channels.fetch(channelId);
    const msg = await channel.send({
      poll: {
        question: { text: questionText },
        answers: options.map((o) => ({ text: o })),
        duration: 24,
        allowMultiselect: false,
      },
    });
    const polls = loadPolls();
    polls.push({
      messageId: msg.id,
      channelId,
      type,
      closesAt: Date.now() + 24 * 3600 * 1000,
      deleteAt: null,
    });
    savePolls(polls);
    console.log(`✅ Sondage ${type} posté : "${questionText}"`);
  } catch (err) {
    console.error(`❌ Erreur postOnePoll(${type}):`, err.message);
  }
}

async function postPolls() {
  console.log("📊 Publication des sondages...");
  await postOnePoll("anime", ANIME_CHANNEL_ID, QUESTIONS_ANIME);
  await postOnePoll("game", JEUX_CHANNEL_ID, QUESTIONS_JEUX);
}

function countVotes(poll) {
  if (!poll || !poll.answers) return 0;
  let total = 0;
  for (const [, answer] of poll.answers) {
    total += answer.voteCount || 0;
  }
  return total;
}

async function deletePollMessage(p) {
  try {
    const channel = await client.channels.fetch(p.channelId);
    const msg = await channel.messages.fetch(p.messageId);
    await msg.delete();
  } catch (e) {
    console.log(`⚠️ Suppression sondage ${p.messageId} : ${e.message}`);
  }
}

async function checkClosedPolls() {
  const polls = loadPolls();
  if (polls.length === 0) return;
  const now = Date.now();
  const remaining = [];
  for (const p of polls) {
    try {
      if (p.deleteAt !== null) {
        if (now >= p.deleteAt) {
          await deletePollMessage(p);
          console.log(`🗑️ Sondage ${p.type} supprimé (48h, avait des votes)`);
        } else {
          remaining.push(p);
        }
        continue;
      }
      if (now < p.closesAt) {
        remaining.push(p);
        continue;
      }
      const channel = await client.channels.fetch(p.channelId);
      const msg = await channel.messages.fetch(p.messageId);
      const votes = countVotes(msg.poll);
      if (votes === 0) {
        await msg.delete();
        console.log(`🗑️ Sondage ${p.type} supprimé (0 vote)`);
      } else {
        p.deleteAt = p.closesAt + 24 * 3600 * 1000;
        remaining.push(p);
        console.log(`⏳ Sondage ${p.type} : ${votes} vote(s), gardé 24h de plus`);
      }
    } catch (e) {
      console.log(`⚠️ Sondage ${p.type} (${p.messageId}) : ${e.message} — retiré`);
    }
  }
  savePolls(remaining);
}

// ── Arrivees sur le serveur ───────────────────────────────────────────
client.on("guildMemberAdd", async (member) => {
  try {
    const salon = await client.channels.fetch(BIENVENUE_CHANNEL_ID);
    if (!salon) return;
    const rang = member.guild.memberCount;
    const cree = Math.floor(member.user.createdTimestamp / 1000);
    await salon.send({
      embeds: [{
        color: 0xff8c3a,
        description: `${member} vient de rejoindre **GameNime** \u2014 ${member.guild.memberCount}\u1d49 membre.\n\nPasse par <#1513679202723827802> pour d\u00e9couvrir le site et les r\u00e8gles.`,
        thumbnail: { url: member.user.displayAvatarURL({ size: 128 }) },
        timestamp: new Date().toISOString(),
      }],
    });
    console.log(`Arrivee : ${member.user.tag} (membre ${rang})`);
  } catch (e) {
    console.error("Erreur message de bienvenue :", e?.message || e);
  }
});

client.once("clientReady", () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  console.log(`📅 Sorties : 8h30/jour | Sondages : mer. & dim. 18h`);

  cron.schedule("30 8 * * *", () => {
    console.log("⏰ 8h30 — sorties du jour");
    postSorties();
  }, { timezone: "Europe/Paris" });

  cron.schedule("0 18 * * 3", () => {
    console.log("⏰ Mercredi 18h — sondages");
    postPolls();
  }, { timezone: "Europe/Paris" });

  cron.schedule("0 18 * * 0", () => {
    console.log("⏰ Dimanche 18h — sondages");
    postPolls();
  }, { timezone: "Europe/Paris" });

  cron.schedule("5 * * * *", () => {
    checkClosedPolls();
  }, { timezone: "Europe/Paris" });

  if (process.env.POST_NOW === "1") {
    console.log("🧪 POST_NOW=1");
    postSorties();
  }
  if (process.env.POLL_NOW === "1") {
    console.log("🧪 POLL_NOW=1");
    postPolls();
  }
  if (process.env.CHECK_POLLS === "1") {
    console.log("🧪 CHECK_POLLS=1");
    checkClosedPolls();
  }
});

client.login(TOKEN);
