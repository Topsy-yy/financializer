const { execFile } = require("child_process");
const config = require("../config");

function runAvalanche(args) {
  return new Promise((resolve, reject) => {
    execFile(config.avalancheCliPath, args, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Avalanche CLI failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

module.exports = {
  runAvalanche
};
