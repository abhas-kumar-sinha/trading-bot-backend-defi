import winston from "winston";

// --- sanitize errors so raw AxiosError objects never get fully logged ---
const sanitizeError = winston.format((info) => {
  const anyInfo = info as any;
  let err: any = null;

  // Case 1: logger.error(error)
  if (anyInfo instanceof Error) {
    err = anyInfo;
  }
  // Case 2: logger.error({ error })
  else if (anyInfo.error instanceof Error || (anyInfo.error && anyInfo.error.isAxiosError)) {
    err = anyInfo.error;
  }

  if (!err) return info;

  // AxiosError: keep only useful fields
  if (err.isAxiosError) {
    anyInfo.error = {
      name: err.name,
      message: err.message,
      status: err.response?.status,
      data: err.response?.data,
      url: err.config?.url,
      method: err.config?.method,
    };
  } else {
    // Generic Error: keep only small, meaningful fields
    anyInfo.error = {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }

  // Strip heavy/deep props if they were attached at top-level
  delete anyInfo.response;
  delete anyInfo.request;
  delete anyInfo.config;

  return info;
});

// --- transports ---
const transports: winston.transport[] = [];

  transports.push(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
    })
  );

// --- logger ---
const logger = winston.createLogger({
  level: "info",
  defaultMeta: { service: "crypto-monitor-bot" },
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }), // keeps stack for Error instances
    sanitizeError(),                        // strips heavy Axios internals
    winston.format.json()
  ),
  transports,
});

export default logger;
