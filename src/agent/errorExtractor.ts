export function extractBuildErrors(output: string): string {
  if (!output) {
    return "";
  }

  const lines = output.split(/\r?\n/);
  const errors: string[] = [];

  // Regex patterns matching file-based build errors across Rust, Go, TS, Java, C#, and Python
  const patterns = [
    // TypeScript / JS: src/App.tsx(12,3) or src/App.tsx:12:3
    /([a-zA-Z0-9_\-\./]+\.[a-zA-Z0-9]+)\s*[:(](\d+)(?:[:,\s](\d+))?[:)]?\s*-\s*error\s+TS\d+:\s*(.+)/i,
    // C# / .NET: src/App.cs(12,3): error CS0103: ...
    /([a-zA-Z0-9_\-\./]+\.[a-zA-Z0-9]+)\s*[:(](\d+)(?:[:,\s](\d+))?[:)]?\s*[:]\s*error\s+[A-Z0-9]+:\s*(.+)/i,
    // Go: path/to/file.go:12:3: description
    /([a-zA-Z0-9_\-\./]+\.go):(\d+):(\d+):\s*(.+)/i,
    // Rust: --> src/main.rs:12:3
    /^\s*-->\s*([a-zA-Z0-9_\-\./]+\.rs):(\d+):(\d+)/i,
    // Java: [ERROR] path/to/File.java:[12,3] description
    /\[ERROR\]\s+([a-zA-Z0-9_\-\./]+\.java):\[(\d+),(\d+)\]\s*(.+)/i,
    // General filename:line:error structure
    /([a-zA-Z0-9_\-\./]+\.[a-zA-Z0-9]+):(\d+):\s*(error|fail|exception|undefined|invalid|mismatch)/i
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    
    // Filter out common build noise
    if (
      trimmed.includes("npm ERR!") ||
      trimmed.includes("node_modules") ||
      trimmed.includes("Watching for file changes") ||
      trimmed.includes("Starting compilation in watch mode") ||
      trimmed.includes("Progress:") ||
      trimmed.includes("VITE") ||
      trimmed.includes("compiled successfully")
    ) {
      continue;
    }

    const isMatch = patterns.some(pat => pat.test(trimmed));
    if (isMatch) {
      errors.push(trimmed);
    }
  }

  // If no structured errors matched, fall back to lines containing "error", "fail", "failed"
  if (errors.length === 0) {
    const fallbackLines = lines
      .map(l => l.trim())
      .filter(l => {
        const lower = l.toLowerCase();
        return (lower.includes("error") || lower.includes("fail") || lower.includes("exception")) && 
               !lower.includes("npm err!") && !lower.includes("node_modules");
      });
    
    if (fallbackLines.length > 0) {
      return fallbackLines.slice(0, 10).join("\n");
    }
    
    // If still empty, return a subset of the raw output
    return output.slice(0, 1000);
  }

  return errors.slice(0, 8).join("\n");
}
