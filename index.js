require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Events
} = require("discord.js");

const {
  verifyConnectivity,
  ensureNeo4Constraints,
  ensureNeo4TagInfo,
  recordNeo4Snapshot,
  recordNeo4RoleSnapshot,
  recordNeo4DailyAdopterStatus,
  syncNeo4Adopters,
  recordNeo4Member,
  recordNeo4Referral
} = require("./neo4j");

const neo4Stats = require("./commands/neo4-stats");
const dmRole = require("./commands/dm-role");

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

const commandModules = [neo4Stats, dmRole];
const commandsByName = new Map(
  commandModules.map(module => [module.data.name, module])
);

const commands = commandModules.map(module => module.data.toJSON());

function scheduleNeo4Snapshots(guild) {
  const runSnapshot = async () => {
    const startedAt = new Date().toISOString();
    console.log(`[NEO4 snapshot] Job starting at ${startedAt}`);

    try {
      const { total, adopterCount, rate, roleCounts, adopters } = await neo4Stats.computeNeo4Stats(guild);
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
    console.log("Registering slash commands...");

    await rest.put(
      Routes.applicationGuildCommands(
        readyClient.user.id,
        guild.id
      ),
      { body: commands }
    );

    console.log("Slash commands registered successfully.");
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
  if (interaction.isChatInputCommand()) {
    const command = commandsByName.get(interaction.commandName);
    if (command) await command.execute(interaction);
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("dmrole:")) {
    await dmRole.handleButton(interaction);
  }
});

client.login(process.env.DISCORD_TOKEN);
