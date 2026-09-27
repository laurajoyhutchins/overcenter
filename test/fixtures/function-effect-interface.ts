interface Plugin {
  run(): void;
}

declare const plugin: Plugin;
plugin.run();
