require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
  MessageFlags
} = require("discord.js");

const { verifyConnectivity, ensureBaselineSnapshot } = require("./neo4j");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

const commands = [
  new SlashCommandBuilder()
    .setName("n4j-stats")
    .setDescription("Show Neo4j Server Tag adoption statistics")
].map(command => command.toJSON());

client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  try {
    await verifyConnectivity();
    console.log("Connected to Neo4j.");

    await ensureBaselineSnapshot();
    console.log("Neo4j baseline snapshot ensured.");
  } catch (error) {
    console.error("Failed to initialize Neo4j:", error);
  }

  const guild = readyClient.guilds.cache.first();

  if (!guild) {
    console.log("No server found.");
    return;
  }

  console.log(`Connected to server: ${guild.name}`);

  const rest = new REST({ version: "10" })
    .setToken(process.env.DISCORD_TOKEN);

  try {
    console.log("Registering /n4j-stats command...");

    await rest.put(
      Routes.applicationGuildCommands(
        readyClient.user.id,
        guild.id
      ),
      { body: commands }
    );

    console.log("/n4j-stats registered successfully.");
  } catch (error) {
    console.error("Failed to register command:", error);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "n4j-stats") return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const guild = interaction.guild;

    if (!guild) {
      await interaction.editReply(
        "This command must be run inside the Neo4j server."
      );
      return;
    }

    const members = await guild.members.fetch();

    const adopters = [];
    const roleCounts = new Map();

    for (const member of members.values()) {
      const primaryGuild = member.user.primaryGuild;

      const usesN4J =
        primaryGuild &&
        primaryGuild.identityGuildId === guild.id &&
        primaryGuild.identityEnabled;

      if (!usesN4J) continue;

      adopters.push(member);

      for (const role of member.roles.cache.values()) {
        if (role.id === guild.id) continue;

        roleCounts.set(
          role.name,
          (roleCounts.get(role.name) || 0) + 1
        );
      }
    }

    const total = members.size;
    const adopterCount = adopters.length;

    const rate = total
      ? ((adopterCount / total) * 100).toFixed(2)
      : "0.00";

    // Only show roles held by at least 2 N4J adopters.
    // This removes most one-off/noisy roles.
    const significantRoles = [...roleCounts.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1]);

    let roleText = "No shared roles found.";

    if (significantRoles.length > 0) {
      roleText = significantRoles
        .map(([role, count]) => `• **${role}:** ${count}`)
        .join("\n");
    }

    const timestamp = Math.floor(Date.now() / 1000);

    const report =
`⚡ **N4J Server Tag Report**

**${adopterCount.toLocaleString()}** members currently display N4J

👥 Total server members: **${total.toLocaleString()}**
📊 Adoption rate: **${rate}%**

**N4J adopters by role**
${roleText}

_Last updated <t:${timestamp}:f>_`;

    await interaction.editReply(report);

  } catch (error) {
    console.error("Error generating N4J stats:", error);

    await interaction.editReply(
      "There was an error generating the N4J Server Tag report."
    );
  }
});

client.login(process.env.DISCORD_TOKEN);