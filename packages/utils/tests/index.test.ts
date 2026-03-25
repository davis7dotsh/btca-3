import { expect, test } from "vite-plus/test";
import { demoFunc } from "../src/index.ts";

test("demoFunc", () => {
  expect(demoFunc()).toBe("wow this ran somewhere else");
});
