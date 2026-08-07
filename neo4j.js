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

async function ensureBaselineSnapshot() {
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    await session.run(
      `CREATE CONSTRAINT n4j_snapshot_date_unique IF NOT EXISTS
       FOR (s:N4JSnapshot) REQUIRE s.date IS UNIQUE`
    );

    await session.run(
      `MERGE (s:N4JSnapshot {date: date($date)})
       SET s.totalMembers = $totalMembers,
           s.adopters = $adopters,
           s.adoptionRate = $adoptionRate,
           s.baseline = true,
           s.label = $label`,
      {
        date: "2026-08-07",
        totalMembers: neo4j.int(10212),
        adopters: neo4j.int(15),
        adoptionRate: 0.15,
        label: "Pre-promotion baseline"
      }
    );
  } finally {
    await session.close();
  }
}

async function recordDailySnapshot({ totalMembers, adopters, adoptionRate }) {
  const date = new Date().toISOString().slice(0, 10);
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    // The WHERE guard skips the update when the matched node is the
    // existing baseline snapshot (e.g. a daily run landing on the
    // baseline's own date), so the baseline is never overwritten.
    const result = await session.run(
      `MERGE (s:N4JSnapshot {date: date($date)})
       ON CREATE SET s.createdAt = datetime()
       WITH s
       WHERE s.baseline IS NULL OR s.baseline = false
       SET s.totalMembers = $totalMembers,
           s.adopters = $adopters,
           s.adoptionRate = $adoptionRate
       RETURN s`,
      {
        date,
        totalMembers: neo4j.int(totalMembers),
        adopters: neo4j.int(adopters),
        adoptionRate
      }
    );

    if (result.records.length === 0) {
      console.log(
        `Skipped daily N4J snapshot for ${date}: baseline snapshot already exists for this date.`
      );
    } else {
      console.log(`Recorded daily N4J snapshot for ${date}.`);
    }
  } finally {
    await session.close();
  }
}

async function getSnapshotInsights() {
  const session = driver.session({ database: NEO4J_DATABASE });

  try {
    const baselineResult = await session.run(
      `MATCH (b:N4JSnapshot {baseline: true})
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
      `MATCH (s:N4JSnapshot)
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

module.exports = {
  driver,
  verifyConnectivity,
  ensureBaselineSnapshot,
  recordDailySnapshot,
  getSnapshotInsights
};
