const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require("discord.js");

const data = new SlashCommandBuilder()
  .setName("dm-role")
  .setDescription("Preview a DM campaign targeted at a role (does not send DMs)")
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
  const campaign = interaction.options.getString("campaign", true);
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

    const preview =
`📋 **DM Campaign Preview**

**Campaign:** ${campaign}
**Role:** ${role.name}
**Eligible human members:** ${humanCount.toLocaleString()}
**Bots skipped:** ${botCount.toLocaleString()}

**Message:**
${message}

_No DMs have been sent — preview only._`;

    await interaction.editReply(preview);
  } catch (error) {
    console.error("Error generating dm-role preview:", error);

    await interaction.editReply(
      "There was an error generating the DM campaign preview."
    );
  }
}

module.exports = { data, execute };
