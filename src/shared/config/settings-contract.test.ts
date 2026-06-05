import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "@/entities/setting";
import { SETTINGS_CONTRACT, settingsContractPaths } from "./settings-contract";

function leafPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);

    if (entries.length === 0) {
      return prefix ? [prefix] : [];
    }

    return entries.flatMap(([key, child]) =>
      leafPaths(child, prefix ? `${prefix}.${key}` : key),
    );
  }
  return prefix ? [prefix] : [];
}

describe("settings runtime contract", () => {
  test("classifies every default settings leaf exactly once", () => {
    const schemaPaths = leafPaths(DEFAULT_SETTINGS).sort();
    const contractPaths = settingsContractPaths().sort();

    expect(contractPaths).toEqual(schemaPaths);
  });

  test("has no duplicate classifications", () => {
    const paths = settingsContractPaths();
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("keeps no-runtime settings explicit", () => {
    expect(SETTINGS_CONTRACT.noRuntimeEffectYet).toContain(
      "general.receivePrereleaseUpdates",
    );
    expect(SETTINGS_CONTRACT.noRuntimeEffectYet).toContain(
      "general.sendCrashReports",
    );
  });
});
