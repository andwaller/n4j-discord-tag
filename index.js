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

const {
  verifyConnectivity,
  ensureNeo4Constraints,
  recordNeo4Snapshot,
  getNeo4SnapshotInsights,
  syncNeo4Adopters
} = require("./neo4j");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

const commands = [
  new SlashCommandBuilder()
    .setName("neo4-stats")
    .setDescription("Show NEO4 Server Tag adoption statistics")
].map(command => command.toJSON());

async function computeNeo4Stats(guild) {
  const members = await guild.members.fetch();

  const adopters = [];
  const roleCounts = new Map();

  for (const member of members.values()) {
    const primaryGuild = member.user.primaryGuild;

    const usesNeo4Tag =
      primaryGuild &&
      primaryGuild.identityGuildId === guild.id &&
      primaryGuild.identityEnabled;

    if (!usesNeo4Tag) continue;

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
  const rate = total ? (adopterCount / total) * 100 : 0;

  return { total, adopterCount, rate, roleCounts, adopters };
}

function scheduleNeo4Snapshots(guild) {
  const runSnapshot = async () => {
    const startedAt = new Date().toISOString();
    console.log(`[NEO4 snapshot] Job starting at ${startedAt}`);

    try {
      const { total, adopterCount, rate, adopters } = await computeNeo4Stats(guild);
      const adoptionRate = Number(rate.toFixed(2));

      console.log(`[NEO4 snapshot] Discord member count: ${total}`);
      console.log(`[NEO4 snapshot] NEO4 adopter count: ${adopterCount}`);
      console.log(`[NEO4 snapshot] Adoption rate: ${adoptionRate}%`);

      await recordNeo4Snapshot({
        totalMembers: total,
        adopters: adopterCount,
        adoptionRate
      });

      const adopterRecords = adopters.map(member => ({
        discordUserId: member.id,
        username: member.user.username,
        displayName: member.displayName,
        guildJoinedAt: member.joinedAt ? member.joinedAt.toISOString() : null
      }));

      await syncNeo4Adopters(adopterRecords);
    } catch (error) {
      console.error("[NEO4 snapshot] Failed to record snapshot:", error);
    }
  };

  console.log("Scheduling NEO4 snapshots: once now, then every 24 hours.");
  runSnapshot();
  setInterval(runSnapshot, ONE_DAY_MS);
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  try {
    await verifyConnectivity();
    console.log("Connected to Neo4j.");

    await ensureNeo4Constraints();
    console.log("NEO4 constraints ensured.");
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
    console.log("Registering /neo4-stats command...");

    await rest.put(
      Routes.applicationGuildCommands(
        readyClient.user.id,
        guild.id
      ),
      { body: commands }
    );

    console.log("/neo4-stats registered successfully.");
  } catch (error) {
    console.error("Failed to register command:", error);
  }

  scheduleNeo4Snapshots(guild);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "neo4-stats") return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const guild = interaction.guild;

    if (!guild) {
      await interaction.editReply(
        "This command must be run inside the Neo4j server."
      );
      return;
    }

    const { total, adopterCount, rate, roleCounts } = await computeNeo4Stats(guild);
    const rateDisplay = rate.toFixed(2);

    // Only show roles held by at least 2 NEO4 adopters.
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

    let insights = null;

    try {
      insights = await getNeo4SnapshotInsights();
    } catch (error) {
      console.error("Failed to load NEO4 snapshot history:", error);
    }

    let historyText = "_Historical comparison unavailable._";

    if (insights && insights.baseline) {
      const { baseline, weekAgo } = insights;

      const sign = n => (n >= 0 ? "+" : "");

      const adopterDelta = adopterCount - baseline.adopters;

      const growthPct = baseline.adopters > 0
        ? ((adopterCount - baseline.adopters) / baseline.adopters) * 100
        : null;

      const rateDelta = Number(rateDisplay) - baseline.adoptionRate;

      const lines = [
        `📌 Baseline (**${baseline.date}**): **${baseline.adopters.toLocaleString()}** adopters`,
        `📈 Change since baseline: **${sign(adopterDelta)}${adopterDelta.toLocaleString()}** adopters` +
          (growthPct !== null ? ` (**${sign(growthPct)}${growthPct.toFixed(2)}%**)` : ""),
        `📊 Adoption rate change since baseline: **${sign(rateDelta)}${rateDelta.toFixed(2)} pts**`
      ];

      if (weekAgo) {
        const weekDelta = adopterCount - weekAgo.adopters;

        lines.push(
          `🗓️ Change vs ~7 days ago (**${weekAgo.date}**): **${sign(weekDelta)}${weekDelta.toLocaleString()}** adopters`
        );
      }

      historyText = lines.join("\n");
    }

    const timestamp = Math.floor(Date.now() / 1000);

    const report =
`⚡ **NEO4 Server Tag Report**

**${adopterCount.toLocaleString()}** members currently display NEO4

👥 Total server members: **${total.toLocaleString()}**
📊 Adoption rate: **${rateDisplay}%**

${historyText}

**NEO4 adopters by role**
${roleText}

_Last updated <t:${timestamp}:f>_`;

    await interaction.editReply(report);

  } catch (error) {
    console.error("Error generating NEO4 stats:", error);

    await interaction.editReply(
      "There was an error generating the NEO4 Server Tag report."
    );
  }
});

client.login(process.env.DISCORD_TOKEN);
