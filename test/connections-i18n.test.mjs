import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const dir = new URL("../public/i18n/", import.meta.url);
const flatten = (value, prefix = "") => Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
  const name = prefix ? `${prefix}.${key}` : key;
  return typeof child === "string" ? [[name, child]] : Object.entries(flatten(child, name));
}));
const english = flatten(JSON.parse(await readFile(new URL("en.json", dir), "utf8")));
const keys = Object.keys(english).filter((key) => key.startsWith("deviceSync.") || ["gptAccounts.add", "gptAccounts.signIn", "gptAccounts.removeLogin", "gptAccounts.connectionHelp", "gptAccounts.loginPrivacy"].includes(key) || key.startsWith("gptAccounts.login."));
const placeholders = (value) => [...value.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
assert(keys.length >= 30, "the nested dictionaries must actually be checked");
for (const file of await readdir(dir)) {
  if (!file.endsWith(".json")) continue;
  const locale = flatten(JSON.parse(await readFile(new URL(file, dir), "utf8")));
  for (const key of keys) {
    assert.equal(typeof locale[key], "string", `${file}: ${key}`);
    assert(locale[key].trim(), `${file}: empty ${key}`);
    assert.deepEqual(placeholders(locale[key]), placeholders(english[key]), `${file}: ${key} placeholders`);
  }
}
console.log("Account/device text: all supported languages and placeholders passed.");
