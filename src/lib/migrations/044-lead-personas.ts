// Lead persona axes from the personalization quiz.
//
// The quiz at /quiz produces 4 axis answers per visitor:
//   sun_moon       : 'sun' | 'moon'
//   beach_mountain : 'beach' | 'mountain'
//   spring_fall    : 'spring' | 'fall'
//   stars_clouds   : 'stars' | 'clouds'
//
// Before this table the quiz emailed Cody and dropped the answers.
// Per audit move 3: persist them so a prospect who took the quiz
// before becoming a lead can have their persona threaded into their
// proposal's engagement strategy at compose time. The composer
// joins by signer email; when a match exists the persona axes flow
// into engagement_strategy.persona_axes for downstream voice
// variants (snippet author can branch on persona, future moves).
//
// PRIMARY KEY on email so re-taking the quiz UPSERTs the latest
// answers (people change their mind; the most recent pick wins).

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '044-lead-personas',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS lead_personas (
        email TEXT PRIMARY KEY,
        name TEXT,
        sun_moon TEXT,
        beach_mountain TEXT,
        spring_fall TEXT,
        stars_clouds TEXT,
        theme TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  },
};

export default migration;
