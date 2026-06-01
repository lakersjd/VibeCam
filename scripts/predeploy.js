const fs = require("fs");
const path = require("path");

const files = [
  path.join(__dirname, "..", "bans.json"),
  path.join(__dirname, "..", "reports.json")
];

for (const file of files) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(file.includes("reports") ? [] : {}, null, 2));
    console.log("Created:", path.basename(file));
  } else {
    console.log("Exists:", path.basename(file));
  }
}

console.log("Pre-deploy setup complete.");
