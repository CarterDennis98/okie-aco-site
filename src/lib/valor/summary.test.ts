/**
 * What adding a backup shows before anything is built: the groups the export needs, and the
 * Target side only when this build runs it -- the second instance with "Target tasks" on.
 */
import { describe, expect, it } from "vitest";
import type { ValorBackup } from "@/lib/valor/format";
import { hasTargetSide, summarizeValorBackup } from "@/lib/valor/summary";
import { IDS, valorBackup } from "../../../tests/valor/fixture";

/** The fixture with every Target group gone: an instance that leaves Target to Shikari. */
function withoutTarget(): ValorBackup {
  const b = valorBackup();
  delete b.profiles.groups[IDS.target];
  delete b.profiles.lists[IDS.target];
  delete b.tasks.groups[IDS.targetTasks];
  delete b.tasks.lists[IDS.targetTasks];
  delete b.accounts.groups[IDS.targetLogins];
  delete b.accounts.lists[IDS.targetLogins];
  return b;
}

const managed = (lines: { name: string; managed: boolean }[]) =>
  Object.fromEntries(lines.map((l) => [l.name, l.managed]));

describe("summarizeValorBackup", () => {
  it("asks for the Target groups only when this build runs Target", () => {
    expect(summarizeValorBackup(withoutTarget(), true).problems).toEqual([
      'no profile group named "Target"',
      'no task group named "Target"',
      'no login group named "Target"',
    ]);
    expect(summarizeValorBackup(withoutTarget(), false).problems).toEqual([]);
  });

  it("says Target is rebuilt with it on, and left as it is with it off", () => {
    const on = summarizeValorBackup(valorBackup(), true);
    const off = summarizeValorBackup(valorBackup(), false);
    expect(managed(on.profileGroups)).toMatchObject({ "ACO Main": true, Target: true });
    expect(managed(off.profileGroups)).toMatchObject({ "ACO Main": true, Target: false });
    expect(managed(on.taskGroups)).toMatchObject({ "PKC ACO - ISP": true, Target: true });
    expect(managed(off.taskGroups)).toMatchObject({ "PKC ACO - ISP": true, Target: false });
    expect(managed(on.loginGroups)).toEqual({ Target: true, Walmart: false });
    expect(managed(off.loginGroups)).toEqual({ Target: false, Walmart: false });
    expect(off.taskGroups.find((g) => g.name === "Target")?.count).toBe(2);
  });

  it("still needs the Pokémon Center groups either way", () => {
    const b = withoutTarget();
    delete b.tasks.groups[IDS.resi];
    expect(summarizeValorBackup(b, false).problems).toEqual([
      'no task group named "PKC ACO - Resi"',
    ]);
  });
});

describe("hasTargetSide", () => {
  it("is there when any Target group is, and not when none is", () => {
    expect(hasTargetSide(valorBackup())).toBe(true);
    expect(hasTargetSide(withoutTarget())).toBe(false);
    const loginsOnly = withoutTarget();
    loginsOnly.accounts.groups["a-t"] = {
      id: "a-t",
      name: "target",
      totalAmount: 0,
      site: "Target",
    };
    expect(hasTargetSide(loginsOnly)).toBe(true);
  });
});
