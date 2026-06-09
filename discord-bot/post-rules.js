import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";

dotenv.config({ path: "/opt/stack/.env" });
dotenv.config();

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const BIENVENUE_CHANNEL_ID = process.env.BIENVENUE_CHANNEL_ID;

if (!TOKEN || !BIENVENUE_CHANNEL_ID) {
  console.error("❌ DISCORD_BOT_TOKEN ou BIENVENUE_CHANNEL_ID manquant");
  process.exit(1);
}

const RULES = `# 🎌 Bienvenue sur GameNime !

**Le radar des sorties anime & jeux vidéo de la communauté FR.**
Ne rate plus jamais une sortie : suis tes animes et jeux préférés, reçois des alertes, et synchronise tout dans ton agenda. 📅

🔗 **Le site :** https://gamenime.fr

━━━━━━━━━━━━━━━━━━━━

## 📜 Règlement

**1.** Reste respectueux — aucune insulte, harcèlement, racisme ou propos haineux.
**2.** Pas de spam, pub ou autopromotion sans autorisation.
**3.** Balise tes spoilers avec \\|\\|spoiler\\|\\| et préviens (ex : *spoiler Demon Slayer S5*).
**4.** Aucun contenu NSFW, illégal, ni lien de streaming/téléchargement pirate.
**5.** Reste dans le bon salon (animes → #anime, jeux → #jeux…).
**6.** Le français est la langue principale du serveur.

En participant, tu acceptes ce règlement. L'équipe modère tout manquement. 🛡️

━━━━━━━━━━━━━━━━━━━━

💬 Présente-toi dans #présentations et viens papoter dans #général !
🐛 Un bug ou une idée ? → #aide-gamenime et #suggestions`;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", async () => {
  console.log(`✅ Connecté : ${client.user.tag}`);
  try {
    const channel = await client.channels.fetch(BIENVENUE_CHANNEL_ID);
    await channel.send(RULES);
    console.log("✅ Règlement posté dans #bienvenue !");
  } catch (err) {
    console.error("❌ Erreur :", err.message);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(TOKEN);
