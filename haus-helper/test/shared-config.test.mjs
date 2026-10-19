import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../lib/store.mjs";
import { SharedConfig } from "../lib/shared-config.mjs";
test("shared preferences use revision guards and do not accept credentials or arbitrary settings", () => {
  const store = new Store(":memory:", "/tmp");
  try {
    const shared = new SharedConfig(store);
    assert.equal(shared.get().revision, "0");
    const first = shared.patch("0", { roomIcons: { narnia: "moon" } });
    assert.equal(shared.patch("0", { favorites: ["bad"] }).conflict, true);
    assert.deepEqual(shared.get().value, { roomIcons: { narnia: "moon" } });
    assert.ok(
      shared.patch(first.revision, { favorites: ["lamp"] }).revision !==
        first.revision,
    );
    assert.throws(() =>
      shared.patch(shared.get().revision, { access_token: "secret" }),
    );
  } finally {
    store.close();
  }
});
