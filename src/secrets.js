const ENV_VAR_RE = /\$\{([^}]+)\}/g;

export function expandSecrets(str) {
  if (typeof str !== "string") return str;
  if (!str.includes("${")) return str;
  return str.replace(ENV_VAR_RE, (_, name) => {
    if (!(name in process.env)) throw new Error(`Environment variable not set: ${name}`);
    return process.env[name];
  });
}

export function expandSecretsMap(obj) {
  if (!obj || typeof obj !== "object") return obj;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, expandSecrets(v)]));
}

export function envHeaderOverrides() {
  const headers = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("SPEC_HEADER_")) continue;
    const headerName = key.slice("SPEC_HEADER_".length).replace(/_/g, "-").toLowerCase();
    headers[headerName] = value;
  }
  return headers;
}

export function mergeHeaders(...maps) {
  const canonical = {};
  const result = {};
  for (const map of maps) {
    if (!map) continue;
    for (const [key, value] of Object.entries(map)) {
      const lower = key.toLowerCase();
      if (lower in canonical) {
        delete result[canonical[lower]];
      }
      canonical[lower] = key;
      result[key] = value;
    }
  }
  return result;
}

export function envUrlOverride() {
  return process.env.SPEC_URL;
}
