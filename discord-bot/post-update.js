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

Salut à tous ! Du nouveau sur le site 👇

📡 **"Cette semaine" — le radar des épisodes**
Directement sur l'accueil : tous les épisodes qui sortent cette semaine, jour par jour. Avec l'heure française exacte et un compte à rebours sur le prochain à tomber. ⏱️
Clique sur un jour pour voir ses sorties, sur un animé pour ouvrir sa fiche.

👀 **Une lecture plus claire**
Les plateformes sont maintenant précises — **PS5**, **Xbox X|S**, **Switch 2** au lieu du générique. Et sur la page Animé, trois onglets pour ne plus tout mélanger : **Animé**, **Film**, et **Sorti JP** pour ce qui est diffusé au Japon sans plateforme européenne annoncée.

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
