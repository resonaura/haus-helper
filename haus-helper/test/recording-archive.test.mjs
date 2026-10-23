import test from "node:test";
import assert from "node:assert/strict";
import { archiveNodes } from "../lib/recording-archive.mjs";

test("archives only to fresh, verified storage nodes that are not pressured", () => {
  const now = 100_000;
  const nodes = [
    { id: "busy", enabled: true, roles: ["storage"] },
    { id: "clear", enabled: true, roles: ["storage"] },
    { id: "unknown", enabled: true, roles: ["storage"] },
    { id: "offline", enabled: true, roles: ["storage"] },
    { id: "unverified", enabled: true, roles: ["storage"] },
  ];
  const health = new Map(
    nodes.map((node) => [
      node.id,
      {
        online: node.id !== "offline",
        lastSeen: now - 1000,
        remote: {
          resources:
            node.id === "unknown"
              ? undefined
              : { pressured: node.id === "busy" },
          storage: {
            verification: { supported: node.id !== "unverified" },
          },
        },
      },
    ]),
  );
  const cluster = { nodes: () => nodes, health };

  assert.deepEqual(
    archiveNodes(cluster, now).map(({ id }) => id),
    ["clear", "unknown"],
  );

  health.get("clear").remote.resources.pressured = true;
  assert.deepEqual(
    archiveNodes(cluster, now).map(({ id }) => id),
    ["unknown"],
  );

  health.get("unknown").remote.resources = { pressured: true };
  assert.deepEqual(archiveNodes(cluster, now), []);
});
