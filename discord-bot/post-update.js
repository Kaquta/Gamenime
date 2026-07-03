import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
dotenv.config({ path: "/opt/stack/.env" });

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const ANNONCES_CHANNEL_ID = "1513679204183445704";

if (!TOKEN) {
  console.error("❌ DISCORD_BOT_TOKEN manquant");
  process.exit(1);
}

const ANNONCE = `🎉 **GameNime — Nouvelle mise à jour !** 🎉

Salut à tous ! On a bossé pour améliorer votre expérience. Voici les nouveautés du moment 👇

📅 **Page "À venir" repensée**
Naviguez plus facilement grâce aux nouveaux onglets **🎬 Animes** et **🎮 Jeux** ! Un simple clic pour basculer entre les deux, et un catalogue élargi pour découvrir encore plus de sorties à venir. ✨

🎨 **Page Préférences relookée**
Un nouveau design plus clair et élégant pour gérer vos alertes et notifications. Plus agréable à utiliser au quotidien !

🔔 **Rappels par email**
Recevez désormais un rappel **7 jours avant** les sorties que vous attendez. Ne ratez plus jamais rien ! 🎯

👉 Rendez-vous sur **https://gamenime.fr** pour découvrir tout ça !
Merci de faire grandir la communauté GameNime ❤️`;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", async () => {
  console.log(`✅ Connecté : ${client.user.tag}`);
  try {
    const annonces = await client.channels.fetch(ANNONCES_CHANNEL_ID);
    await annonces.send(ANNONCE);
    console.log("✅ Annonce mise à jour postée dans #annonces");
  } catch (err) {
    console.error("❌ Erreur :", err.message);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(TOKEN);
