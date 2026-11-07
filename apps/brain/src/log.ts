export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = (level: LogLevel, msg: string, data?: Record<string, unknown>) => void;

export const consoleLogger = (minLevel: LogLevel = "info"): Logger => {
  const order: LogLevel[] = ["debug", "info", "warn", "error"];
  return (level, msg, data) => {
    if (order.indexOf(level) < order.indexOf(minLevel)) return;
    const line = `${new Date().toISOString().slice(11, 23)} ${level.padEnd(5)} ${msg}${data ? " " + JSON.stringify(data) : ""}`;
    (level === "error" ? console.error : console.log)(line);
  };
};
