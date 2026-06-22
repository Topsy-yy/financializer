const path = require("path");
const express = require("express");
const config = require("./config");
const apiRouter = require("./routes/api");

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.resolve(process.cwd(), "public")));
app.use("/api", apiRouter);

app.listen(config.port, () => {
  // Startup log is intentionally concise for local and cloud logs.
  console.log(`AI Financial Controller running on port ${config.port}`);
});
