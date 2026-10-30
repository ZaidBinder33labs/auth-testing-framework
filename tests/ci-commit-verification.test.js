const test = require("node:test");
const assert = require("node:assert/strict");

test("CI environment exposes a valid commit SHA", () => {
  if (process.env.CI === "true") {
    assert.match(
      process.env.GITHUB_SHA || "",
      /^[a-f0-9]{40}$/i,
      "GitHub Actions must provide a valid commit SHA"
    );
  }
});
