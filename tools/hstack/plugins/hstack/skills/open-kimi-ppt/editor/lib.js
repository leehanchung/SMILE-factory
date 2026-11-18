export function normalizeRelativePath(value) {
  if (typeof value !== "string") {
    throw new TypeError("文件路径必须是字符串");
  }

  let path = value.trim().replaceAll("\\", "/");
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the original path when it contains a literal percent sign.
  }

  path = path.replace(/^file:\/\/+/, "").replace(/^\.\//, "");
  if (!path || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) {
    throw new Error(`不允许的绝对路径：${value}`);
  }

  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error(`不允许越过项目目录：${value}`);
    parts.push(part);
  }

  if (parts.length === 0) throw new Error(`无效文件路径：${value}`);
  return parts.join("/");
}

export function dirname(path) {
  const normalized = normalizeRelativePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

export function basename(path) {
  const normalized = normalizeRelativePath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function joinDeckPath(base, path) {
  const child = normalizeRelativePath(path);
  if (!base) return child;
  const normalizedBase = normalizeRelativePath(base);
  if (child === normalizedBase || child.startsWith(`${normalizedBase}/`)) return child;
  return normalizeRelativePath(`${normalizedBase}/${child}`);
}

function unquoteYamlScalar(value) {
  const text = value.trim();
  if (text.startsWith('"')) {
    const match = text.match(/^"(?:\\.|[^"\\])*"/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return match[0].slice(1, -1);
      }
    }
  }
  if (text.startsWith("'")) {
    const end = text.indexOf("'", 1);
    if (end !== -1) return text.slice(1, end).replaceAll("''", "'");
  }
  return text.replace(/\s+#.*$/, "").trim();
}

export function extractPagePaths(manifestText) {
  const trimmed = manifestText.trim();
  if (!trimmed) throw new Error("PPTD manifest 是空文件");

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed.pages)) throw new Error("PPTD manifest 缺少 pages 数组");
    return parsed.pages.map((path) => normalizeRelativePath(String(path)));
  }

  const lines = manifestText.replaceAll("\r\n", "\n").split("\n");
  const pageHeader = lines.findIndex((line) => /^(\s*)pages\s*:\s*(?:#.*)?$/.test(line));
  if (pageHeader === -1) throw new Error("PPTD manifest 缺少 pages 列表");

  const headerIndent = lines[pageHeader].match(/^\s*/)[0].length;
  const pages = [];
  for (let index = pageHeader + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= headerIndent && !/^\s*-/.test(line)) break;
    const match = line.match(/^\s*-\s*(.+?)\s*$/);
    if (!match) break;
    const path = unquoteYamlScalar(match[1]);
    if (path) pages.push(normalizeRelativePath(path));
  }

  if (pages.length === 0) throw new Error("PPTD manifest 的 pages 列表为空");
  return pages;
}

export function titleFromManifest(manifestText, fallback) {
  const trimmed = manifestText.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed).title || fallback;
    } catch {
      return fallback;
    }
  }
  const match = manifestText.match(/^title\s*:\s*(.+?)\s*$/m);
  return match ? unquoteYamlScalar(match[1]) : fallback;
}

export function assertWritableChangePath(base, requestedPath) {
  const path = joinDeckPath(base, requestedPath);
  if (!/\.(?:pptd|page)$/i.test(path)) {
    throw new Error(`为安全起见，仅允许编辑 .pptd/.page：${requestedPath}`);
  }
  return path;
}
