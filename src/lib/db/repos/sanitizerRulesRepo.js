import { getAdapter } from "../driver.js";

const TABLE = "sanitizerRules";

export async function getAllSanitizerRules() {
  const db = await getAdapter();
  return db.all(`SELECT * FROM ${TABLE} ORDER BY priority ASC, id ASC`);
}

export async function getSanitizerRulesByProvider(provider) {
  const db = await getAdapter();
  return db.all(
    `SELECT * FROM ${TABLE} WHERE provider = 'all' OR provider = ? ORDER BY priority ASC, id ASC`,
    [provider]
  );
}

export async function createSanitizerRule(rule) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO ${TABLE} (id, type, pattern, replacement, enabled, priority, provider, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rule.id, rule.type, rule.pattern, rule.replacement || "",
      rule.enabled ?? 1, rule.priority ?? 0, rule.provider || "all",
      now, now
    ]
  );
  return { ...rule, createdAt: now, updatedAt: now };
}

export async function updateSanitizerRule(id, changes) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const sets = [];
  const values = [];
  for (const [key, val] of Object.entries(changes)) {
    if (["type", "pattern", "replacement", "enabled", "priority", "provider"].includes(key)) {
      sets.push(`${key} = ?`);
      values.push(val);
    }
  }
  sets.push("updatedAt = ?");
  values.push(now);
  values.push(id);
  db.run(`UPDATE ${TABLE} SET ${sets.join(", ")} WHERE id = ?`, values);
}

export async function deleteSanitizerRule(id) {
  const db = await getAdapter();
  db.run(`DELETE FROM ${TABLE} WHERE id = ?`, [id]);
}

export async function countSanitizerRules() {
  const db = await getAdapter();
  const row = db.get(`SELECT COUNT(*) as count FROM ${TABLE}`);
  return row.count;
}

export async function seedDefaultSanitizerRules(rules) {
  const existing = await countSanitizerRules();
  if (existing > 0) return; // Don't overwrite user customizations
  for (const rule of rules) {
    await createSanitizerRule(rule);
  }
}
