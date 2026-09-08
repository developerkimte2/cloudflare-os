import { beforeEach, describe, expect, it } from "vitest";
import { NodeSqliteExecutor } from "../src/db/node-sqlite.js";
import { migrate } from "../src/db/migrations.js";
import { Repository } from "../src/db/repository.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/rules/config.js";

describe("loadConfig", () => {
  let repo: Repository;
  beforeEach(() => {
    const db = new NodeSqliteExecutor();
    migrate(db);
    repo = new Repository(db);
  });

  it("returns the defaults when nothing is stored", () => {
    expect(loadConfig(repo)).toEqual(DEFAULT_CONFIG);
  });

  it("reflects the §16 default thresholds", () => {
    const config = loadConfig(repo);
    expect(config.entityAutoConfidence).toBe(0.99);
    expect(config.activitySummaryConfidence).toBe(0.9);
    expect(config.dateConfidence).toBe(0.95);
    expect(config.nextActionAutoConfidence).toBe(0.85);
    expect(config.stalledDays).toBe(7);
  });
});

describe("saveConfig", () => {
  let repo: Repository;
  beforeEach(() => {
    const db = new NodeSqliteExecutor();
    migrate(db);
    repo = new Repository(db);
  });

  it("persists a valid patch and merges it with the defaults", () => {
    const updated = saveConfig(repo, { stalledDays: 14 }, "2026-09-08T00:00:00Z");
    expect(updated.stalledDays).toBe(14);
    expect(updated.entityAutoConfidence).toBe(DEFAULT_CONFIG.entityAutoConfidence);
    // Persisted across a fresh load.
    expect(loadConfig(repo).stalledDays).toBe(14);
  });

  it("rejects an unknown config key", () => {
    expect(() => saveConfig(repo, { notAKey: 1 } as never, "2026-09-08T00:00:00Z")).toThrow(TypeError);
  });

  it("rejects a value of the wrong type for a known key", () => {
    expect(() => saveConfig(repo, { stalledDays: "14" } as never, "2026-09-08T00:00:00Z")).toThrow(TypeError);
    expect(() => saveConfig(repo, { phaseLabels: "a,b" } as never, "2026-09-08T00:00:00Z")).toThrow(TypeError);
  });

  it("accepts an array-typed field (phaseLabels)", () => {
    const updated = saveConfig(repo, { phaseLabels: ["提案", "契約"] }, "2026-09-08T00:00:00Z");
    expect(updated.phaseLabels).toEqual(["提案", "契約"]);
  });

  it("does not lose previously saved keys when saving a new one", () => {
    saveConfig(repo, { stalledDays: 14 }, "2026-09-08T00:00:00Z");
    saveConfig(repo, { dateConfidence: 0.8 }, "2026-09-08T01:00:00Z");
    const config = loadConfig(repo);
    expect(config.stalledDays).toBe(14);
    expect(config.dateConfidence).toBe(0.8);
  });
});
