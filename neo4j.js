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

module.exports = { driver, verifyConnectivity, ensureBaselineSnapshot };
