const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const { recordDmCampaign } = require("../neo4j");

const RATE_LIMIT_DELAY_MS = 1200;
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const PROGRESS_UPDATE_INTERVAL = 5;
const DMS_CLOSED_ERROR_CODE = 50007;

// Keyed by the originating slash command interaction's id (a unique Discord
// snowflake), which also gets embedded in the button customIds below.
const pendingCampaigns = new Map();

const data = new SlashCommandBuilder()
  .setName("dm-role")
  .setDescription("Send a DM campaign targeted at a role")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addRoleOption(option =>
    option
      .setName("role")
      .setDescription("Role to target (cannot be @everyone)")
      .setRequired(true))
  .addStringOption(option =>
    option
      .setName("campaign")
      .setDescription("Campaign name")
      .setRequired(true)
      .setMaxLength(100))
  .addStringOption(option =>
    option
      .setName("message")
      .setDescription("DM message content")
      .setRequired(true)
      .setMaxLength(2000));

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildPreviewText({ campaignName, roleName, humanCount, botCount, message }) {
  return (
`📋 **DM Campaign Preview**

**Campaign:** ${campaignName}
**Role:** ${roleName}
**Eligible human members:** ${humanCount.toLocaleString()}
**Bots skipped:** ${botCount.toLocaleString()}

**Message:**
${message}

⚠️ No DMs have been sent yet. Click **Confirm Send** to deliver this message, or **Cancel** to discard it.
_This confirmation expires in 5 minutes._`
  );
}

function buildButtonRow(campaignId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`dmrole:confirm:${campaignId}`)
      .setLabel("Confirm Send")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`dmrole:cancel:${campaignId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );
}

function expireCampaign(campaignId) {
  const state = pendingCampaigns.get(campaignId);
  if (!state || state.status !== "pending") return;

  state.status = "expired";
  pendingCampaigns.delete(campaignId);

  state.interaction
    .editReply({
      content: `${state.previewText}\n\n_This confirmation has expired. Run /dm-role again to start a new campaign._`,
      components: []
    })
    .catch(error => console.error("[dm-role] Failed to update expired campaign message:", error));
}

async function execute(interaction) {
  const guild = interaction.guild;

  if (!guild) {
    await interaction.reply({
      content: "This command must be run inside a server.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "Only server admins can use this command.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const role = interaction.options.getRole("role", true);
  const campaignName = interaction.options.getString("campaign", true);
  const message = interaction.options.getString("message", true);

  if (role.id === guild.id) {
    await interaction.reply({
      content: "You can't target @everyone with this command.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const members = await guild.members.fetch();

    let humanCount = 0;
    let botCount = 0;

    for (const member of members.values()) {
      if (!member.roles.cache.has(role.id)) continue;

      if (member.user.bot) {
        botCount++;
      } else {
        humanCount++;
      }
    }

    const campaignId = interaction.id;

    const previewText = buildPreviewText({
      campaignName,
      roleName: role.name,
      humanCount,
      botCount,
      message
    });

    const expiryTimer = setTimeout(() => expireCampaign(campaignId), CONFIRMATION_TTL_MS);

    pendingCampaigns.set(campaignId, {
      adminId: interaction.user.id,
      guildId: guild.id,
      roleId: role.id,
      roleName: role.name,
      campaignName,
      message,
      status: "pending",
      previewText,
      interaction,
      expiryTimer
    });

    await interaction.editReply({
      content: previewText,
      components: [buildButtonRow(campaignId)]
    });
  } catch (error) {
    console.error("Error generating dm-role preview:", error);

    await interaction.editReply(
      "There was an error generating the DM campaign preview."
    );
  }
}

async function sendCampaign(interaction, campaignId, state) {
  const startedAt = new Date().toISOString();

  try {
    const guild = interaction.guild;
    const role = guild.roles.cache.get(state.roleId) ?? await guild.roles.fetch(state.roleId).catch(() => null);

    let eligibleMembers = [];

    if (role) {
      // Deliberately reads the cache rather than calling guild.members.fetch()
      // again: execute() already did a full fetch moments ago for the preview,
      // and a second full-guild member fetch this soon after trips Discord's
      // gateway rate limit on REQUEST_GUILD_MEMBERS for large guilds. The
      // GuildMembers intent keeps this cache live via gateway events in the
      // meantime, so this still reflects current membership/role state.
      eligibleMembers = [...guild.members.cache.values()].filter(
        member => member.roles.cache.has(role.id) && !member.user.bot
      );
    }

    const eligible = eligibleMembers.length;
    let delivered = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < eligibleMembers.length; i++) {
      const member = eligibleMembers[i];

      try {
        await member.send(state.message);
        delivered++;
      } catch (error) {
        if (error?.code === DMS_CLOSED_ERROR_CODE) {
          skipped++;
        } else {
          failed++;
          console.error(`[dm-role] Failed to DM ${member.user.username}:`, error);
        }
      }

      const processed = i + 1;
      const isLast = processed === eligibleMembers.length;

      if (!isLast) {
        await sleep(RATE_LIMIT_DELAY_MS);

        if (processed % PROGRESS_UPDATE_INTERVAL === 0) {
          await interaction
            .editReply({
              content: `${state.previewText}\n\n_Sending DMs... ${processed}/${eligible} processed._`,
              components: []
            })
            .catch(() => {});
        }
      }
    }

    const completedAt = new Date().toISOString();

    const summary =
`✅ **DM Campaign Complete**

**Campaign:** ${state.campaignName}
**Role:** ${state.roleName}

**Eligible:** ${eligible.toLocaleString()}
**Delivered:** ${delivered.toLocaleString()}
**Failed:** ${failed.toLocaleString()}
**Skipped (DMs closed):** ${skipped.toLocaleString()}`;

    await interaction.editReply({ content: summary, components: [] });

    try {
      await recordDmCampaign({
        campaignName: state.campaignName,
        roleId: state.roleId,
        roleName: state.roleName,
        startedAt,
        completedAt,
        eligible,
        delivered,
        failed,
        skipped,
        initiatingAdminId: state.adminId
      });
    } catch (error) {
      console.error("[dm-role] Failed to log DM campaign to Neo4j:", error);
    }
  } catch (error) {
    console.error("[dm-role] Campaign send failed:", error);

    await interaction
      .editReply({
        content: "There was an error sending this DM campaign. Some messages may not have been delivered.",
        components: []
      })
      .catch(() => {});
  } finally {
    state.status = "completed";
    pendingCampaigns.delete(campaignId);
  }
}

async function handleButton(interaction) {
  const [, action, campaignId] = interaction.customId.split(":");
  const state = pendingCampaigns.get(campaignId);

  if (!state) {
    await interaction.reply({
      content: "This DM campaign confirmation has expired or was already used.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.user.id !== state.adminId) {
    await interaction.reply({
      content: "Only the admin who started this campaign can confirm or cancel it.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (state.status !== "pending") {
    await interaction.reply({
      content: "This confirmation has already been processed.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (action === "cancel") {
    state.status = "canceled";
    clearTimeout(state.expiryTimer);
    pendingCampaigns.delete(campaignId);

    await interaction.update({
      content: `${state.previewText}\n\n_Campaign canceled. No DMs were sent._`,
      components: []
    });
    return;
  }

  if (action === "confirm") {
    // Flipping status before any await closes the race: a second click's
    // handler invocation can't interleave with this synchronous prefix.
    state.status = "processing";
    clearTimeout(state.expiryTimer);

    await interaction.update({
      content: `${state.previewText}\n\n_Sending DMs..._`,
      components: []
    });

    await sendCampaign(interaction, campaignId, state);
  }
}

module.exports = { data, execute, handleButton };
