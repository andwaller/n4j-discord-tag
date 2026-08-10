const neo4j = require("neo4j-driver");

const {
  NEO4J_URI,
  NEO4J_USERNAME,
  NEO4J_PASSWORD,
  NEO4J_DATABASE
} = process.env;

const driver = neo4j.driver(
  NEO4J_URI,
  neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD)
);

async function verifyConnectivity() {
  await driver.verifyConnectivity({ database: NEO4J_DATABASE });
}

async function ensureNeo4Constraints() {
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    await session.run(
      `CREATE CONSTRAINT neo4_snapshot_date_unique IF NOT EXISTS
       FOR (s:Neo4Snapshot) REQUIRE s.date IS UNIQUE`
    );

    await session.run(
      `CREATE CONSTRAINT neo4_adopter_discord_user_id_unique IF NOT EXISTS
       FOR (u:Neo4Adopter) REQUIRE u.discordUserId IS UNIQUE`
    );

    await session.run(
      `CREATE CONSTRAINT neo4_role_snapshot_unique IF NOT EXISTS
       FOR (r:Neo4RoleSnapshot) REQUIRE (r.date, r.roleName) IS UNIQUE`
    );

    await session.run(
      `CREATE CONSTRAINT neo4_tag_info_unique IF NOT EXISTS
       FOR (t:Neo4TagInfo) REQUIRE t.tagName IS UNIQUE`
    );

    await session.run(
      `CREATE CONSTRAINT neo4_adopter_daily_status_unique IF NOT EXISTS
       FOR (d:Neo4AdopterDailyStatus) REQUIRE (d.date, d.discordUserId) IS UNIQUE`
    );

    await session.run(
      `CREATE CONSTRAINT neo4_member_discord_user_id_unique IF NOT EXISTS
       FOR (m:Neo4Member) REQUIRE m.discordUserId IS UNIQUE`
    );
  } finally {
    await session.close();
  }
}

async function ensureNeo4TagInfo() {
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    await session.run(
      `MERGE (t:Neo4TagInfo {tagName: "NEO4"})
       ON CREATE SET t.availableSince = date("2026-08-05")`
    );
  } finally {
    await session.close();
  }
}

async function recordNeo4Snapshot({ totalMembers, adopters, adoptionRate }) {
  const date = new Date().toISOString().slice(0, 10);
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    // Runs the baseline check and the upsert in a single managed transaction
    // so a snapshot can only ever be marked baseline once, even though this
    // only ever runs from a single scheduled job.
    const result = await session.executeWrite(async tx => {
      const baselineCheck = await tx.run(
        `MATCH (b:Neo4Snapshot {baseline: true}) RETURN count(b) AS baselineCount`
      );

      const baselineCount = baselineCheck.records[0].get("baselineCount").toNumber();

      return tx.run(
        `MERGE (s:Neo4Snapshot {date: date($date)})
         ON CREATE SET s.createdAt = datetime(), s.tagName = $tagName
         SET s.totalMembers = $totalMembers,
             s.adopters = $adopters,
             s.adoptionRate = $adoptionRate,
             s.baseline = CASE
               WHEN s.baseline IS NULL AND $baselineCount = 0 THEN true
               ELSE coalesce(s.baseline, false)
             END
         RETURN s`,
        {
          date,
          tagName: "NEO4",
          totalMembers: neo4j.int(totalMembers),
          adopters: neo4j.int(adopters),
          adoptionRate,
          baselineCount: neo4j.int(baselineCount)
        }
      );
    });

    if (result.records.length === 0) {
      console.error(
        `Neo4j write for NEO4 snapshot on ${date} returned no rows. The write may not have been saved.`
      );
      return;
    }

    const saved = result.records[0].get("s").properties;

    console.log(
      `Saved NEO4 snapshot for ${date} at ${new Date().toISOString()}: ` +
      `totalMembers=${saved.totalMembers}, adopters=${saved.adopters}, ` +
      `adoptionRate=${saved.adoptionRate}%, baseline=${saved.baseline}`
    );
  } catch (error) {
    console.error(`Neo4j error while saving NEO4 snapshot for ${date}:`, error);
    throw error;
  } finally {
    await session.close();
  }
}

async function getNeo4SnapshotInsights() {
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    const baselineResult = await session.run(
      `MATCH (b:Neo4Snapshot {baseline: true})
       RETURN b.date AS date, b.adopters AS adopters, b.adoptionRate AS adoptionRate
       LIMIT 1`
    );

    const baselineRecord = baselineResult.records[0];

    const baseline = baselineRecord
      ? {
          date: baselineRecord.get("date").toString(),
          adopters: baselineRecord.get("adopters").toNumber(),
          adoptionRate: baselineRecord.get("adoptionRate")
        }
      : null;

    const weekAgoResult = await session.run(
      `MATCH (s:Neo4Snapshot)
       WHERE s.date <= date() - duration({days: 7})
       RETURN s.date AS date, s.adopters AS adopters
       ORDER BY s.date DESC
       LIMIT 1`
    );

    const weekAgoRecord = weekAgoResult.records[0];

    const weekAgo = weekAgoRecord
      ? {
          date: weekAgoRecord.get("date").toString(),
          adopters: weekAgoRecord.get("adopters").toNumber()
        }
      : null;

    return { baseline, weekAgo };
  } finally {
    await session.close();
  }
}

async function syncNeo4Adopters(adopters) {
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    const currentIds = adopters.map(a => a.discordUserId);

    const { newCount, continuingCount, stoppedCount, reactivatedCount } = await session.executeWrite(async tx => {
      const existingResult = await tx.run(
        `MATCH (u:Neo4Adopter) RETURN u.discordUserId AS discordUserId`
      );

      const existingIds = new Set(
        existingResult.records.map(record => record.get("discordUserId"))
      );

      const newCount = adopters.filter(a => !existingIds.has(a.discordUserId)).length;
      const continuingCount = adopters.length - newCount;

      const upsertResult = await tx.run(
        `UNWIND $adopters AS adopter
         MERGE (u:Neo4Adopter {discordUserId: adopter.discordUserId})
         ON CREATE SET
           u.firstSeen = datetime(),
           u.tagName = "NEO4",
           u.timesReactivated = 0
         WITH u, adopter, coalesce(u.active, true) AS wasActive
         SET
           u.username = adopter.username,
           u.displayName = adopter.displayName,
           u.guildJoinedAt = datetime(adopter.guildJoinedAt),
           u.timesReactivated = CASE
             WHEN wasActive = false THEN coalesce(u.timesReactivated, 0) + 1
             ELSE coalesce(u.timesReactivated, 0)
           END,
           u.lastSeen = datetime(),
           u.active = true
         RETURN count(CASE WHEN wasActive = false THEN 1 END) AS reactivatedCount`,
        { adopters }
      );

      const reactivatedCount = upsertResult.records[0].get("reactivatedCount").toNumber();

      const stoppedResult = await tx.run(
        `MATCH (u:Neo4Adopter {active: true})
         WHERE NOT u.discordUserId IN $currentIds
         SET u.active = false
         RETURN count(u) AS stoppedCount`,
        { currentIds }
      );

      const stoppedCount = stoppedResult.records[0].get("stoppedCount").toNumber();

      return { newCount, continuingCount, stoppedCount, reactivatedCount };
    });

    console.log(
      `[NEO4 adopters] current=${adopters.length} new=${newCount} ` +
      `continuing=${continuingCount} reactivated=${reactivatedCount} stopped=${stoppedCount}`
    );
  } catch (error) {
    console.error("Neo4j error while syncing NEO4 adopters:", error);
    throw error;
  } finally {
    await session.close();
  }
}

async function recordNeo4RoleSnapshot(date, roles) {
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    await session.run(
      `UNWIND $roles AS role
       MERGE (r:Neo4RoleSnapshot {date: date($date), roleName: role.roleName})
       ON CREATE SET r.createdAt = datetime(), r.tagName = "NEO4"
       SET r.adopterCount = role.adopterCount`,
      { date, roles }
    );

    console.log(`Saved NEO4 role snapshot for ${date}: ${roles.length} role(s).`);
  } catch (error) {
    console.error(`Neo4j error while saving NEO4 role snapshot for ${date}:`, error);
    throw error;
  } finally {
    await session.close();
  }
}

async function getDaysToAdopt() {
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    const result = await session.run(
      `MATCH (t:Neo4TagInfo {tagName: "NEO4"})
       MATCH (u:Neo4Adopter {active: true})
       WHERE date(u.guildJoinedAt) >= t.availableSince
       RETURN u.username AS username,
              u.guildJoinedAt AS guildJoinedAt,
              u.firstSeen AS firstSeen,
              duration.between(date(u.guildJoinedAt), date(u.firstSeen)).days AS daysToAdopt
       ORDER BY daysToAdopt`
    );

    return result.records.map(record => ({
      username: record.get("username"),
      guildJoinedAt: record.get("guildJoinedAt"),
      firstSeen: record.get("firstSeen"),
      daysToAdopt: record.get("daysToAdopt").toNumber()
    }));
  } finally {
    await session.close();
  }
}

async function getNeo4AdoptionTrend() {
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    const result = await session.run(
      `MATCH (t:Neo4TagInfo {tagName: "NEO4"})
       MATCH (s:Neo4Snapshot)
       RETURN t.availableSince AS tagAvailableSince,
              s.date AS date,
              s.totalMembers AS totalMembers,
              s.adopters AS adopters,
              s.adoptionRate AS adoptionRate
       ORDER BY s.date ASC`
    );

    return result.records.map(record => ({
      tagAvailableSince: record.get("tagAvailableSince").toString(),
      date: record.get("date").toString(),
      totalMembers: record.get("totalMembers").toNumber(),
      adopters: record.get("adopters").toNumber(),
      adoptionRate: record.get("adoptionRate")
    }));
  } finally {
    await session.close();
  }
}

async function getOrganicAdoptionProof() {
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    const result = await session.run(
      `MATCH (t:Neo4TagInfo {tagName: "NEO4"})
       MATCH (b:Neo4Snapshot {baseline: true})
       RETURN t.availableSince AS tagAvailableSince,
              b.date AS firstMeasuredDate,
              b.adopters AS adoptersAtFirstMeasurement,
              duration.between(t.availableSince, b.date).days AS daysUnmeasuredBeforeBaseline`
    );

    const record = result.records[0];

    if (!record) return null;

    return {
      tagAvailableSince: record.get("tagAvailableSince").toString(),
      firstMeasuredDate: record.get("firstMeasuredDate").toString(),
      adoptersAtFirstMeasurement: record.get("adoptersAtFirstMeasurement").toNumber(),
      daysUnmeasuredBeforeBaseline: record.get("daysUnmeasuredBeforeBaseline").toNumber()
    };
  } finally {
    await session.close();
  }
}

async function getReactivationHistory() {
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    const result = await session.run(
      `MATCH (u:Neo4Adopter)
       WHERE u.timesReactivated > 0
       RETURN u.username AS username, u.displayName AS displayName, u.timesReactivated AS timesReactivated
       ORDER BY u.timesReactivated DESC`
    );

    return result.records.map(record => ({
      username: record.get("username"),
      displayName: record.get("displayName"),
      timesReactivated: record.get("timesReactivated").toNumber()
    }));
  } finally {
    await session.close();
  }
}

async function recordNeo4DailyAdopterStatus(date) {
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    const result = await session.run(
      `MATCH (u:Neo4Adopter)
       MERGE (d:Neo4AdopterDailyStatus {date: date($date), discordUserId: u.discordUserId})
       ON CREATE SET d.tagName = "NEO4"
       SET d.active = u.active
       RETURN count(CASE WHEN d.active THEN 1 END) AS activeCount,
              count(CASE WHEN NOT d.active THEN 1 END) AS inactiveCount`,
      { date }
    );

    const record = result.records[0];
    const activeCount = record.get("activeCount").toNumber();
    const inactiveCount = record.get("inactiveCount").toNumber();

    console.log(
      `[NEO4 daily status] Saved daily status for ${date}: ${activeCount} active, ${inactiveCount} inactive.`
    );
  } catch (error) {
    console.error(`Neo4j error while saving NEO4 daily status for ${date}:`, error);
    throw error;
  } finally {
    await session.close();
  }
}

async function getAdoptersOnDate(date) {
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    const result = await session.run(
      `MATCH (d:Neo4AdopterDailyStatus {date: date($date), active: true})
       MATCH (u:Neo4Adopter {discordUserId: d.discordUserId})
       RETURN u.username AS username, u.displayName AS displayName
       ORDER BY u.username`,
      { date }
    );

    return result.records.map(record => ({
      username: record.get("username"),
      displayName: record.get("displayName")
    }));
  } finally {
    await session.close();
  }
}

async function getAbandonedOnDate(date) {
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    const result = await session.run(
      `MATCH (today:Neo4AdopterDailyStatus {date: date($date), active: false})
       MATCH (yesterday:Neo4AdopterDailyStatus {
         discordUserId: today.discordUserId,
         date: date($date) - duration({days: 1}),
         active: true
       })
       MATCH (u:Neo4Adopter {discordUserId: today.discordUserId})
       RETURN u.username AS username, u.displayName AS displayName
       ORDER BY u.username`,
      { date }
    );

    return result.records.map(record => ({
      username: record.get("username"),
      displayName: record.get("displayName")
    }));
  } finally {
    await session.close();
  }
}

async function recordNeo4Member(member) {
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    await session.run(
      `MERGE (m:Neo4Member {discordUserId: $discordUserId})
       SET m.username = $username,
           m.displayName = $displayName`,
      member
    );
  } catch (error) {
    console.error(`Neo4j error while recording Neo4Member ${member.discordUserId}:`, error);
    throw error;
  } finally {
    await session.close();
  }
}

async function recordNeo4Referral(inviter, newMember, inviteCode) {
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    await session.run(
      `MERGE (inviter:Neo4Member {discordUserId: $inviterId})
       SET inviter.username = $inviterUsername,
           inviter.displayName = $inviterDisplayName
       WITH inviter
       MATCH (newMember:Neo4Member {discordUserId: $newMemberId})
       MERGE (inviter)-[r:REFERRED {inviteCode: $inviteCode}]->(newMember)
       ON CREATE SET r.joinedAt = datetime()`,
      {
        inviterId: inviter.discordUserId,
        inviterUsername: inviter.username,
        inviterDisplayName: inviter.displayName,
        newMemberId: newMember.discordUserId,
        inviteCode
      }
    );

    console.log(
      `[NEO4 referral] ${inviter.username} referred ${newMember.username} via invite ${inviteCode}.`
    );
  } catch (error) {
    console.error(
      `Neo4j error while recording referral from ${inviter.discordUserId} to ${newMember.discordUserId}:`,
      error
    );
    throw error;
  } finally {
    await session.close();
  }
}

async function getTopReferrers() {
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    const result = await session.run(
      `MATCH (inviter:Neo4Member)-[r:REFERRED]->(newMember:Neo4Member)
       RETURN inviter.username AS inviter, count(r) AS totalReferred
       ORDER BY totalReferred DESC`
    );

    return result.records.map(record => ({
      inviter: record.get("inviter"),
      totalReferred: record.get("totalReferred").toNumber()
    }));
  } finally {
    await session.close();
  }
}

async function getReferralConversionRate() {
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    const result = await session.run(
      `MATCH (inviter:Neo4Member)-[:REFERRED]->(newMember:Neo4Member)
       OPTIONAL MATCH (inviterAdopter:Neo4Adopter {discordUserId: inviter.discordUserId})
       OPTIONAL MATCH (newMemberAdopter:Neo4Adopter {discordUserId: newMember.discordUserId, active: true})
       WITH inviterAdopter IS NOT NULL AS inviterIsAdopter, count(newMember) AS referred,
            count(newMemberAdopter) AS referredWhoAdopted
       RETURN inviterIsAdopter,
              referred,
              referredWhoAdopted,
              round(100.0 * referredWhoAdopted / referred, 1) AS conversionRatePct`
    );

    return result.records.map(record => ({
      inviterIsAdopter: record.get("inviterIsAdopter"),
      referred: record.get("referred").toNumber(),
      referredWhoAdopted: record.get("referredWhoAdopted").toNumber(),
      conversionRatePct: record.get("conversionRatePct")
    }));
  } finally {
    await session.close();
  }
}

module.exports = {
  driver,
  verifyConnectivity,
  ensureNeo4Constraints,
  ensureNeo4TagInfo,
  recordNeo4Snapshot,
  recordNeo4RoleSnapshot,
  recordNeo4DailyAdopterStatus,
  getNeo4SnapshotInsights,
  syncNeo4Adopters,
  getDaysToAdopt,
  getNeo4AdoptionTrend,
  getOrganicAdoptionProof,
  getReactivationHistory,
  getAdoptersOnDate,
  getAbandonedOnDate,
  recordNeo4Member,
  recordNeo4Referral,
  getTopReferrers,
  getReferralConversionRate
};
