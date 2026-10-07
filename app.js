#!/usr/bin/env node
import { openGui } from "./src/gui.js";

openGui().catch((err) => {
  console.error(err);
  process.exit(1);
});
