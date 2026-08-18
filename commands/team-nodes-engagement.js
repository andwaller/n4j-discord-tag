const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require("discord.js");

const { isTeamNodesAdopterMember } = require("./neo4-stats");
const { getTeamNodesEngagementForWeek, getTeamNodesEngagementHistory } = require("../neo4j");
const { weekStartUtc, CAMPAIGN_END_MS } = require("../team-nodes-engagement");

const TRACKED_CHANNELS_TEXT =
  "graph-academy, aura, cypher, genai, visualization, data-science, suggestion, " +
  "step-1, help, general (+ their threads)";

const data = new SlashCommandBuilder()
  .setName("team-nodes-engagement")
  .setDescription("Show weekly Neo4j Team Nodes engagement in tracked channels")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

async function execute(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const guild = interaction.guild;

    if (!guild) {
      await interaction.editReply("This command must be run inside the Neo4j server.");
      return;
    }

    const members = await guild.members.fetch();
    const teamNodesAdopters = [...members.values()].filter(member =>
      isTeamNodesAdopterMember(member, guild.id)
    );

    const weekStart = weekStartUtc(new Date()).toISOString().slice(0, 10);
    const engaged = await getTeamNodesEngagementForWeek(weekStart);
    const engagementById = new Map(engaged.map(e => [e.discordUserId, e]));

    const matched = teamNodesAdopters.filter(member => engagementById.has(member.id));
    const unmatched = teamNodesAdopters.filter(member => !engagementById.has(member.id));

    // The invoking admin's own entry always goes last, so they review
    // everyone else's engagement before their own.
    const orderedMatched = [
      ...matched.filter(member => member.id !== interaction.user.id),
      ...matched.filter(member => member.id === interaction.user.id)
    ];

    const history = await getTeamNodesEngagementHistory();

    const engagedBlock = orderedMatched.length > 0
      ? orderedMatched
          .map((member, index) => {
            const links = engagementById.get(member.id).messageLinks;
            return [
              `${index + 1}. ${member.displayName} (@${member.user.username})`,
              ...links.map(link => `    ${link}`)
            ].join("\n");
          })
          .join("\n\n")
      : "_none_";

    const lines = [
      `📊 **Team Nodes Engagement — Week of ${weekStart}**`,
      "",
      `Tracking channels: ${TRACKED_CHANNELS_TEXT}`,
      `Tracking through **${new Date(CAMPAIGN_END_MS).toISOString().slice(0, 10)}**`,
      "",
      `**${matched.length} / ${teamNodesAdopters.length}** Team Nodes adopters posted this week`,
      "",
      "**Engaged:**",
      "",
      engagedBlock,
      "",
      "**Not yet engaged:**",
      ...(unmatched.length > 0
        ? unmatched.map(member => `- ${member.displayName} (@${member.user.username})`)
        : ["_none_"])
    ];

    if (history.length > 0) {
      lines.push("", "**Weekly history:**");
      for (const week of history) {
        lines.push(`- ${week.weekStart}: **${week.engagedCount}** engaged`);
      }
    }

    await interaction.editReply(lines.join("\n"));
  } catch (error) {
    console.error("Error generating Team Nodes engagement report:", error);

    await interaction.editReply(
      "There was an error generating the Team Nodes engagement report."
    );
  }
}

module.exports = { data, execute };
