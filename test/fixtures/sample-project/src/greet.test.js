import { test } from "node:test";
import assert from "node:assert/strict";
import { greet, farewell } from "./greet.js";

test("greet", () => {
  assert.equal(greet("world"), "Hello, world!");
});

test("farewell", () => {
  assert.equal(farewell("world"), "Goodbye, world.");
});
