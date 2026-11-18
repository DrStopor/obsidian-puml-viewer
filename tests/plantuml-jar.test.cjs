const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { env, execPath, platform } = require('node:process');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { setImmediate } = require('node:timers');
const { setImmediate: nextTurn } = require('node:timers/promises');
const vm = require('node:vm');

const source = '@startuml\nAlice -> Bob: Привет\n@enduml';
const bundle = require('node:fs').readFileSync(require.resolve('../main.js'), 'utf8');

async function openPlugin({ settings, desktop, vaultPath, nodeModules = {}, timers = {} } = {}) {
  const imports = [];
  const requests = [];
  let saves = 0;
  class FileSystemAdapter {
    getBasePath() { return vaultPath; }
  }
  class Plugin {
    app = { vault: { adapter: new FileSystemAdapter() }, workspace: { onLayoutReady() {}, getLeavesOfType: () => [] } };
    async loadData() { return settings; }
    async saveData() { saves++; }
    registerView(_, factory) { this.createView = factory; }
    registerExtensions() {}
    addCommand() {}
    registerMarkdownCodeBlockProcessor() {}
    addSettingTab() {}
  }
  const module = { exports: {} };
  vm.runInNewContext(bundle, {
    module, exports: module.exports, AbortController, DOMException, Error, TextDecoder, window: {},
    setTimeout, clearTimeout, ...timers,
    require(name) {
      imports.push(name);
      if (name === 'obsidian') {
        return {
          Plugin, FileSystemAdapter,
          ItemView: class { constructor(leaf) { this.leaf = leaf; } },
          Modal: class {}, PluginSettingTab: class {},
          Platform: { isDesktopApp: !!desktop, isWin: platform === 'win32' },
          requestUrl(options) { requests.push(options); return Promise.resolve({ status: 200 }); },
        };
      }
      assert.ok(desktop, `Mobile attempted to load ${name}`);
      return nodeModules[name] ?? require(name);
    },
  }, { filename: 'main.js' });
  const plugin = new module.exports.default();
  await plugin.onload();
  return { plugin, imports, requests, saves: () => saves };
}

function fakeJava() {
  const launches = [];
  const kills = [];
  const waiting = [];
  return {
    launches, kills,
    launch(index) {
      return launches[index] ?? new Promise((resolve) => { waiting[index] = resolve; });
    },
    nodeModules: {
      'node:process': {
        env,
        kill(pid) {
          kills.push(pid);
          launches.find((launch) => launch.child.pid === -pid)?.finish(null, '', '', 'SIGKILL');
        },
      },
      'node:child_process': {
        spawn(executable, args, options) {
          const child = new EventEmitter();
          child.stdin = new PassThrough();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.exitCode = null;
          child.signalCode = null;
          child.pid = launches.length + 100;
          let input = '';
          child.stdin.setEncoding('utf8');
          child.stdin.on('data', (chunk) => { input += chunk; });
          const marker = args[args.indexOf('-pipedelimitor') + 1];
          const launch = {
            child, executable, args, options, marker,
            get input() { return input; },
            /**
             * @param {number | null} [code]
             * @param {string | Buffer} [output]
             * @param {string} [stderr]
             * @param {NodeJS.Signals | null} [signal]
             */
            finish(code = 0, output = '', stderr = '', signal = null) {
              child.stdout.end(output);
              child.stderr.end(stderr);
              child.exitCode = code;
              child.signalCode = signal;
              setImmediate(() => child.emit('close', code, signal));
            },
          };
          child.kill = () => {
            kills.push(child.pid);
            launch.finish(null, '', '', 'SIGKILL');
          };
          launches.push(launch);
          waiting[launches.length - 1]?.(launch);
          return child;
        },
        execFile(_file, args, _options, done) {
          const pid = Number(args[1]);
          kills.push(pid);
          launches.find((launch) => launch.child.pid === pid)?.finish(null, '', '', 'SIGKILL');
          done(null);
        },
      },
    },
  };
}

async function withFakeJava(t, options = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'puml-viewer-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const jar = join(directory, 'Проверка JAR.jar');
  await fs.writeFile(jar, '');
  const java = fakeJava();
  const { plugin } = await openPlugin({
    desktop: true, vaultPath: directory, nodeModules: java.nodeModules,
    settings: { serverType: 'jar', javaExecutable: execPath, plantumlJarPath: jar, plantumlLimitSize: 16384 },
    ...options,
  });
  t.after(() => plugin.onunload());
  return { plugin, java, directory, jar };
}

test('the mobile bundle preserves HTTP routes and blocks a synced JAR selection', async () => {
  for (const [mode, type, method, path] of [
    ['plantuml', 'plantuml', 'GET', /^\/plantuml\/svg\//],
    ['local', 'plantuml', 'GET', /^\/svg\//],
    ['kroki', 'plantuml', 'POST', /^\/plantuml\/svg$/],
    ['local', 'mermaid', 'POST', /^\/mermaid\/svg$/],
  ]) {
    const { plugin, imports, requests, saves } = await openPlugin({ settings: { serverType: mode } });
    await plugin.requestDiagram(source, 'svg', type);
    assert.equal(requests[0].method, method);
    assert.match(new URL(requests[0].url).pathname, path);
    assert.equal(requests[0].body, method === 'POST' ? source : undefined);
    assert.deepEqual([...new Set(imports)], ['obsidian']);
    assert.equal(saves(), 0);
  }
  const { plugin, imports, requests, saves } = await openPlugin({
    settings: { serverType: 'jar', plantumlJarPath: 'C:\\Java Tools\\plantuml.jar' },
  });
  await assert.rejects(plugin.requestDiagram(source, 'svg', 'plantuml'), /desktop Obsidian/);
  await assert.rejects(plugin.requestDiagram(source, 'svg', 'mermaid'), /desktop Obsidian/);
  assert.deepEqual([...new Set(imports)], ['obsidian']);
  assert.deepEqual(requests, []);
  assert.equal(plugin.settings.serverType, 'jar');
  assert.equal(saves(), 0);
});

test('JAR requests keep PNG bytes, UTF-8 stdin and the source folder', { timeout: 5000 }, async (t) => {
  const { plugin, java, directory, jar } = await withFakeJava(t);
  const folder = 'Диаграммы проекта';
  await fs.mkdir(join(directory, folder));
  const result = plugin.requestDiagram(source, 'png', 'plantuml', { sourcePath: `${folder}/note.md` });
  const launch = await java.launch(0);
  assert.equal(launch.options.cwd, join(directory, folder));
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.args[launch.args.indexOf('-jar') + 1], jar);
  assert.ok(launch.args.indexOf('-DPLANTUML_LIMIT_SIZE=16384') < launch.args.indexOf('-jar'));
  assert.ok(launch.args.includes('-DPLANTUML_LIMIT_SIZE=16384'));
  assert.equal(launch.input, source);
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 255]);
  launch.finish(0, Buffer.concat([bytes, Buffer.from(`${launch.marker}\r\n`)]), 'Warning: font substitute\n');
  assert.deepEqual(Buffer.from((await result).arrayBuffer), bytes);
  await assert.rejects(plugin.requestDiagram(source, 'svg', 'mermaid'), /HTTP render mode for Mermaid/);
});

test('JAR failures surface diagnostics and reject invalid settings and output', { timeout: 5000 }, async (t) => {
  const { plugin, java, directory, jar } = await withFakeJava(t);
  plugin.settings.plantumlLimitSize = 1.5;
  await assert.rejects(plugin.requestDiagram(source, 'svg'), /whole number/);
  plugin.settings.plantumlLimitSize = 8192;
  plugin.settings.plantumlJarPath = `${jar}.missing`;
  await assert.rejects(plugin.requestDiagram(source, 'svg'), /Cannot read the PlantUML JAR/);
  plugin.settings.plantumlJarPath = directory;
  await assert.rejects(plugin.requestDiagram(source, 'svg'), /Cannot read the PlantUML JAR/);
  plugin.settings.plantumlJarPath = jar;
  await assert.rejects(
    plugin.requestDiagram(source, 'svg', 'plantuml', { sourcePath: 'missing/note.md' }),
    /Cannot open the diagram folder/,
  );
  plugin.settings.javaExecutable = 'puml-viewer-java-missing';
  await assert.rejects(plugin.requestDiagram(source, 'svg'), /not found in PATH/);
  plugin.settings.javaExecutable = execPath;
  assert.equal(java.launches.length, 0);

  const failed = plugin.requestDiagram(source, 'svg');
  const broken = await java.launch(0);
  assert.ok(broken.args.includes('-DPLANTUML_LIMIT_SIZE=8192'));
  broken.child.stdin.emit('error', new Error('EPIPE'));
  broken.finish(200, `<svg></svg>${broken.marker}\n`, 'Error line 2 in standard input');
  await assert.rejects(failed, /exit code 200[\s\S]*Error line 2/);

  const empty = plugin.requestDiagram(source, 'svg');
  (await java.launch(1)).finish();
  await assert.rejects(empty, /returned no diagram/);

  const multi = plugin.requestDiagram(source, 'svg');
  const multiple = await java.launch(2);
  multiple.finish(0, `<svg />${multiple.marker}\n<svg />${multiple.marker}\n`);
  await assert.rejects(multi, /one diagram per/);

  const large = plugin.requestDiagram(source, 'png');
  const bulky = await java.launch(3);
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  for (let count = 0; count < 9; count++) bulky.child.stdout.emit('data', chunk);
  await assert.rejects(large, /exceeded 64 MiB/);
  assert.equal(java.kills.length, 1);
});

test('a legacy JAR can report Graphviz failures even with exit code zero', { timeout: 5000 }, async (t) => {
  const { plugin, java } = await withFakeJava(t);
  const diagram = '@startuml\nclass A\nclass B\nA -- B\n@enduml';

  const svg = plugin.requestDiagram(diagram, 'svg');
  const image = await java.launch(0);
  image.finish(0, `<svg><text>Cannot find Graphviz</text></svg>${image.marker}\n`, [
    'java.io.IOException: Cannot run program "dot": No such file or directory',
    '\tat java.lang.ProcessBuilder.start(Unknown Source)',
    '\tat net.sourceforge.plantuml.dot.GraphvizVersionFinder.dotVersion(GraphvizVersionFinder.java:120)',
  ].join('\n'));
  await assert.rejects(svg, /Could not start Graphviz[\s\S]*Cannot run program/);

  const txt = plugin.requestDiagram(diagram, 'txt');
  const ascii = await java.launch(1);
  ascii.finish(0, [
    'java.lang.IllegalStateException',
    '\tat net.sourceforge.plantuml.dot.AbstractGraphviz.createFile3(AbstractGraphviz.java:103)',
    `${ascii.marker}\n`,
  ].join('\n'));
  await assert.rejects(txt, /Graphviz could not render/);

  const crashedSvg = plugin.requestDiagram(diagram, 'svg');
  const crashImage = await java.launch(2);
  crashImage.finish(0, `<svg><text>For some reason, dot/GraphViz has crashed.</text><text>RootCause net.sourceforge.plantuml.svek.EmptySvgException</text></svg>${crashImage.marker}\n`);
  await assert.rejects(crashedSvg, /Graphviz crashed while rendering/);

  const crashedTxt = plugin.requestDiagram(diagram, 'txt');
  const crashText = await java.launch(3);
  crashText.finish(0, [
    'java.lang.IllegalStateException: Timeout2 EXCEPTION java.io.IOException: Stream closed',
    '\tat net.sourceforge.plantuml.posimo.GraphvizSolverB.solve(GraphvizSolverB.java:110)',
    `${crashText.marker}\n`,
  ].join('\n'));
  await assert.rejects(crashedTxt, /Graphviz could not render[\s\S]*Stream closed/);

  const quotedMessage = plugin.requestDiagram(diagram, 'svg');
  const validImage = await java.launch(4);
  const svgLabel = '<svg><text>For some reason, dot/GraphViz has crashed.</text></svg>';
  validImage.finish(0, `${svgLabel}${validImage.marker}\n`);
  assert.equal((await quotedMessage).text, svgLabel);
});

test('cancelled and expired jobs release their process and queued work never starts on unload', { timeout: 5000 }, async (t) => {
  let now = 0;
  const deadlines = new Map();
  const { plugin, java } = await withFakeJava(t, {
    timers: {
      setTimeout(callback, delay) { deadlines.set(callback, now + delay); return callback; },
      clearTimeout(callback) { deadlines.delete(callback); },
    },
  });
  const obsolete = new AbortController();
  const first = plugin.requestDiagram('old diagram', 'svg', 'plantuml', { signal: obsolete.signal });
  await java.launch(0);
  const second = plugin.requestDiagram('new diagram', 'svg');
  assert.equal(java.launches.length, 1);
  const deadlinesWhileWaiting = [...deadlines.values()];
  now = 50_000;
  obsolete.abort();
  await assert.rejects(first, { name: 'AbortError' });
  const newest = await java.launch(1);
  assert.equal(newest.input, 'new diagram');
  const deadlinesAfterStart = [...deadlines.values()];
  newest.finish(0, `<svg>new</svg>${newest.marker}\n`);
  assert.equal((await second).text, '<svg>new</svg>');
  assert.deepEqual(deadlinesWhileWaiting, [60_000]);
  assert.deepEqual(deadlinesAfterStart, [110_000]);

  const slow = plugin.requestDiagram(source, 'txt');
  await java.launch(2);
  [...deadlines.keys()][0]();
  await assert.rejects(slow, /within 60 seconds/);

  const active = plugin.requestDiagram(source, 'txt');
  await java.launch(3);
  const pending = plugin.requestDiagram(source, 'svg');
  const cancelled = Promise.all([assert.rejects(active, { name: 'AbortError' }), assert.rejects(pending, { name: 'AbortError' })]);
  plugin.onunload();
  await cancelled;
  await nextTurn();
  assert.equal(java.launches.length, 4);
  assert.equal(java.kills.length, 3);
  assert.equal(deadlines.size, 0);
});

test('the file view discards a JAR render that finishes after an edit', async (t) => {
  class Element {
    children = [];
    empty() { this.children.length = 0; }
    addClass() {}
    removeClass() {}
    toggleClass() {}
    setAttr() {}
    addEventListener() {}
    appendChild(child) { this.children.push(child); }
    querySelector() { return null; }
    createEl(_, options) { return this.createDiv(options); }
    createDiv(options) {
      const child = new Element();
      child.text = options?.text;
      child.remove = () => {
        const index = this.children.indexOf(child);
        if (index !== -1) this.children.splice(index, 1);
      };
      this.children.push(child);
      return child;
    }
    setText(text) { this.text = text; }
  }

  for (const [name, serverType, autoRefresh, modeAfterRead] of [
    ['Auto refresh on', 'jar', true, 'jar'],
    ['Auto refresh off', 'jar', false, 'jar'],
    ['Switch to JAR while reading', 'local', false, 'jar'],
    ['HTTP with auto refresh off', 'local', false, 'local'],
  ]) {
    await t.test(name, async () => {
      const { plugin } = await openPlugin({ desktop: true, settings: { serverType, autoRefresh } });
      const view = plugin.createView({ getViewState: () => ({}) });
      view.app = plugin.app;
      view.containerEl = { children: [new Element(), new Element()] };
      view.registerEvent = () => {};
      view.registerDomEvent = () => {};
      view.app.workspace.getActiveFile = () => null;
      let onModify;
      view.app.vault.on = (event, callback) => {
        assert.equal(event, 'modify');
        onModify = callback;
      };
      await view.onOpen();
      view.currentFile = { path: 'folder/sequence.puml', name: 'sequence.puml', extension: 'puml' };
      let fileContents = source;
      let reads = 0;
      view.app.vault.read = async () => {
        reads++;
        if (plugin.settings.serverType !== modeAfterRead) await plugin.setRenderMode(modeAfterRead);
        return fileContents;
      };
      let completeRequest;
      let previousSignal;
      plugin.fetchSvgElement = (_source, _type, context) => {
        previousSignal = context.signal;
        return new Promise((resolve) => { completeRequest = resolve; });
      };

      const oldRender = view.renderDiagram();
      await nextTurn();
      assert.ok(completeRequest);
      fileContents = '';
      await onModify(view.currentFile);
      const cancelled = modeAfterRead === 'jar';
      const statusAfterEdit = autoRefresh ? 'File is empty.' : cancelled
        ? 'File changed. Use the refresh button to render again.'
        : 'Rendering: sequence.puml';
      assert.equal(view.statusEl.text, statusAfterEdit);
      assert.equal(reads, autoRefresh ? 2 : 1);
      assert.equal(previousSignal.aborted, cancelled);
      completeRequest(new Element());
      await oldRender;
      assert.equal(view.statusEl.text, cancelled ? statusAfterEdit : 'Rendered: sequence.puml');
      assert.equal(view.contentHostEl.children.flatMap((child) => child.children).length, cancelled ? 0 : 1);
    });
  }
});

test('a real JAR generates SVG, PNG and ASCII with an include relative to the source', {
  timeout: 30000, skip: !env.PUML_TEST_JAVA || !env.PUML_TEST_JAR,
}, async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'puml-viewer-integration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const noteDir = 'Папка заметки';
  await fs.mkdir(join(root, noteDir));
  await fs.writeFile(join(root, noteDir, 'часть схемы.puml'), 'participant "Включение" as Alice\n');
  const jar = join(root, platform === 'win32' ? 'PlantUML тест.jar' : 'PlantUML тест.jar ');
  await fs.copyFile(env.PUML_TEST_JAR, jar);
  let java = env.PUML_TEST_JAVA;
  if (platform !== 'win32') {
    java = join(root, 'Java тест ');
    await fs.symlink(env.PUML_TEST_JAVA, java);
  }
  const { plugin } = await openPlugin({
    desktop: true, vaultPath: root,
    settings: { serverType: 'jar', javaExecutable: java, plantumlJarPath: jar, plantumlLimitSize: 16384 },
  });
  t.after(() => plugin.onunload());
  const diagram = source.replace('@startuml', '@startuml\n!include часть схемы.puml');
  const context = { sourcePath: `${noteDir}/sequence.puml` };
  const svg = await plugin.requestDiagram(diagram, 'svg', 'plantuml', context);
  const svgText = svg.text.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
  assert.match(svgText, /Включение/);
  assert.match(svgText, /Привет/);
  const png = Buffer.from((await plugin.requestDiagram(diagram, 'png', 'plantuml', context)).arrayBuffer);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.subarray(-8, -4).toString(), 'IEND');
  const txt = await plugin.requestDiagram(diagram, 'txt', 'plantuml', context);
  assert.match(txt.text, /-+>/);
  assert.match(txt.text, /Привет/);
  await assert.rejects(plugin.requestDiagram(source.replace('@enduml', 'invalid line\n@enduml'), 'svg'), /Syntax Error/);
});
