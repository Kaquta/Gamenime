import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
dotenv.config({ path: "/opt/stack/.env" });

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const ANNONCES_CHANNEL_ID = "1513679204183445704";
const BIENVENUE_CHANNEL_ID = "1513679202723827802";

if (!TOKEN) {
  console.error("❌ DISCORD_BOT_TOKEN manquant");
  process.exit(1);
}

const ANNONCE = `🎉 **GameNime est officiellement OUVERT !** 🎉

Le site est en ligne : **https://gamenime.fr**

Le radar des sorties **animes & jeux vidéo** est maintenant accessible à tous ! 🎌🎮

✅ Suis tes animes et jeux favoris
✅ Reçois des notifs quand une date change ou qu'un trailer sort
✅ Ne rate plus jamais une sortie

Crée ton compte gratuit et explore les nouveautés. On compte sur vous pour faire grandir la communauté ! 🚀`;

const BIENVENUE = `🎌 **Bienvenue sur GameNime !** 🎮

🎉 **Le site est officiellement OUVERT !** 🎉

**👉 https://gamenime.fr**

Le radar des sorties **animes & jeux vidéo** : suis tes favoris, reçois des notifs quand une date change ou qu'un trailer sort, et ne rate plus jamais une sortie.

Crée ton compte gratuit et explore les nouveautés ! 🚀

Bon visionnage et bon jeu ! ❤️`;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once("clientReady", async () => {
  console.log(`✅ Connecté : ${client.user.tag}`);
  try {
    // 1. Annonce dans #annonces
    const annonces = await client.channels.fetch(ANNONCES_CHANNEL_ID);
    await annonces.send(ANNONCE);
    console.log("✅ Annonce postée dans #annonces");

    // 2. Éditer le message maintenance du bot dans #bienvenue
    const bienvenue = await client.channels.fetch(BIENVENUE_CHANNEL_ID);
    const messages = await bienvenue.messages.fetch({ limit: 20 });
    const botMessage = messages.find(m => m.author.id === client.user.id);
    if (botMessage) {
      await botMessage.edit(BIENVENUE);
      console.log("✅ Message maintenance remplacé dans #bienvenue");
    } else {
      // Si pas de message du bot trouvé, on en poste un nouveau
      await bienvenue.send(BIENVENUE);
      console.log("⚠️ Aucun message du bot trouvé, nouveau message posté dans #bienvenue");
    }
  } catch (err) {
    console.error("❌ Erreur :", err.message);
  } finally {
    client.destroy();
    process.exit(0);
  }
});
client.login(TOKEN);
