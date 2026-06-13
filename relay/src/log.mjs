import { LOG_LEVEL } from "./config.mjs";

const ts = () => new Date().toISOString().slice(11, 23);
const fmt = (lvl, msg, extra) => `${ts()} ${lvl} ${msg}${extra ? " " + JSON.stringify(extra) : ""}`;

export const log = {
  info: (m, e) => LOG_LEVEL >= 1 && console.log(fmt("INFO", m, e)),
  warn: (m, e) => console.warn(fmt("WARN", m, e)),
  trace: (m, e) => LOG_LEVEL >= 2 && console.log(fmt("TRACE", m, e)),
};
