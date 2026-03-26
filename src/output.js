import YAML from "yaml";

let outputFormat = "json";

export function setFormat(format) {
  if (format && ["json", "text", "yaml"].includes(format)) {
    outputFormat = format;
  }
}

export function out(data) {
  switch (outputFormat) {
    case "yaml":
      console.log(YAML.stringify(data).trimEnd());
      break;
    case "text":
      console.log(formatText(data));
      break;
    case "json":
    default:
      console.log(JSON.stringify(data, null, 2));
      break;
  }
}

export function err(message) {
  // Errors are always JSON for reliable agent parsing
  console.error(JSON.stringify({ error: message }));
}

function formatText(data, indent = 0) {
  if (data === null || data === undefined) return "null";
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);

  if (Array.isArray(data)) {
    if (data.length === 0) return "(empty)";
    return data
      .map((item, i) => {
        if (typeof item === "object" && item !== null) {
          return `${"  ".repeat(indent)}[${i}]\n${formatText(item, indent + 1)}`;
        }
        return `${"  ".repeat(indent)}- ${item}`;
      })
      .join("\n");
  }

  if (typeof data === "object") {
    return Object.entries(data)
      .map(([key, val]) => {
        if (val === null || val === undefined) return `${"  ".repeat(indent)}${key}: null`;
        if (typeof val === "object") {
          return `${"  ".repeat(indent)}${key}:\n${formatText(val, indent + 1)}`;
        }
        return `${"  ".repeat(indent)}${key}: ${val}`;
      })
      .join("\n");
  }

  return String(data);
}
