import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";

dotenv.config({ path: "/opt/stack/.env" });
dotenv.config();

const TOKEN = process.env.DISCORD_BOT_TOKEN;
// On crée l'invite depuis le salon #bienvenue
const CHANNEL_ID = process.env.INVITE_CHANNEL_ID;

if (!TOKEN || !CHANNEL_ID) {
  console.error("❌ DISCORD_BOT_TOKEN ou INVITE_CHANNEL_ID manquant");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", async () => {
  console.log(`✅ Connecté : ${client.user.tag}`);
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    const invite = await channel.createInvite({
      maxAge: 0,        // n'expire jamais
      maxUses: 0,       // illimité
      unique: false,    // réutilise un lien existant si possible
    });
    console.log("\n🎉 Lien d'invitation créé par le BOT :");
    console.log(`   https://discord.gg/${invite.code}`);
    console.log("\n→ Ce lien affichera 'GameNime BOT' comme inviteur.\n");
  } catch (err) {
    console.error("❌ Erreur :", err.message);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(TOKEN);
