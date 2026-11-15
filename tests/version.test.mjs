// Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { isNewer } from "../lib/version.js";

test("a newer latest version means an update is available", () => {
  assert.equal(isNewer("3.5.1", "3.5.0"), true);
  assert.equal(isNewer("3.10.0", "3.9.9"), true);
  assert.equal(isNewer("4", "3.9.9"), true);
  assert.equal(isNewer("3.5.0", "3.5.0"), false);
  assert.equal(isNewer("3.4.9", "3.5.0"), false);
  assert.equal(isNewer(null, "3.5.0"), false);
  assert.equal(isNewer("not-a-version", "3.5.0"), false);
});
