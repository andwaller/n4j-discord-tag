const { Events } = require("discord.js");

const { isTeamNodesAdopterMember } = require("./commands/neo4-stats");
const { recordTeamNodesEngagement } = require("./neo4j");

// Matched by ID so channel renames don't break tracking.
const TARGET_CHANNEL_IDS = new Set([
  "816956538512998440", // graph-academy
  "854674503668990032", // aura
  "818578585194594334", // cypher
  "1161686426476351530", // genai
  "859317168851779604", // visualization
  "816630747136786484", // data-science
  "819928762107822100", // suggestion
  "787958373890392064", // step-1-what-are-you-building
  "1430618351046234142", // help (forum — matched via thread parentId)
  "788809846949412878"  // general
]);

const CAMPAIGN_END_MS = Date.UTC(2026, 8, 30, 23, 59, 59, 999); // end of September 2026

function weekStartUtc(date) {
  const truncated = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = truncated.getUTCDay(); // 0 (Sun) .. 6 (Sat)
  const diffToMonday = day === 0 ? -6 : 1 - day;
  truncated.setUTCDate(truncated.getUTCDate() + diffToMonday);
  return truncated;
}

function isTrackedChannel(channel) {
  if (!channel) return false;
  if (TARGET_CHANNEL_IDS.has(channel.id)) return true;
  // Forum posts and other threads report their parent via parentId, so this
  // also covers any future thread created under a tracked channel.
  if (channel.parentId && TARGET_CHANNEL_IDS.has(channel.parentId)) return true;
  return false;
}

function registerTeamNodesEngagementTracking(client) {
  client.on(Events.MessageCreate, async message => {
    try {
      if (Date.now() > CAMPAIGN_END_MS) return;
      if (!message.inGuild()) return;
      if (message.author.bot) return;
      if (!isTrackedChannel(message.channel)) return;

      const member = message.member
        ?? await message.guild.members.fetch(message.author.id).catch(() => null);

      if (!member) return;
      if (!isTeamNodesAdopterMember(member, message.guild.id)) return;

      const weekStart = weekStartUtc(new Date(message.createdTimestamp)).toISOString().slice(0, 10);

      await recordTeamNodesEngagement({
        discordUserId: member.id,
        username: member.user.username,
        displayName: member.displayName,
        weekStart,
        channelName: message.channel.name,
        messageAt: new Date(message.createdTimestamp).toISOString()
      });
    } catch (error) {
      console.error("[team-nodes-engagement] Failed to record message engagement:", error);
    }
  });

  console.log(
    `Team Nodes engagement tracking active for ${TARGET_CHANNEL_IDS.size} channel(s) ` +
    `through ${new Date(CAMPAIGN_END_MS).toISOString().slice(0, 10)}.`
  );
}

module.exports = {
  TARGET_CHANNEL_IDS,
  CAMPAIGN_END_MS,
  weekStartUtc,
  isTrackedChannel,
  registerTeamNodesEngagementTracking
};
