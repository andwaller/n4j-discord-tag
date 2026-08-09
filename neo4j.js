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

    const { newCount, continuingCount, stoppedCount } = await session.executeWrite(async tx => {
      const existingResult = await tx.run(
        `MATCH (u:Neo4Adopter) RETURN u.discordUserId AS discordUserId`
      );

      const existingIds = new Set(
        existingResult.records.map(record => record.get("discordUserId"))
      );

      const newCount = adopters.filter(a => !existingIds.has(a.discordUserId)).length;
      const continuingCount = adopters.length - newCount;

      await tx.run(
        `UNWIND $adopters AS adopter
         MERGE (u:Neo4Adopter {discordUserId: adopter.discordUserId})
         ON CREATE SET
           u.firstSeen = datetime(),
           u.tagName = "NEO4"
         SET
           u.username = adopter.username,
           u.displayName = adopter.displayName,
           u.guildJoinedAt = datetime(adopter.guildJoinedAt),
           u.lastSeen = datetime(),
           u.active = true`,
        { adopters }
      );

      const stoppedResult = await tx.run(
        `MATCH (u:Neo4Adopter {active: true})
         WHERE NOT u.discordUserId IN $currentIds
         SET u.active = false
         RETURN count(u) AS stoppedCount`,
        { currentIds }
      );

      const stoppedCount = stoppedResult.records[0].get("stoppedCount").toNumber();

      return { newCount, continuingCount, stoppedCount };
    });

    console.log(
      `[NEO4 adopters] current=${adopters.length} new=${newCount} ` +
      `continuing=${continuingCount} stopped=${stoppedCount}`
    );
  } catch (error) {
    console.error("Neo4j error while syncing NEO4 adopters:", error);
    throw error;
  } finally {
    await session.close();
  }
}

module.exports = {
  driver,
  verifyConnectivity,
  ensureNeo4Constraints,
  recordNeo4Snapshot,
  getNeo4SnapshotInsights,
  syncNeo4Adopters
};
