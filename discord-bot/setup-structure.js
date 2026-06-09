import { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } from "discord.js";
import dotenv from "dotenv";

// Charge le .env de /opt/stack/
dotenv.config({ path: "/opt/stack/.env" });

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !GUILD_ID) {
  console.error("❌ DISCORD_BOT_TOKEN ou DISCORD_GUILD_ID manquant dans .env");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Structure : catégories + salons. readonly = lecture seule pour @everyone
const STRUCTURE = [
  {
    category: "📌 Accueil",
    channels: [
      { name: "bienvenue", readonly: true },
      { name: "annonces", readonly: true },
    ],
  },
  {
    category: "💬 Communauté",
    channels: [
      { name: "général", readonly: false },
      { name: "présentations", readonly: false },
    ],
  },
  {
    category: "🎌 Le contenu",
    channels: [
      { name: "anime", readonly: false },
      { name: "jeux", readonly: false },
      { name: "sorties", readonly: true },
    ],
  },
  {
    category: "🛠️ Support",
    channels: [
      { name: "aide-gamenime", readonly: false },
      { name: "suggestions", readonly: false },
    ],
  },
];

client.once("ready", async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    console.log(`📡 Serveur : ${guild.name}`);
    const everyoneId = guild.roles.everyone.id;

    for (const block of STRUCTURE) {
      // Créer la catégorie
      const cat = await guild.channels.create({
        name: block.category,
        type: ChannelType.GuildCategory,
      });
      console.log(`📁 Catégorie créée : ${block.category}`);

      // Créer les salons dedans
      for (const ch of block.channels) {
        const overwrites = [];
        if (ch.readonly) {
          // @everyone peut voir/lire mais PAS écrire
          overwrites.push({
            id: everyoneId,
            deny: [PermissionFlagsBits.SendMessages],
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          });
        }
        await guild.channels.create({
          name: ch.name,
          type: ChannelType.GuildText,
          parent: cat.id,
          permissionOverwrites: overwrites,
        });
        console.log(`   #${ch.name}${ch.readonly ? " (lecture seule)" : ""}`);
      }
    }

    console.log("\n🎉 Structure créée avec succès !");
  } catch (err) {
    console.error("❌ Erreur :", err.message);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(TOKEN);
