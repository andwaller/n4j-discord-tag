require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
  MessageFlags,
  PermissionFlagsBits
} = require("discord.js");

const {
  verifyConnectivity,
  ensureNeo4Constraints,
  ensureNeo4TagInfo,
  recordNeo4Snapshot,
  recordNeo4RoleSnapshot,
  recordNeo4DailyAdopterStatus,
  getNeo4SnapshotInsights,
  syncNeo4Adopters,
  getDaysToAdopt,
  getOrganicAdoptionProof,
  getReactivationHistory,
  recordNeo4Member,
  recordNeo4Referral
} = require("./neo4j");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

let inviteUsageCache = new Map();

async function fetchInviteUsage(guild) {
  const invites = await guild.invites.fetch();
  const usage = new Map();

  for (const invite of invites.values()) {
    usage.set(invite.code, {
      uses: invite.uses ?? 0,
      maxUses: invite.maxUses ?? null,
      inviterId: invite.inviter ? invite.inviter.id : null,
      inviterUsername: invite.inviter ? invite.inviter.username : null
    });
  }

  return usage;
}

function findUsedInviteCode(previousUsage, currentUsage) {
  for (const [code, current] of currentUsage.entries()) {
    const previous = previousUsage.get(code);

    if (previous && current.uses > previous.uses) {
      return code;
    }
  }

  // Single-use invites self-delete the moment they're consumed, so a code
  // that's now missing but was one use away from its max is the likely match.
  for (const [code, previous] of previousUsage.entries()) {
    if (!currentUsage.has(code) && previous.maxUses && previous.uses === previous.maxUses - 1) {
      return code;
    }
  }

  return null;
}

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
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
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
      const { total, adopterCount, rate, roleCounts, adopters } = await computeNeo4Stats(guild);
      const adoptionRate = Number(rate.toFixed(2));
      const date = new Date().toISOString().slice(0, 10);

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

      await recordNeo4DailyAdopterStatus(date);

      const roleRecords = [...roleCounts.entries()].map(([roleName, count]) => ({
        roleName,
        adopterCount: count
      }));

      await recordNeo4RoleSnapshot(date, roleRecords);
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

    await ensureNeo4TagInfo();
    console.log("NEO4 tag info ensured.");
  } catch (error) {
    console.error("Failed to initialize Neo4j:", error);
  }

  const guild = readyClient.guilds.cache.first();

  if (!guild) {
    console.log("No server found.");
    return;
  }

  console.log(`Connected to server: ${guild.name}`);

  try {
    inviteUsageCache = await fetchInviteUsage(guild);
    console.log(`NEO4 referral tracking: cached ${inviteUsageCache.size} invite(s).`);
  } catch (error) {
    console.error(
      "NEO4 referral tracking disabled: failed to fetch invites. The bot needs the " +
      "'Manage Server' permission granted in this server for referral attribution to work.",
      error
    );
  }

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

client.on(Events.GuildMemberAdd, async member => {
  try {
    await recordNeo4Member({
      discordUserId: member.id,
      username: member.user.username,
      displayName: member.displayName
    });
  } catch (error) {
    console.error(`[NEO4 referral] Failed to record Neo4Member for ${member.user.username}:`, error);
  }

  const previousUsage = inviteUsageCache;
  let currentUsage;

  try {
    currentUsage = await fetchInviteUsage(member.guild);
  } catch (error) {
    console.error(
      "[NEO4 referral] Attribution skipped: failed to fetch invites " +
      "(Manage Server permission may be missing).",
      error
    );
    return;
  }

  const usedCode = findUsedInviteCode(previousUsage, currentUsage);
  const inviterInfo = usedCode
    ? currentUsage.get(usedCode) || previousUsage.get(usedCode)
    : null;

  inviteUsageCache = currentUsage;

  if (!usedCode || !inviterInfo || !inviterInfo.inviterId) {
    console.log(`[NEO4 referral] Could not attribute join for ${member.user.username}.`);
    return;
  }

  try {
    await recordNeo4Referral(
      {
        discordUserId: inviterInfo.inviterId,
        username: inviterInfo.inviterUsername,
        displayName: inviterInfo.inviterUsername
      },
      {
        discordUserId: member.id,
        username: member.user.username
      },
      usedCode
    );
  } catch (error) {
    console.error(`[NEO4 referral] Failed to record referral for ${member.user.username}:`, error);
  }
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

    let growthText = "";

    try {
      const [organicProof, daysToAdopt, reactivations] = await Promise.all([
        getOrganicAdoptionProof(),
        getDaysToAdopt(),
        getReactivationHistory()
      ]);

      const growthLines = [];

      if (organicProof) {
        growthLines.push(
          `🌱 **${organicProof.adoptersAtFirstMeasurement.toLocaleString()}** adopted with zero promotion, ` +
          `within **${organicProof.daysUnmeasuredBeforeBaseline}** day(s) of launch (**${organicProof.tagAvailableSince}**) ` +
          `— before this bot could even measure it`
        );
      }

      if (daysToAdopt.length > 0) {
        const avgDays = daysToAdopt.reduce((sum, a) => sum + a.daysToAdopt, 0) / daysToAdopt.length;

        growthLines.push(
          `⏱️ Average days from joining the server to adopting NEO4: **${avgDays.toFixed(1)}**`
        );
      }

      if (reactivations.length > 0) {
        growthLines.push(
          `🔁 **${reactivations.length}** adopter(s) have re-adopted NEO4 after dropping it`
        );
      }

      if (growthLines.length > 0) {
        growthText = `\n\n**Growth insights**\n${growthLines.join("\n")}`;
      }
    } catch (error) {
      console.error("Failed to load NEO4 growth insights:", error);
    }

    const timestamp = Math.floor(Date.now() / 1000);

    const report =
`⚡ **NEO4 Server Tag Report**

**${adopterCount.toLocaleString()}** members currently display NEO4

👥 Total server members: **${total.toLocaleString()}**
📊 Adoption rate: **${rateDisplay}%**

${historyText}

**NEO4 adopters by role**
${roleText}${growthText}

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
