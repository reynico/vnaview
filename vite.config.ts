import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

function gitShortHash(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  root: 'src',
  define: {
    __GIT_COMMIT__: JSON.stringify(gitShortHash()),
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
