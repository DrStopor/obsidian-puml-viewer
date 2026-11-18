/* global require */

export type DiagramFormat = 'svg' | 'png' | 'txt';
type NodeBuffer = import('node:buffer').Buffer;

export const DEFAULT_PLANTUML_LIMIT_SIZE = 4096;
export const MAX_PLANTUML_LIMIT_SIZE = 2_147_483_647;
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

const FORMATS = {
  svg: { flag: '-tsvg', contentType: 'image/svg+xml' },
  png: { flag: '-tpng', contentType: 'image/png' },
  txt: { flag: '-ttxt', contentType: 'text/plain' },
};

interface JarOptions {
  javaExecutable: string;
  jarPath: string;
  limitSize: number;
  vaultPath: string;
  sourcePath?: string;
  isWindows: boolean;
}

interface JarResult {
  contentType: string;
  text: string;
  arrayBuffer?: ArrayBuffer;
}

interface RenderJob {
  run(): Promise<void>;
  cancel(error: Error): void;
}

export class PlantUmlJarError extends Error {}

export function isPlantUmlLimitSize(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_PLANTUML_LIMIT_SIZE;
}

export function checkRenderSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Diagram generation cancelled.', 'AbortError');
}

export class PlantUmlJarRenderer {
  private readonly queue: RenderJob[] = [];
  private active: RenderJob | undefined;
  private disposed = false;

  async render(source: string, format: DiagramFormat, options: JarOptions, signal?: AbortSignal): Promise<JarResult> {
    checkRenderSignal(signal);
    if (this.disposed) throw new DOMException('Diagram generation cancelled.', 'AbortError');

    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) globalThis.clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        finish();
      };
      const job: RenderJob = {
        run: async () => {
          try {
            timeout = globalThis.setTimeout(() => {
              job.cancel(new PlantUmlJarError('PlantUML did not finish within 60 seconds.'));
            }, TIMEOUT_MS);
            const result = await renderWithJar(source, format, options, controller.signal);
            settle(() => resolve(result));
          } catch (error) {
            settle(() => reject(error instanceof Error ? error : new PlantUmlJarError(String(error))));
          }
        },
        cancel: (error) => settle(() => {
          const index = this.queue.indexOf(job);
          if (index !== -1) this.queue.splice(index, 1);
          controller.abort();
          reject(error);
        }),
      };
      const onAbort = () => job.cancel(new DOMException('Diagram generation cancelled.', 'AbortError'));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(job);
      this.startNext();
    });
  }

  cancelAll(): void {
    const error = new DOMException('Diagram generation cancelled.', 'AbortError');
    for (const job of this.queue.splice(0)) job.cancel(error);
    this.active?.cancel(error);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelAll();
  }

  private startNext(): void {
    if (this.active || this.disposed) return;
    const job = this.queue.shift();
    if (!job) return;

    this.active = job;
    // Wait for Java and its streams to close, even after cancellation.
    void job.run().finally(() => {
      this.active = undefined;
      this.startNext();
    });
  }
}

async function renderWithJar(
  source: string,
  format: DiagramFormat,
  options: JarOptions,
  signal: AbortSignal,
): Promise<JarResult> {
  if (!isPlantUmlLimitSize(options.limitSize)) {
    throw new PlantUmlJarError(`PLANTUML_LIMIT_SIZE must be a whole number from 1 to ${MAX_PLANTUML_LIMIT_SIZE}.`);
  }

  // These modules are loaded only from the desktop JAR branch in requestDiagram.
  /* eslint-disable @typescript-eslint/no-require-imports, import/no-nodejs-modules */
  const { spawn, execFile } = require('node:child_process') as typeof import('node:child_process');
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const process = require('node:process') as typeof import('node:process');
  const { Buffer } = require('node:buffer') as typeof import('node:buffer');
  const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
  /* eslint-enable @typescript-eslint/no-require-imports, import/no-nodejs-modules */

  const isFullPath = (value: string): boolean => {
    const root = path.parse(value).root;
    return path.isAbsolute(value) && (!options.isWindows || root.length > 1);
  };
  const cwd = path.resolve(options.vaultPath, path.dirname(options.sourcePath || '.'));
  const jarPath = typeof options.jarPath === 'string' ? options.jarPath : '';
  if (!isFullPath(jarPath)) {
    throw new PlantUmlJarError('Set JAR path to the full path of the PlantUML JAR.');
  }
  const jarErrorMessage = `Cannot read the PlantUML JAR at "${jarPath}".`;
  const jarStat = await fs.promises.stat(jarPath).catch(() => null);
  if (!jarStat?.isFile()) throw new PlantUmlJarError(jarErrorMessage);
  try {
    await fs.promises.access(jarPath, fs.constants.R_OK);
  } catch {
    throw new PlantUmlJarError(jarErrorMessage);
  }
  const cwdStat = await fs.promises.stat(cwd).catch(() => null);
  if (!cwdStat?.isDirectory()) {
    throw new PlantUmlJarError(`Cannot open the diagram folder "${cwd}".`);
  }

  const java = typeof options.javaExecutable === 'string' ? options.javaExecutable || 'java' : 'java';
  let executable = java;
  if (options.isWindows && /\.(bat|cmd)$/i.test(java)) {
    throw new PlantUmlJarError('Set Java executable to a Java .exe file.');
  }
  if (!isFullPath(java)) {
    if (path.basename(java) !== java || path.parse(java).root) {
      throw new PlantUmlJarError('Enter a Java executable name from PATH or a full path.');
    }
    const names = options.isWindows && !path.extname(java) ? [`${java}.exe`, `${java}.com`] : [java];
    // Resolve relative PATH entries before setting the child cwd.
    executable = '';
    for (const entry of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      const directory = options.isWindows ? entry.replace(/^"(.*)"$/, '$1') : entry;
      for (const name of names) {
        checkRenderSignal(signal);
        const candidate = path.resolve(directory, name);
        try {
          if (!(await fs.promises.stat(candidate)).isFile()) continue;
          await fs.promises.access(candidate, fs.constants.X_OK);
          executable = candidate;
          break;
        } catch {
          // The next PATH entry may contain Java.
        }
      }
      if (executable) break;
    }
    if (!executable) throw new PlantUmlJarError(`Java executable "${java}" was not found in PATH. Set Java executable to its full path.`);
  }

  checkRenderSignal(signal);
  // PlantUML's -pipedelimitor marks the end of each diagram.
  const marker = `PUML_VIEWER_END_${randomUUID()}`;
  const args = [
    '-Djava.awt.headless=true', '-Dfile.encoding=UTF-8', `-DPLANTUML_LIMIT_SIZE=${options.limitSize}`,
    '-jar', jarPath, '-pipe', '-charset', 'UTF-8', '-stdrpt:1', '-pipedelimitor', marker, FORMATS[format].flag,
  ];

  const output = await new Promise<NodeBuffer>((resolve, reject) => {
    const startError = (error: Error) => new PlantUmlJarError(`Could not start Java "${executable}": ${error.message}`);
    let child: import('node:child_process').ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, args, { cwd, shell: false, windowsHide: true, detached: !options.isWindows, stdio: 'pipe' });
    } catch (error) {
      reject(startError(error instanceof Error ? error : new Error(String(error))));
      return;
    }

    const chunks: NodeBuffer[] = [];
    let diagnostic = Buffer.alloc(0);
    let received = 0;
    let stopping = false;
    let outputError: PlantUmlJarError | undefined;
    let launchError: PlantUmlJarError | undefined;
    let inputError: PlantUmlJarError | undefined;

    const stop = () => {
      if (stopping) return;
      stopping = true;
      child.stdin.destroy();
      const pid = child.pid;
      if (!pid) return;

      const killJava = () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      };
      // Stop Graphviz along with Java when possible.
      if (!options.isWindows) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          killJava();
        }
        return;
      }

      const systemRoot = process.env.SystemRoot;
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (!systemRoot || !isFullPath(systemRoot)) {
        killJava();
        return;
      }
      execFile(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true, timeout: 2_000, maxBuffer: 64 * 1024,
      }, (error) => {
        if (error) killJava();
      });
    };

    const receive = (chunk: NodeBuffer): boolean => {
      if (stopping) return false;
      received += chunk.length;
      if (received <= MAX_OUTPUT_BYTES) return true;
      outputError = new PlantUmlJarError('PlantUML output exceeded 64 MiB.');
      stop();
      return false;
    };

    child.stdout.on('data', (chunk: NodeBuffer) => {
      if (receive(chunk)) chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: NodeBuffer) => {
      if (!receive(chunk)) return;
      diagnostic = Buffer.concat([
        diagnostic.subarray(Math.max(0, diagnostic.length + chunk.length - MAX_DIAGNOSTIC_BYTES)),
        chunk.subarray(Math.max(0, chunk.length - MAX_DIAGNOSTIC_BYTES)),
      ]);
    });
    const onOutputError = (error: Error) => {
      outputError ??= new PlantUmlJarError(`Could not read PlantUML output: ${error.message}`);
      stop();
    };
    child.stdout.on('error', onOutputError);
    child.stderr.on('error', onOutputError);
    child.stdin.on('error', (error: Error) => {
      inputError = new PlantUmlJarError(`Could not send the diagram to Java: ${error.message}`);
    });
    child.on('error', (error) => { launchError = startError(error); });
    signal.addEventListener('abort', stop, { once: true });
    child.once('close', (code, killedBy) => {
      signal.removeEventListener('abort', stop);
      const stderr = diagnostic.toString('utf8').trim();
      const reportedError = /^protocolVersion=1\r?\nstatus=ERROR\r?$/m.test(stderr);
      // Older PlantUML versions can return an error image with exit code 0.
      const graphvizStartError = /^java\.io\.IOException: (Cannot run program [^\r\n]+)\r?\n(?:[ \t]+at [^\r\n]+\r?\n)*[ \t]+at net\.sourceforge\.plantuml\.dot\.GraphvizVersionFinder\.dotVersion\(/m.exec(stderr);
      const graphvizOutputError = /^net\.sourceforge\.plantuml\.dot\.UnparsableGraphvizException: ([^\r\n]+)/m.exec(stderr);
      const processError = outputError ?? launchError;
      if (signal.aborted) reject(new DOMException('Diagram generation cancelled.', 'AbortError'));
      else if (processError) reject(processError);
      else if (graphvizStartError) {
        reject(new PlantUmlJarError(`Could not start Graphviz.\n${graphvizStartError[1].slice(0, 2048)}`));
      } else if (graphvizOutputError) {
        reject(new PlantUmlJarError(`Graphviz returned an invalid result.\n${graphvizOutputError[1].slice(0, 2048)}`));
      } else if (code !== 0 || reportedError) {
        const reason = code === null
          ? `was terminated (${killedBy ?? 'unknown signal'})`
          : code === 0 ? 'reported an error' : `failed (exit code ${code})`;
        const detail = stderr || inputError?.message;
        reject(new PlantUmlJarError(`PlantUML ${reason}.${detail ? `\n${detail.slice(-2048)}` : ''}`));
      } else if (inputError) reject(inputError);
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(source, 'utf8');
  });

  const end = output.indexOf(marker);
  if (end > -1 && output.indexOf(marker, end + marker.length) > -1) {
    throw new PlantUmlJarError('PlantUML JAR rendering expects one diagram per block or file.');
  }
  if (output.length === 0 || end === 0) throw new PlantUmlJarError('PlantUML returned no diagram.');
  const newline = end + marker.length;
  const lineEnd = output.length - newline;
  if (end === -1 || output[output.length - 1] !== 10 || (lineEnd !== 1 && !(lineEnd === 2 && output[newline] === 13))) {
    throw new PlantUmlJarError('PlantUML returned an incomplete diagram. Check the JAR version.');
  }

  const bytes = output.subarray(0, end);
  let text = '';
  if (format === 'png') {
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new PlantUmlJarError('PlantUML did not return a PNG image.');
    }
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new PlantUmlJarError(`PlantUML did not return UTF-8 ${format.toUpperCase()} output.`);
    }
    const isSvg = /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text);
    if (format === 'svg') {
      if (text.includes('>For some reason, dot/GraphViz has crashed.</text>') &&
          text.includes('>RootCause net.sourceforge.plantuml.')) {
        throw new PlantUmlJarError('Graphviz crashed while rendering this diagram. Check your Graphviz installation.');
      }
      if (!isSvg) throw new PlantUmlJarError('PlantUML did not return an SVG image.');
    } else {
      const graphvizError = /^java\.lang\.IllegalStateException(?:: ([^\r\n]*))?\r?\n[ \t]+at net\.sourceforge\.plantuml\.(?:dot\.AbstractGraphviz|posimo\.GraphvizSolverB)\./.exec(text);
      if (graphvizError) {
        const detail = graphvizError[1]?.slice(0, 2048);
        throw new PlantUmlJarError(`Graphviz could not render this diagram. Check your Graphviz installation.${detail ? `\n${detail}` : ''}`);
      }
      if (!text.trim() || isSvg || text.includes('\0')) {
        throw new PlantUmlJarError('PlantUML did not return ASCII art for this diagram.');
      }
    }
  }

  return {
    contentType: FORMATS[format].contentType,
    text,
    arrayBuffer: format === 'png' ? Uint8Array.from(bytes).buffer : undefined,
  };
}
