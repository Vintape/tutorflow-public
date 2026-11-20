import { defineConfig } from 'tsup';

export default defineConfig({
  // sqlite is a prefix-only Node builtin; stripping node: produces a package import.
  removeNodeProtocol: false,
});
