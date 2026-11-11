#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { runDoctor, renderDoctorReport } from "../lib/doctor.js";

const args = process.argv.slice(2);
let json = false;
let envFile = "";

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--json") {
    json = true;
  } else if (argument === "--env-file") {
    envFile = args[index + 1] || "";
    index += 1;
    if (!envFile) throw new Error("--env-file requires a path.");
  } else if (argument === "--help" || argument === "-h") {
    console.log("Usage: npm run doctor -- [--env-file PATH] [--json]");
    process.exit(0);
  } else {
    throw new Error(`Unknown doctor option: ${argument}`);
  }
}

const doctorEnv = envFile
  ? { ...process.env, ...parseEnv(await readFile(resolve(envFile), "utf8")) }
  : process.env;

const report = await runDoctor({ env: doctorEnv, cwd: fileURLToPath(new URL("../", import.meta.url)) });
console.log(json ? JSON.stringify(report, null, 2) : renderDoctorReport(report));
process.exitCode = report.ok ? 0 : 1;
