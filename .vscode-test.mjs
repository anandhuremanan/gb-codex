import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';

// Integration tests run against a throwaway workspace (inside the git-ignored .vscode-test folder).
const workspaceFolder = '.vscode-test/fixture-workspace';
// A stale test profile makes VS Code restore extra windows, which run the suite twice in parallel.
fs.rmSync('.vscode-test/user-data', { recursive: true, force: true });
fs.rmSync(workspaceFolder, { recursive: true, force: true });
fs.mkdirSync(`${workspaceFolder}/src`, { recursive: true });
fs.writeFileSync(`${workspaceFolder}/src/math.ts`, 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
fs.writeFileSync(`${workspaceFolder}/README.md`, '# Fixture\n');

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder,
	mocha: { timeout: 60000 },
});
