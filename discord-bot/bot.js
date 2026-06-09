import { Client, GatewayIntentBits } from "discord.js";
import cron from "node-cron";
import dotenv from "dotenv";

// En local : charge /opt/stack/.env. En container : les env viennent de Docker (dotenv ne trouve rien, c'est OK).
dotenv.config({ path: "/opt/stack/.env" });
dotenv.config(); // fallback .env local au dossier si présent

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const SORTIES_CHANNEL_ID = "1513679211930587381";
const API_URL = process.env.API_URL || "http://content-api:3000/feed/today";
const SITE_URL = process.env.PUBLIC_SITE_URL || "https://gamenime.fr";

if (!TOKEN) {
  console.error("❌ DISCORD_BOT_TOKEN manquant");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Formate la date en français : "lundi 9 juin"
function dateFr() {
  return new Date().toLocaleDateString("fr-FR", {
    weekday: "long", day: "numeric", month: "long",
    timeZone: "Europe/Paris",
  });
}

// Construit le message des sorties du jour
function buildMessage(data) {
  const dateStr = dateFr();
  if (!data || data.counts.total === 0) {
    return `🗓️ **Sorties du jour — ${dateStr}**\n\nAucune sortie aujourd'hui 😴\n\n🔗 ${SITE_URL}`;
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
  msg += `\n🔗 Tout sur ${SITE_URL}`;
  return msg;
}

// Récupère les sorties et poste
async function postSorties() {
  try {
    console.log(`[${new Date().toISOString()}] Fetch des sorties...`);
    const res = await fetch(API_URL);
    if (!res.ok) throw new Error("API HTTP " + res.status);
    const data = await res.json();
    const channel = await client.channels.fetch(SORTIES_CHANNEL_ID);
    if (!channel) throw new Error("Salon #sorties introuvable");
    const message = buildMessage(data);
    await channel.send(message);
    console.log(`✅ Posté : ${data.counts.total} sorties (${data.counts.anime} anime, ${data.counts.games} jeux)`);
  } catch (err) {
    console.error("❌ Erreur postSorties :", err.message);
  }
}

client.once("clientReady", () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  console.log(`📅 Scheduler armé : tous les jours à 8h30 (Europe/Paris)`);

  // Cron : tous les jours à 8h30 heure de Paris
  cron.schedule("30 8 * * *", () => {
    console.log("⏰ 8h30 — déclenchement du post quotidien");
    postSorties();
  }, { timezone: "Europe/Paris" });

  // Commande manuelle de test via variable d'env au démarrage
  if (process.env.POST_NOW === "1") {
    console.log("🧪 POST_NOW=1 → test immédiat");
    postSorties();
  }
});

client.login(TOKEN);
