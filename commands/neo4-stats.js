const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require("discord.js");

const {
  getNeo4SnapshotInsights,
  getOrganicAdoptionProof,
  getDaysToAdopt,
  getReactivationHistory
} = require("../neo4j");

const data = new SlashCommandBuilder()
  .setName("neo4-stats")
  .setDescription("Show NEO4 Server Tag adoption statistics")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

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

async function execute(interaction) {
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
          `⏱️ Average days to adopt NEO4, for members who joined since launch: **${avgDays.toFixed(1)}**`
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
}

module.exports = { data, execute, computeNeo4Stats };
