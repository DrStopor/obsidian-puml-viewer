import {
  App,
  FileSystemAdapter,
  ItemView,
  type MarkdownPostProcessorContext,
  MarkdownRenderChild,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  normalizePath,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  ViewStateResult,
  WorkspaceLeaf,
  requestUrl,
} from 'obsidian';
import { encode } from 'plantuml-encoder';
import {
  checkRenderSignal,
  DEFAULT_PLANTUML_LIMIT_SIZE,
  type DiagramFormat,
  PlantUmlJarError,
  PlantUmlJarRenderer,
} from './plantuml-jar';
import { addJarSettings, type JarSettings } from './jar-settings';

const VIEW_TYPE_PUML = 'puml-viewer';
const encodePlantuml = encode;
const CSS_AUTO = 'auto';
const CSS_NONE = 'none';
const SUPPORTED_PLANTUML_EXTENSIONS = ['puml'] as const;
const SUPPORTED_MERMAID_EXTENSIONS = ['mermaid', 'mmd', 'marmaid'] as const;
const SUPPORTED_DIAGRAM_EXTENSIONS = [
  ...SUPPORTED_PLANTUML_EXTENSIONS,
  ...SUPPORTED_MERMAID_EXTENSIONS,
] as const;

type ViewMode = 'view' | 'edit';
type DiagramType = 'plantuml' | 'mermaid';
type ExportConflictAction = 'overwrite' | 'new-file' | 'cancel';
type RenderMode = 'plantuml' | 'kroki' | 'local' | 'jar';

interface RenderContext {
  sourcePath?: string;
  signal?: AbortSignal;
}

interface PUMLViewerSettings extends JarSettings {
  serverType: RenderMode;
  plantumlServerUrl: string;
  krokiServerUrl: string;
  krokiDiagramType: DiagramType;
  localServerUrl: string;
  imageFormat: 'svg' | 'png';
  autoRefresh: boolean;
  lastOpenedPumlPath: string;
  embeddedDefaultView: 'diagram' | 'code';
  embeddedDiagramAlign: 'left' | 'center' | 'right';
}

const DEFAULT_SETTINGS: PUMLViewerSettings = {
  serverType: 'plantuml',
  plantumlServerUrl: 'https://www.plantuml.com/plantuml',
  krokiServerUrl: 'https://kroki.io',
  krokiDiagramType: 'plantuml',
  localServerUrl: 'http://localhost:8000',
  javaExecutable: 'java',
  plantumlJarPath: '',
  plantumlLimitSize: DEFAULT_PLANTUML_LIMIT_SIZE,
  imageFormat: 'svg',
  autoRefresh: true,
  lastOpenedPumlPath: '',
  embeddedDefaultView: 'diagram',
  embeddedDiagramAlign: 'center',
};

interface PUMLViewState extends Record<string, unknown> {
  file?: string;
  mode?: ViewMode;
}

function getDiagramTypeByExtension(extension: string): DiagramType | null {
  const normalized = extension.toLowerCase();
  if ((SUPPORTED_PLANTUML_EXTENSIONS as readonly string[]).includes(normalized)) return 'plantuml';
  if ((SUPPORTED_MERMAID_EXTENSIONS as readonly string[]).includes(normalized)) return 'mermaid';
  return null;
}

function parseSvgLength(value: string | null): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stripWidthHeightFromInlineStyle(styleValue: string): string {
  const chunks = styleValue
    .split(';')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);

  const kept = chunks.filter((chunk) => {
    const colonIdx = chunk.indexOf(':');
    if (colonIdx <= 0) return true;
    const key = chunk.slice(0, colonIdx).trim().toLowerCase();
    return key !== 'width' && key !== 'height';
  });

  return kept.join('; ');
}

function normalizeSvgForResponsiveLayout(svgEl: SVGSVGElement): void {
  const viewBox = svgEl.getAttribute('viewBox')?.trim() ?? '';
  if (!viewBox) {
    const width = parseSvgLength(svgEl.getAttribute('width'));
    const height = parseSvgLength(svgEl.getAttribute('height'));
    if (width > 0 && height > 0) {
      svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
    }
  }

  // PlantUML often emits preserveAspectRatio="none", which stretches the diagram.
  svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Fixed root dimensions can force stretching when CSS constrains only width.
  svgEl.removeAttribute('width');
  svgEl.removeAttribute('height');

  const styleAttr = svgEl.getAttribute('style');
  if (styleAttr) {
    const sanitizedStyle = stripWidthHeightFromInlineStyle(styleAttr);
    if (sanitizedStyle.length > 0) {
      svgEl.setAttribute('style', sanitizedStyle);
    } else {
      svgEl.removeAttribute('style');
    }
  }
}

function parseSvgMarkup(svgMarkup: string): SVGSVGElement | null {
  const parsed = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) return null;
  const svgEl = parsed.querySelector('svg');
  if (!svgEl || svgEl.tagName.toLowerCase() !== 'svg') return null;

  // In Obsidian/Electron, cross-realm `instanceof SVGSVGElement` checks can fail.
  // Validate by tag name and return the imported node as an SVG root element.
  const imported = window.activeDocument.importNode(svgEl, true) as Element;
  if (imported.tagName.toLowerCase() !== 'svg') return null;
  const normalized = imported as SVGSVGElement;
  normalizeSvgForResponsiveLayout(normalized);
  return normalized;
}

function isRenderCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function setDiagramImageUrl(img: HTMLImageElement, objectUrl: string, signal: AbortSignal): void {
  const release = () => {
    URL.revokeObjectURL(objectUrl);
    signal.removeEventListener('abort', release);
    img.removeEventListener('load', release);
    img.removeEventListener('error', release);
  };
  if (signal.aborted) {
    release();
    checkRenderSignal(signal);
  }
  signal.addEventListener('abort', release, { once: true });
  img.addEventListener('load', release, { once: true });
  img.addEventListener('error', release, { once: true });
  img.src = objectUrl;
}

export default class PUMLViewerPlugin extends Plugin {
  settings!: PUMLViewerSettings;
  private jarRenderer?: PlantUmlJarRenderer;
  private readonly renderLifetime = new AbortController();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_PUML, (leaf) => new PUMLViewerView(leaf, this));
    this.registerExtensions([...SUPPORTED_DIAGRAM_EXTENSIONS], VIEW_TYPE_PUML);

    this.addCommand({
      id: 'open-current-puml-in-viewer',
      name: 'Open current diagram file in viewer',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        const canOpen = !!file && getDiagramTypeByExtension(file.extension) !== null;

        if (canOpen && !checking && file) {
          void this.activatePUMLView(file);
        }

        return canOpen;
      },
    });

    this.app.workspace.onLayoutReady(() => {
      const activeFile = this.app.workspace.getActiveFile();
      if (!activeFile || getDiagramTypeByExtension(activeFile.extension) === null) return;

      const activeLeaf = this.app.workspace.getMostRecentLeaf();
      if (activeLeaf?.view.getViewType() === VIEW_TYPE_PUML) return;

      void this.activatePUMLView(activeFile);
    });

    for (const lang of ['plantuml', 'mermaid'] as const) {
      this.registerMarkdownCodeBlockProcessor(lang, async (source, el, ctx) => {
        const fenceWidthHintPx = this.extractFenceWidthHint(
          ctx.getSectionInfo(el)?.text ?? '',
          source,
          lang,
        );
        await this.renderEmbeddedDiagramBlock(source, el, fenceWidthHintPx, lang, ctx);
      });
    }

    this.addSettingTab(new PUMLViewerSettingTab(this.app, this));
  }

  onunload(): void {
    this.renderLifetime.abort();
    this.jarRenderer?.dispose();
    this.app.workspace.getLeavesOfType(VIEW_TYPE_PUML).forEach((leaf) => leaf.detach());
  }

  async loadSettings(): Promise<void> {
    const loaded = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as PUMLViewerSettings & {
      serverUrl?: string;
    };
    if (loaded.serverUrl) {
      if (loaded.serverType === 'kroki') {
        loaded.krokiServerUrl = loaded.serverUrl;
      } else if (loaded.serverType === 'local') {
        loaded.localServerUrl = loaded.serverUrl;
      } else if (loaded.serverType !== 'jar') {
        loaded.plantumlServerUrl = loaded.serverUrl;
      }
    }
    this.settings = loaded;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async setRenderMode(mode: RenderMode): Promise<void> {
    if (mode !== this.settings.serverType) this.jarRenderer?.cancelAll();
    this.settings.serverType = mode;
    await this.saveSettings();
  }

  rerenderMarkdownPreviews(): void {
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof MarkdownView) {
        view.previewMode.rerender(true);
      }
    }
  }

  async rememberLastPuml(path: string): Promise<void> {
    if (!path || this.settings.lastOpenedPumlPath === path) return;
    this.settings.lastOpenedPumlPath = path;
    await this.saveSettings();
  }

  async activatePUMLView(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf(true);
    await leaf.setViewState({
      type: VIEW_TYPE_PUML,
      active: true,
      state: { file: file.path },
    });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  buildRenderUrl(source: string, diagramType?: DiagramType): string {
    if (this.settings.serverType === 'jar') {
      throw new PlantUmlJarError('PlantUML JAR rendering does not use a server URL.');
    }
    const useKroki = this.settings.serverType === 'kroki' || diagramType === 'mermaid';
    const normalizedBase = useKroki
      ? this.settings.krokiServerUrl.replace(/\/+$/, '').replace(/\/plantuml$/i, '')
      : this.getActiveServerUrl().replace(/\/+$/, '');
    const encoded = encodePlantuml(source);
    const format = this.settings.imageFormat;

    if (useKroki) {
      const resolvedDiagramType = diagramType ?? this.settings.krokiDiagramType;
      return `${normalizedBase}/${resolvedDiagramType}/${format}/${encoded}`;
    }

    return `${normalizedBase}/${format}/${encoded}`;
  }

  private normalizedServerBase(): string {
    let base = this.getActiveServerUrl().replace(/\/+$/, '');
    if (this.settings.serverType === 'kroki') {
      base = base.replace(/\/plantuml$/i, '');
    }
    return base;
  }

  private getActiveServerUrl(): string {
    if (this.settings.serverType === 'kroki') {
      return this.settings.krokiServerUrl;
    }
    if (this.settings.serverType === 'local') {
      return this.settings.localServerUrl;
    }
    return this.settings.plantumlServerUrl;
  }

  responseContentType(response: { headers?: Record<string, string> }): string {
    const headers = response.headers ?? {};
    return headers['content-type'] ?? headers['Content-Type'] ?? '';
  }

  async requestDiagram(source: string, format: DiagramFormat, diagramType?: DiagramType, context?: RenderContext) {
    checkRenderSignal(this.renderLifetime.signal);
    checkRenderSignal(context?.signal);
    if (this.settings.serverType === 'jar') {
      if (!Platform.isDesktopApp) {
        throw new PlantUmlJarError('PlantUML JAR is available in desktop Obsidian. Choose an HTTP render mode on mobile.');
      }
      if (diagramType === 'mermaid') {
        throw new PlantUmlJarError('PlantUML JAR renders PlantUML diagrams. Choose an HTTP render mode for Mermaid.');
      }
      const adapter = this.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter)) {
        throw new PlantUmlJarError('PlantUML JAR requires a local vault folder.');
      }
      this.jarRenderer ??= new PlantUmlJarRenderer();
      const result = await this.jarRenderer.render(source, format, {
        javaExecutable: this.settings.javaExecutable,
        jarPath: this.settings.plantumlJarPath,
        limitSize: this.settings.plantumlLimitSize,
        vaultPath: adapter.getBasePath(),
        sourcePath: context?.sourcePath,
        isWindows: Platform.isWin,
      }, context?.signal);
      return {
        status: 200,
        headers: { 'content-type': result.contentType },
        text: result.text,
        arrayBuffer: result.arrayBuffer,
      };
    }

    const useKroki = this.settings.serverType === 'kroki' || diagramType === 'mermaid';
    if (useKroki) {
      const normalizedBase = this.settings.krokiServerUrl
        .replace(/\/+$/, '')
        .replace(/\/plantuml$/i, '');
      const resolvedDiagramType = diagramType ?? this.settings.krokiDiagramType;
      const accept =
        format === 'svg' ? 'image/svg+xml' : format === 'png' ? 'image/png' : 'text/plain';
      return requestUrl({
        url: `${normalizedBase}/${resolvedDiagramType}/${format}`,
        method: 'POST',
        body: source,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          Accept: accept,
        },
        throw: false,
      });
    }

    const normalizedBase = this.normalizedServerBase();
    const encoded = encodePlantuml(source);
    return requestUrl({
      url: `${normalizedBase}/${format}/${encoded}`,
      method: 'GET',
      throw: false,
    });
  }

  async fetchSvgElement(source: string, diagramType?: DiagramType, context?: RenderContext): Promise<SVGSVGElement> {
    const response = await this.requestDiagram(source, 'svg', diagramType, context);
    checkRenderSignal(context?.signal);
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = this.responseContentType(response);
    if (contentType && !contentType.includes('image/svg')) {
      throw new Error(
        `Expected SVG but got "${contentType}". Check the render mode and server URL (for Kroki use https://kroki.io).`,
      );
    }
    if (!response.text.includes('<svg')) {
      throw new Error('Response is not SVG content.');
    }
    const svg = parseSvgMarkup(response.text);
    if (!svg) throw new Error('Response is not valid SVG content.');
    return svg;
  }

  async fetchPngObjectUrl(source: string, diagramType?: DiagramType, context?: RenderContext): Promise<string> {
    const response = await this.requestDiagram(source, 'png', diagramType, context);
    checkRenderSignal(context?.signal);
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = this.responseContentType(response);
    if (contentType && !contentType.includes('image/png')) {
      throw new Error(
        `Expected PNG but got "${contentType}". Check the render mode and server URL (for Kroki use https://kroki.io).`,
      );
    }
    if (!response.arrayBuffer) {
      throw new Error('No PNG payload returned by render server');
    }

    const blob = new Blob([response.arrayBuffer], { type: 'image/png' });
    return URL.createObjectURL(blob);
  }

  async downloadDiagramAs(
    source: string,
    format: 'svg' | 'png',
    baseName = 'diagram',
    diagramType?: DiagramType,
    context?: RenderContext,
    doc = window.activeDocument,
  ): Promise<void> {
    const response = await this.requestDiagram(source, format, diagramType, context);
    checkRenderSignal(context?.signal);
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }

    let blob: Blob;
    if (format === 'svg') {
      const contentType = this.responseContentType(response);
      if (contentType && !contentType.includes('image/svg')) {
        throw new Error(
          `Expected SVG but got "${contentType}". Check the render mode and server URL (for Kroki use https://kroki.io).`,
        );
      }
      if (!response.text.includes('<svg')) {
        throw new Error('Response is not SVG content.');
      }
      blob = new Blob([response.text], { type: 'image/svg+xml' });
    } else {
      const contentType = this.responseContentType(response);
      if (contentType && !contentType.includes('image/png')) {
        throw new Error(
          `Expected PNG but got "${contentType}". Check the render mode and server URL (for Kroki use https://kroki.io).`,
        );
      }
      if (!response.arrayBuffer) {
        throw new Error('No PNG payload returned by render server');
      }
      blob = new Blob([response.arrayBuffer], { type: 'image/png' });
    }

    const objectUrl = URL.createObjectURL(blob);
    const link = doc.body.createEl('a');
    link.href = objectUrl;
    link.download = `${baseName}.${format}`;
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }

  async downloadDiagram(
    source: string,
    baseName = 'diagram',
    diagramType?: DiagramType,
    context?: RenderContext,
  ): Promise<void> {
    await this.downloadDiagramAs(source, this.settings.imageFormat, baseName, diagramType, context);
  }

  private async renderEmbeddedDiagramBlock(
    source: string,
    el: HTMLElement,
    fenceWidthHintPx: number | null,
    diagramType: DiagramType,
    ctx: MarkdownPostProcessorContext,
  ): Promise<void> {
    if (this.renderLifetime.signal.aborted) return;
    const diagramLabel = diagramType === 'mermaid' ? 'Mermaid' : 'PlantUML';
    const { renderSource, widthHintPx } = this.extractEmbeddedWidthHint(source, fenceWidthHintPx);

    const container = el.createDiv({ cls: 'puml-embed-block' });
    const child = new MarkdownRenderChild(container);
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.renderLifetime.signal.addEventListener('abort', abort, { once: true });
    child.register(() => {
      this.renderLifetime.signal.removeEventListener('abort', abort);
      abort();
    });
    ctx.addChild(child);
    const context = { sourcePath: ctx.sourcePath, signal: controller.signal };
    const actionsEl = container.createDiv({ cls: 'puml-embed-actions' });
    const toggleBtn = actionsEl.createEl('button', { cls: 'puml-embed-toggle' });
    const zoomBtn = actionsEl.createEl('button', { cls: 'puml-embed-zoom-btn', text: 'Zoom' });
    const saveBtn = actionsEl.createEl('button', { cls: 'puml-embed-save-btn', text: 'Save' });
    const copyBtn = actionsEl.createEl('button', { cls: 'puml-embed-copy-btn', text: 'Copy' });
    toggleBtn.setAttr('aria-label', 'Toggle code and diagram');
    zoomBtn.setAttr('aria-label', 'Open zoom overlay');
    saveBtn.setAttr('aria-label', 'Save image');
    copyBtn.setAttr('aria-label', 'Copy code');
    const diagramPane = container.createDiv({ cls: 'puml-embed-diagram' });
    if (widthHintPx) {
      diagramPane.addClass('puml-embed-diagram--constrained');
      diagramPane.style.setProperty('--puml-embed-max-width', `${widthHintPx}px`);
      diagramPane.addClass(`puml-embed-diagram--align-${this.settings.embeddedDiagramAlign}`);
    }
    const codePane = container.createEl('pre', { cls: 'puml-embed-code' });
    const codeEl = codePane.createEl('code', { cls: 'puml-embed-code-content' });
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      const lineEl = codeEl.createSpan({ cls: 'puml-embed-code-line' });
      if (diagramType === 'plantuml') {
        this.renderPlantUmlHighlightedLine(lineEl, line);
      } else {
        lineEl.setText(line);
      }
      if (index < lines.length - 1) {
        lineEl.appendText('\n');
      }
    });
    codePane.hide();

    let showCode = this.settings.embeddedDefaultView === 'code';
    const applyToggleState = () => {
      if (showCode) {
        diagramPane.hide();
        codePane.show();
        toggleBtn.setText('Diagram');
        toggleBtn.setAttr('aria-label', 'Show diagram');
        zoomBtn.addClass('is-hidden');
        saveBtn.addClass('is-hidden');
        copyBtn.removeClass('is-hidden');
      } else {
        codePane.hide();
        diagramPane.show();
        toggleBtn.setText('Code');
        toggleBtn.setAttr('aria-label', 'Show code');
        zoomBtn.removeClass('is-hidden');
        saveBtn.removeClass('is-hidden');
        copyBtn.addClass('is-hidden');
      }
    };

    toggleBtn.addEventListener('click', () => {
      showCode = !showCode;
      applyToggleState();
    });
    applyToggleState();

    if (!renderSource.trim()) {
      diagramPane.createDiv({ cls: 'puml-embed-error', text: `${diagramLabel} block is empty.` });
      return;
    }

    const openZoomOverlay = async () => {
      if (context.signal.aborted) return;
      const doc = container.ownerDocument;
      const viewWindow = doc.defaultView ?? window;
      const overlayEl = doc.body.createDiv({ cls: 'puml-zoom-overlay' });
      const zoomController = new AbortController();
      const zoomContext = { ...context, signal: zoomController.signal };

      const panelEl = overlayEl.createDiv({ cls: 'puml-zoom-panel' });

      const headerEl = panelEl.createDiv({ cls: 'puml-zoom-header' });

      headerEl.createDiv();

      const controlsEl = headerEl.createDiv({ cls: 'puml-zoom-controls' });

      const zoomOutBtn = controlsEl.createEl('button', { text: '-' });

      const zoomResetBtn = controlsEl.createEl('button', { text: '100%' });

      const zoomInBtn = controlsEl.createEl('button', { text: '+' });

      const closeBtn = headerEl.createEl('button', { cls: 'puml-zoom-close', text: 'Close' });

      const contentEl = panelEl.createDiv({ cls: 'puml-zoom-content' });

      const canvasEl = contentEl.createDiv({ cls: 'puml-zoom-canvas' });

      const loadingEl = canvasEl.createDiv({ cls: 'puml-loading', text: 'Generating diagram...' });

      let zoom = 1;
      let renderedEl: HTMLElement | SVGSVGElement | null = null;
      let baseWidth = 0;
      let centeredInitially = false;
      let isPanning = false;
      let panStartX = 0;
      let panStartY = 0;
      let panScrollLeft = 0;
      let panScrollTop = 0;
      const clampZoom = (value: number) => Math.min(8, Math.max(0.1, Math.round(value * 100) / 100));
      const applyZoom = () => {
        if (!renderedEl || baseWidth <= 0) return;
        renderedEl.style.maxWidth = CSS_NONE;
        renderedEl.style.width = `${Math.max(1, Math.round(baseWidth * zoom))}px`;
        renderedEl.style.height = CSS_AUTO;
      };
      const setZoom = (value: number) => {
        zoom = clampZoom(value);
        zoomResetBtn.textContent = `${Math.round(zoom * 100)}%`;
        applyZoom();
      };
      const fitToViewport = () => {
        if (!renderedEl || baseWidth <= 0) return;
        const available = Math.max(1, contentEl.clientWidth - 12);
        setZoom(Math.min(1, available / baseWidth));
      };
      const centerViewport = () => {
        if (!renderedEl) return;
        contentEl.scrollLeft = Math.max(0, (contentEl.scrollWidth - contentEl.clientWidth) / 2);
        contentEl.scrollTop = 0;
      };
      const centerViewportOnce = () => {
        if (centeredInitially) return;
        centeredInitially = true;
        viewWindow.requestAnimationFrame(() => {
          if (!zoomContext.signal.aborted) centerViewport();
        });
      };

      zoomOutBtn.addEventListener('click', () => {
        setZoom(zoom - 0.1);
      });
      zoomResetBtn.addEventListener('click', () => {
        setZoom(1);
      });
      zoomInBtn.addEventListener('click', () => {
        setZoom(zoom + 0.1);
      });

      const onPanMouseMove = (event: MouseEvent) => {
        if (!isPanning) return;
        const dx = event.clientX - panStartX;
        const dy = event.clientY - panStartY;
        contentEl.scrollLeft = panScrollLeft - dx;
        contentEl.scrollTop = panScrollTop - dy;
      };

      const stopPan = () => {
        if (!isPanning) return;
        isPanning = false;
        contentEl.classList.remove('is-panning');
      };

      const onPanMouseUp = () => {
        stopPan();
      };

      contentEl.addEventListener('mousedown', (event: MouseEvent) => {
        if (event.button !== 0) return;
        if (!renderedEl) return;
        isPanning = true;
        panStartX = event.clientX;
        panStartY = event.clientY;
        panScrollLeft = contentEl.scrollLeft;
        panScrollTop = contentEl.scrollTop;
        contentEl.classList.add('is-panning');
        event.preventDefault();
      });
      contentEl.addEventListener('mouseleave', onPanMouseUp);
      viewWindow.addEventListener('mousemove', onPanMouseMove);
      viewWindow.addEventListener('mouseup', onPanMouseUp);

      const closeOverlay = () => {
        zoomController.abort();
        context.signal.removeEventListener('abort', closeOverlay);
        doc.removeEventListener('keydown', onKeyDown);
        viewWindow.removeEventListener('resize', fitToViewport);
        viewWindow.removeEventListener('mousemove', onPanMouseMove);
        viewWindow.removeEventListener('mouseup', onPanMouseUp);
        overlayEl.remove();
      };

      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          closeOverlay();
        }
      };

      overlayEl.addEventListener('click', (event) => {
        if (event.target === overlayEl) {
          closeOverlay();
        }
      });
      closeBtn.addEventListener('click', closeOverlay);
      doc.addEventListener('keydown', onKeyDown);
      viewWindow.addEventListener('resize', fitToViewport);
      context.signal.addEventListener('abort', closeOverlay, { once: true });

      try {
        if (this.settings.imageFormat === 'svg') {
          const svgEl = await this.fetchSvgElement(renderSource, diagramType, zoomContext);
          checkRenderSignal(zoomContext.signal);

          loadingEl.remove();
          const svgHost = canvasEl.createDiv();
          svgEl.addClass('puml-zoom-svg');
          let baseSvgWidth = 0;
          try {
            const bbox = svgEl.getBBox();
            if (bbox.width > 0 && bbox.height > 0) {
              svgEl.setAttribute('viewBox', `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`);
              baseSvgWidth = bbox.width;
            }
          } catch (error) {
            console.debug('Failed to crop SVG by bbox', error);
          }

          renderedEl = svgEl;
          const viewBoxWidth = baseSvgWidth || (svgEl.viewBox?.baseVal?.width ?? 0);
          const widthAttr = Number.parseFloat(svgEl.getAttribute('width') ?? '0');
          const measuredWidth = svgEl.getBoundingClientRect().width;
          baseWidth = viewBoxWidth || widthAttr || measuredWidth || 1000;
          fitToViewport();
          centerViewportOnce();
          svgHost.appendChild(svgEl);
          canvasEl.appendChild(svgHost);
        } else {
          const img = canvasEl.createEl('img', { cls: 'puml-zoom-image puml-is-hidden' });
          img.alt = `${diagramLabel} diagram`;
          const objectUrl = await this.fetchPngObjectUrl(renderSource, diagramType, zoomContext);

          img.addEventListener(
            'load',
            () => {
              if (zoomContext.signal.aborted) return;
              loadingEl.remove();
              renderedEl = img;
              baseWidth = img.naturalWidth || img.getBoundingClientRect().width || 1000;
              fitToViewport();
              img.removeClass('puml-is-hidden');
              centerViewportOnce();
            },
            { once: true },
          );
          img.addEventListener(
            'error',
            () => {
              if (zoomContext.signal.aborted) return;
              loadingEl.remove();
              canvasEl.createDiv({ cls: 'puml-embed-error', text: 'Failed to load PNG diagram.' });
            },
            { once: true },
          );
          setDiagramImageUrl(img, objectUrl, zoomContext.signal);
        }
      } catch (error) {
        if (zoomContext.signal.aborted) return;
        loadingEl.remove();
        if (isRenderCancelled(error)) {
          canvasEl.createDiv({ text: 'Diagram generation cancelled.' });
          return;
        }
        canvasEl.createDiv({
          cls: 'puml-embed-error',
          text: `Failed to render diagram: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    };

    zoomBtn.addEventListener('click', () => {
      void openZoomOverlay();
    });
    saveBtn.addEventListener('click', (event: MouseEvent) => {
      if (context.signal.aborted) return;
      const menu = new Menu();
      menu.addItem((item) =>
        item.setTitle('Save as PNG').onClick(async () => {
          try {
            await this.downloadDiagramAs(renderSource, 'png', `${diagramType}-diagram`, diagramType, context, container.ownerDocument);
            checkRenderSignal(context.signal);
            new Notice('Diagram saved as PNG');
          } catch (error) {
            if (context.signal.aborted || isRenderCancelled(error)) return;
            new Notice(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }),
      );
      menu.addItem((item) =>
        item.setTitle('Save as SVG').onClick(async () => {
          try {
            await this.downloadDiagramAs(renderSource, 'svg', `${diagramType}-diagram`, diagramType, context, container.ownerDocument);
            checkRenderSignal(context.signal);
            new Notice('Diagram saved as SVG');
          } catch (error) {
            if (context.signal.aborted || isRenderCancelled(error)) return;
            new Notice(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }),
      );
      menu.showAtMouseEvent(event);
    });
    copyBtn.addEventListener('click', () => {
      void (async () => {
        try {
          await navigator.clipboard.writeText(renderSource);
          new Notice(`${diagramLabel} code copied.`);
        } catch (error) {
          new Notice(`Copy failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    });

    const loadingEl = diagramPane.createDiv({ cls: 'puml-loading', text: 'Generating diagram...' });
    try {
      if (this.settings.imageFormat === 'svg') {
        const svgEl = await this.fetchSvgElement(renderSource, diagramType, context);
        checkRenderSignal(context.signal);

        loadingEl.remove();
        const svgHost = diagramPane.createDiv();
        svgEl.addClass('puml-embed-svg');
        svgHost.appendChild(svgEl);
      } else {
        const img = diagramPane.createEl('img', { cls: 'puml-embed-image puml-is-hidden' });
        const objectUrl = await this.fetchPngObjectUrl(renderSource, diagramType, context);
        img.alt = `${diagramLabel} diagram`;
        img.addEventListener(
          'load',
          () => {
            if (context.signal.aborted) return;
            loadingEl.remove();
            img.removeClass('puml-is-hidden');
          },
          { once: true },
        );
        img.addEventListener(
          'error',
          () => {
            if (context.signal.aborted) return;
            loadingEl.remove();
            diagramPane.createDiv({ cls: 'puml-embed-error', text: 'Failed to load PNG diagram.' });
          },
          { once: true },
        );
        setDiagramImageUrl(img, objectUrl, context.signal);
      }
    } catch (error) {
      if (context.signal.aborted) return;
      diagramPane.empty();
      if (isRenderCancelled(error)) {
        diagramPane.createDiv({ text: 'Diagram generation cancelled.' });
        return;
      }
      diagramPane.createDiv({
        cls: 'puml-embed-error',
        text: `Failed to render diagram: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  private extractEmbeddedWidthHint(
    source: string,
    fenceWidthHintPx: number | null,
  ): { renderSource: string; widthHintPx: number | null } {
    if (fenceWidthHintPx) {
      return { renderSource: source, widthHintPx: fenceWidthHintPx };
    }

    const lines = source.split('\n');
    const firstNonEmpty = lines.findIndex((line) => line.trim().length > 0);
    if (firstNonEmpty === -1) {
      return { renderSource: source, widthHintPx: null };
    }

    const match = lines[firstNonEmpty].trim().match(/^\|(\d{2,4})$/);
    if (!match) {
      return { renderSource: source, widthHintPx: null };
    }

    const widthHintPx = Math.min(6000, Math.max(120, Number(match[1])));
    lines.splice(firstNonEmpty, 1);
    return { renderSource: lines.join('\n'), widthHintPx };
  }

  private extractFenceWidthHint(sectionText: string, source: string, language: DiagramType): number | null {
    const escapedLanguage = language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(
      '`{3,}\\s*' + escapedLanguage + '(?:\\s+\\|(\\d{2,4}))?\\s*\\n([\\s\\S]*?)`{3,}',
      'gi',
    );
    let match: RegExpExecArray | null = regex.exec(sectionText);
    while (match) {
      const widthRaw = match[1];
      const blockSource = match[2] ?? '';
      if (blockSource.trim() === source.trim() && widthRaw) {
        return Math.min(6000, Math.max(120, Number(widthRaw)));
      }
      match = regex.exec(sectionText);
    }
    return null;
  }

  private renderPlantUmlHighlightedLine(target: HTMLElement, line: string): void {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("'") || trimmed.startsWith('//')) {
      target.createSpan({ cls: 'puml-code-comment', text: line });
      return;
    }

    const tokenRegex =
      /(![A-Za-z_]\w*|@[A-Za-z_]\w*|\b(?:actor|participant|boundary|control|entity|database|collections|queue|title|autonumber|skinparam|hide|show|note|left|right|of|as|alt|else|opt|loop|par|break|critical|group|end|if|then|start|stop|emit|endwhile|while|is|endif)\b|"[^"]*"|'[^']*')/gi;

    let lastIndex = 0;
    let match: RegExpExecArray | null = tokenRegex.exec(line);
    while (match) {
      const start = match.index;
      const token = match[0];

      if (start > lastIndex) {
        target.appendText(line.slice(lastIndex, start));
      }

      let cls = 'puml-code-keyword';
      if (token.startsWith('!') || token.startsWith('@')) {
        cls = 'puml-code-directive';
      } else if (token.startsWith('"') || token.startsWith("'")) {
        cls = 'puml-code-string';
      }

      target.createSpan({ cls, text: token });
      lastIndex = start + token.length;
      match = tokenRegex.exec(line);
    }

    if (lastIndex < line.length) {
      target.appendText(line.slice(lastIndex));
    }
  }
}

class PUMLViewerView extends ItemView {
  plugin: PUMLViewerPlugin;
  currentFile: TFile | null = null;

  private mode: ViewMode = 'view';
  private zoom = 1;
  private statusEl!: HTMLDivElement;
  private zoomValueEl!: HTMLDivElement;
  private imageWrapEl!: HTMLDivElement;
  private contentHostEl!: HTMLDivElement;
  private viewModeBtn!: HTMLButtonElement;
  private editModeBtn!: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;
  private zoomOutBtn!: HTMLButtonElement;
  private zoomResetBtn!: HTMLButtonElement;
  private zoomInBtn!: HTMLButtonElement;
  private exportPngBtn!: HTMLButtonElement;
  private exportSvgBtn!: HTMLButtonElement;
  private exportAsciiBtn!: HTMLButtonElement;
  private editorGutterEl: HTMLDivElement | null = null;
  private editorEl: HTMLTextAreaElement | null = null;
  private editorDraft: string | null = null;
  private draftFilePath: string | null = null;
  private isDirty = false;
  private isMainPanning = false;
  private mainPanStartX = 0;
  private mainPanStartY = 0;
  private mainPanScrollLeft = 0;
  private mainPanScrollTop = 0;
  private renderController?: AbortController;
  private cancelPendingJarRender?: () => void;
  private readonly exportControllers = new Map<DiagramFormat, AbortController>();

  constructor(leaf: WorkspaceLeaf, plugin: PUMLViewerPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_PUML;
  }

  getDisplayText(): string {
    return this.currentFile ? `Diagram: ${this.currentFile.name}` : 'Diagram Viewer';
  }

  getIcon(): string {
    return 'git-branch-plus';
  }

  private getCurrentDiagramType(): DiagramType | null {
    if (!this.currentFile) return null;
    return getDiagramTypeByExtension(this.currentFile.extension);
  }

  async onOpen(): Promise<void> {
    const viewContainer = this.containerEl.children[1] as HTMLElement;
    viewContainer.empty();
    viewContainer.addClass('puml-viewer-container');

    const toolbar = viewContainer.createDiv({ cls: 'puml-viewer-toolbar' });

    this.viewModeBtn = toolbar.createEl('button', { text: 'View' });
    this.viewModeBtn.addEventListener('click', () => {
      void this.switchMode('view');
    });

    this.editModeBtn = toolbar.createEl('button', { text: 'Edit' });
    this.editModeBtn.addEventListener('click', () => {
      void this.switchMode('edit');
    });

    this.saveBtn = toolbar.createEl('button', { text: 'Save' });
    this.saveBtn.addEventListener('click', () => {
      void this.saveEditor();
    });

    this.zoomOutBtn = toolbar.createEl('button', { text: '-' });
    this.zoomOutBtn.addEventListener('click', () => {
      this.setZoom(this.zoom - 0.1);
    });

    this.zoomResetBtn = toolbar.createEl('button', { text: '100%' });
    this.zoomResetBtn.addEventListener('click', () => {
      this.setZoom(1);
    });

    this.zoomInBtn = toolbar.createEl('button', { text: '+' });
    this.zoomInBtn.addEventListener('click', () => {
      this.setZoom(this.zoom + 0.1);
    });

    const refreshBtn = toolbar.createEl('button', { text: 'Refresh' });
    refreshBtn.addEventListener('click', () => {
      if (this.mode === 'view') {
        void this.renderDiagram();
      } else {
        void this.reloadEditorFromFile();
      }
    });

    this.exportPngBtn = toolbar.createEl('button', { cls: 'puml-toolbar-export-btn', text: 'PNG' });
    this.exportPngBtn.setAttr('aria-label', 'Save PNG image');
    this.exportPngBtn.addEventListener('click', () => {
      void this.exportDiagram('png');
    });

    this.exportSvgBtn = toolbar.createEl('button', { cls: 'puml-toolbar-export-btn', text: 'SVG' });
    this.exportSvgBtn.setAttr('aria-label', 'Save SVG image');
    this.exportSvgBtn.addEventListener('click', () => {
      void this.exportDiagram('svg');
    });

    this.exportAsciiBtn = toolbar.createEl('button', { cls: 'puml-toolbar-export-btn', text: 'ASCII' });
    this.exportAsciiBtn.setAttr('aria-label', 'Save ASCII art');
    this.exportAsciiBtn.addEventListener('click', () => {
      void this.exportDiagram('txt');
    });

    this.statusEl = toolbar.createDiv({ cls: 'puml-viewer-status' });
    this.statusEl.setText('Waiting for file...');
    this.zoomValueEl = toolbar.createDiv({ cls: 'puml-viewer-status' });

    this.imageWrapEl = viewContainer.createDiv({ cls: 'puml-viewer-image-wrap' });
    this.contentHostEl = this.imageWrapEl.createDiv({ cls: 'puml-viewer-content-host' });
    this.bindMainViewPanning();

    this.updateToolbarState();
    this.registerEvent(
      this.app.vault.on('modify', async (file) => {
        if (!this.currentFile || file.path !== this.currentFile.path) return;
        this.cancelExports();

        if (this.mode === 'view') {
          if (this.plugin.settings.autoRefresh) {
            await this.renderDiagram();
          } else {
            this.cancelPendingJarRender?.();
          }
          return;
        }

        if (!this.isDirty) {
          await this.reloadEditorFromFile();
          this.statusEl.setText(`Updated from disk: ${this.currentFile.name}`);
        } else {
          this.statusEl.setText('File changed on disk. Unsaved editor changes are kept.');
        }
      }),
    );
    await this.loadFileFromState();
  }

  async onClose(): Promise<void> {
    this.renderController?.abort();
    this.cancelExports();
    await super.onClose();
  }

  private cancelExports(): void {
    for (const controller of this.exportControllers.values()) controller.abort();
    this.exportControllers.clear();
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);

    const viewState = (state ?? {}) as PUMLViewState;

    if (viewState.mode) {
      this.mode = viewState.mode;
      if (this.mode === 'edit') {
        this.renderController?.abort();
        this.cancelExports();
      }
      this.updateToolbarState();
    }

    if (!viewState.file) return;

    const file = this.app.vault.getAbstractFileByPath(viewState.file);
    if (file instanceof TFile) {
      if (file !== this.currentFile) {
        this.renderController?.abort();
        this.cancelExports();
      }
      this.currentFile = file;
      void this.plugin.rememberLastPuml(file.path);
      this.resetDraftIfFileChanged();
      this.updateToolbarState();
      await this.renderActiveMode();
    }
  }

  getState(): Record<string, unknown> {
    return { file: this.currentFile?.path, mode: this.mode };
  }

  private async loadFileFromState(): Promise<void> {
    const state = this.leaf.getViewState().state;
    const mode = state?.mode;
    if (mode === 'view' || mode === 'edit') {
      this.mode = mode;
      this.updateToolbarState();
    }

    const candidates: string[] = [];
    if (typeof state?.file === 'string') candidates.push(state.file);

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && getDiagramTypeByExtension(activeFile.extension)) candidates.push(activeFile.path);

    if (this.plugin.settings.lastOpenedPumlPath) {
      candidates.push(this.plugin.settings.lastOpenedPumlPath);
    }

    const workspaceAny = this.app.workspace as unknown as { getLastOpenFiles?: () => string[] };
    const lastOpenFiles = workspaceAny.getLastOpenFiles?.() ?? [];
    for (const path of lastOpenFiles) {
      if (/\.(puml|mermaid|mmd|marmaid)$/i.test(path)) candidates.push(path);
    }

    const tried = new Set<string>();
    for (const path of candidates) {
      if (!path || tried.has(path)) continue;
      tried.add(path);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile && getDiagramTypeByExtension(file.extension)) {
        this.currentFile = file;
        void this.plugin.rememberLastPuml(file.path);
        this.resetDraftIfFileChanged();
        this.updateToolbarState();
        await this.renderActiveMode();
        return;
      }
    }

    await this.renderActiveMode();
  }

  private async switchMode(mode: ViewMode): Promise<void> {
    if (this.mode === mode) return;
    this.mode = mode;
    this.updateToolbarState();
    await this.renderActiveMode();
  }

  private async renderActiveMode(): Promise<void> {
    if (!this.contentHostEl) return;

    if (this.mode === 'edit') {
      this.renderController?.abort();
      this.cancelExports();
      await this.renderEditor();
      return;
    }

    await this.renderDiagram();
  }

  private updateToolbarState(): void {
    if (
      !this.viewModeBtn ||
      !this.editModeBtn ||
      !this.saveBtn ||
      !this.zoomOutBtn ||
      !this.zoomResetBtn ||
      !this.zoomInBtn ||
      !this.exportPngBtn ||
      !this.exportSvgBtn ||
      !this.exportAsciiBtn
    )
      return;

    this.viewModeBtn.toggleClass('is-active', this.mode === 'view');
    this.editModeBtn.toggleClass('is-active', this.mode === 'edit');
    this.saveBtn.disabled = this.mode !== 'edit';
    const zoomDisabled = this.mode !== 'view';
    this.zoomOutBtn.disabled = zoomDisabled;
    this.zoomResetBtn.disabled = zoomDisabled;
    this.zoomInBtn.disabled = zoomDisabled;
    const diagramType = this.getCurrentDiagramType();
    const exportDisabled = zoomDisabled || !this.currentFile || !diagramType;
    this.exportPngBtn.disabled = exportDisabled;
    this.exportSvgBtn.disabled = exportDisabled;
    this.exportAsciiBtn.disabled = exportDisabled || diagramType === 'mermaid';
    this.updateZoomLabel();
  }

  private resetDraftIfFileChanged(): void {
    const filePath = this.currentFile?.path ?? null;
    if (filePath && this.draftFilePath !== filePath) {
      this.editorDraft = null;
      this.isDirty = false;
      this.draftFilePath = filePath;
    }
  }

  private async renderEditor(): Promise<void> {
    this.contentHostEl.empty();
    this.contentHostEl.addClass('puml-viewer-content-host--editor');
    this.contentHostEl.removeClass('puml-viewer-content-host--view');
    this.imageWrapEl.removeClass('puml-viewer-image-wrap--view');
    this.imageWrapEl.removeClass('is-pan-enabled');
    this.imageWrapEl.removeClass('is-panning');
    this.isMainPanning = false;

    if (!this.currentFile) {
      this.statusEl.setText('No diagram file selected.');
      return;
    }

    try {
      const initialText =
        this.draftFilePath === this.currentFile.path && this.editorDraft !== null
          ? this.editorDraft
          : await this.app.vault.read(this.currentFile);

      this.editorDraft = initialText;
      this.draftFilePath = this.currentFile.path;

      const editorShell = this.contentHostEl.createDiv({ cls: 'puml-viewer-editor-shell' });
      this.editorGutterEl = editorShell.createDiv({ cls: 'puml-viewer-editor-gutter' });
      this.editorEl = editorShell.createEl('textarea', { cls: 'puml-viewer-editor' });
      this.editorEl.value = initialText;
      this.updateEditorLineNumbers(initialText);
      this.editorEl.addEventListener('input', () => {
        if (!this.editorEl) return;
        this.editorDraft = this.editorEl.value;
        this.isDirty = true;
        this.updateEditorLineNumbers(this.editorEl.value);
        this.statusEl.setText(`Editing: ${this.currentFile?.name ?? ''} (unsaved)`);
      });
      this.editorEl.addEventListener('scroll', () => {
        if (!this.editorEl || !this.editorGutterEl) return;
        this.editorGutterEl.scrollTop = this.editorEl.scrollTop;
      });
      this.editorEl.addEventListener('keydown', (event: KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          void this.saveEditor();
        }
      });

      this.statusEl.setText(`Editing: ${this.currentFile.name}`);
    } catch (error) {
      console.error(error);
      this.statusEl.setText('Failed to open editor.');

      const errorEl = this.contentHostEl.createDiv({ cls: 'puml-viewer-error' });
      errorEl.setText(
        `Failed to load source text.\n\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async reloadEditorFromFile(): Promise<void> {
    if (!this.currentFile || !this.editorEl) return;

    try {
      const source = await this.app.vault.read(this.currentFile);
      this.editorDraft = source;
      this.draftFilePath = this.currentFile.path;
      this.editorEl.value = source;
      this.updateEditorLineNumbers(source);
      this.isDirty = false;
    } catch (error) {
      console.error(error);
      this.statusEl.setText('Failed to reload source.');
    }
  }

  private async saveEditor(): Promise<void> {
    if (!this.currentFile || !this.editorEl || this.mode !== 'edit') return;

    try {
      const text = this.editorEl.value;
      await this.app.vault.modify(this.currentFile, text);
      this.editorDraft = text;
      this.draftFilePath = this.currentFile.path;
      this.isDirty = false;
      this.statusEl.setText(`Saved: ${this.currentFile.name}`);
      new Notice('Diagram source saved.');
    } catch (error) {
      console.error(error);
      this.statusEl.setText('Save failed.');
      new Notice('Failed to save diagram source.');
    }
  }

  private async exportDiagram(format: DiagramFormat): Promise<void> {
    const file = this.currentFile;
    if (this.mode !== 'view' || !file) return;
    const diagramType = this.getCurrentDiagramType();
    if (!diagramType) return;
    if (diagramType === 'mermaid' && format === 'txt') {
      new Notice('ASCII export is only available for plantuml.');
      return;
    }

    this.exportControllers.get(format)?.abort();
    const controller = new AbortController();
    this.exportControllers.set(format, controller);
    const { signal } = controller;
    const sourcePath = file.path;
    try {
      const source = await this.app.vault.read(file);
      checkRenderSignal(signal);
      if (!source.trim()) {
        new Notice('Diagram file is empty.');
        return;
      }

      const defaultOutputPath = normalizePath(
        sourcePath.replace(/\.[^/.]+$/i, `.${format}`),
      );
      const outputPath = await this.resolveExportOutputPath(defaultOutputPath, signal);
      checkRenderSignal(signal);
      if (!outputPath) {
        this.statusEl.setText('Export cancelled.');
        return;
      }

      const response = await this.plugin.requestDiagram(source, format, diagramType, { sourcePath, signal });
      checkRenderSignal(signal);

      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }

      const existing = this.app.vault.getAbstractFileByPath(outputPath);
      if (existing && !(existing instanceof TFile)) {
        throw new Error(`Cannot export: "${outputPath}" is not a file.`);
      }
      if (format === 'svg') {
        const contentType = this.plugin.responseContentType(response);
        if (contentType && !contentType.includes('image/svg')) {
          throw new Error(`Expected SVG but got "${contentType}"`);
        }
        if (existing instanceof TFile) {
          await this.app.vault.modify(existing, response.text);
        } else {
          await this.app.vault.create(outputPath, response.text);
        }
      } else if (format === 'png') {
        const contentType = this.plugin.responseContentType(response);
        if (contentType && !contentType.includes('image/png')) {
          throw new Error(`Expected PNG but got "${contentType}"`);
        }
        if (!response.arrayBuffer) {
          throw new Error('No PNG payload returned by render server');
        }

        if (existing instanceof TFile) {
          await this.app.vault.modifyBinary(existing, response.arrayBuffer);
        } else {
          await this.app.vault.createBinary(outputPath, response.arrayBuffer);
        }
      } else {
        const contentType = this.plugin.responseContentType(response);
        if (contentType && !contentType.includes('text/plain')) {
          throw new Error(`Expected text/plain but got "${contentType}"`);
        }
        if (existing instanceof TFile) {
          await this.app.vault.modify(existing, response.text);
        } else {
          await this.app.vault.create(outputPath, response.text);
        }
      }

      checkRenderSignal(signal);
      this.statusEl.setText(`Exported: ${outputPath}`);
      new Notice(`Diagram exported: ${outputPath}`);
    } catch (error) {
      if (signal.aborted || isRenderCancelled(error)) return;
      if (!(error instanceof PlantUmlJarError)) console.error(error);
      this.statusEl.setText('Export failed.');
      new Notice(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (this.exportControllers.get(format) === controller) this.exportControllers.delete(format);
    }
  }

  private async resolveExportOutputPath(defaultPath: string, signal: AbortSignal): Promise<string | null> {
    const existing = this.app.vault.getAbstractFileByPath(defaultPath);
    if (!existing) return defaultPath;

    if (!(existing instanceof TFile)) {
      return this.getNextAvailableExportPath(defaultPath);
    }

    const action = await this.askExportConflict(defaultPath, signal);
    if (action === 'cancel') return null;
    if (action === 'overwrite') return defaultPath;
    return this.getNextAvailableExportPath(defaultPath);
  }

  private getNextAvailableExportPath(path: string): string {
    const slashIndex = path.lastIndexOf('/');
    const dir = slashIndex >= 0 ? path.slice(0, slashIndex) : '';
    const fileName = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
    const dotIndex = fileName.lastIndexOf('.');
    const base = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
    const ext = dotIndex > 0 ? fileName.slice(dotIndex) : '';

    let index = 1;
    while (index < 10_000) {
      const candidateName = `${base}-${index}${ext}`;
      const candidatePath = normalizePath(dir ? `${dir}/${candidateName}` : candidateName);
      if (!this.app.vault.getAbstractFileByPath(candidatePath)) {
        return candidatePath;
      }
      index += 1;
    }

    throw new Error(`Could not find available file name for "${path}".`);
  }

  private askExportConflict(path: string, signal: AbortSignal): Promise<ExportConflictAction> {
    return new Promise((resolve) => {
      const close = () => modal.close();
      const modal = new ExportConflictModal(this.app, path, (action) => {
        signal.removeEventListener('abort', close);
        resolve(action);
      });
      signal.addEventListener('abort', close, { once: true });
      modal.open();
    });
  }

  private async renderDiagram(): Promise<void> {
    if (this.mode !== 'view') return;
    this.renderController?.abort();
    const controller = new AbortController();
    this.renderController = controller;
    const { signal } = controller;
    this.contentHostEl.empty();
    this.contentHostEl.removeClass('puml-viewer-content-host--editor');
    this.contentHostEl.addClass('puml-viewer-content-host--view');
    this.imageWrapEl.addClass('puml-viewer-image-wrap--view');
    this.editorGutterEl = null;
    this.editorEl = null;

    const file = this.currentFile;
    if (!file) {
      this.statusEl.setText('No diagram file selected.');
      return;
    }
    const diagramType = this.getCurrentDiagramType();
    if (!diagramType) {
      this.statusEl.setText('Unsupported file type.');
      return;
    }
    const diagramLabel = diagramType === 'mermaid' ? 'Mermaid' : 'PlantUML';
    const context = { sourcePath: file.path, signal };
    const format = this.plugin.settings.imageFormat;
    let renderMode: RenderMode | undefined;
    let loadingEl: HTMLDivElement | undefined;
    const finishLoading = () => {
      loadingEl?.remove();
      signal.removeEventListener('abort', finishLoading);
      if (this.renderController === controller) this.cancelPendingJarRender = undefined;
    };
    signal.addEventListener('abort', finishLoading, { once: true });
    this.cancelPendingJarRender = () => {
      if ((renderMode ?? this.plugin.settings.serverType) !== 'jar') return;
      controller.abort();
      this.statusEl.setText('File changed. Use the refresh button to render again.');
    };

    try {
      const source = await this.app.vault.read(file);
      checkRenderSignal(signal);

      if (!source.trim()) {
        finishLoading();
        this.statusEl.setText('File is empty.');
        return;
      }

      this.statusEl.setText(`Rendering: ${file.name}`);
      const renderRoot = this.contentHostEl.createDiv({ cls: 'puml-viewer-render-root' });
      loadingEl = renderRoot.createDiv({ cls: 'puml-loading', text: 'Generating diagram...' });

      renderMode = this.plugin.settings.serverType;
      if (format === 'svg') {
        const svgEl = await this.plugin.fetchSvgElement(source, diagramType, context);
        checkRenderSignal(signal);

        finishLoading();
        const svgHost = renderRoot.createDiv();
        svgHost.appendChild(svgEl);
        this.fitToWidth();
        this.refreshMainPanAvailability();
        this.statusEl.setText(`Rendered: ${file.name}`);
      } else {
        const img = renderRoot.createEl('img', {
          cls: 'puml-viewer-image puml-is-hidden',
        });
        const objectUrl = await this.plugin.fetchPngObjectUrl(source, diagramType, context);
        img.alt = `${diagramLabel} diagram`;
        img.addEventListener(
          'load',
          () => {
            if (signal.aborted) return;
            finishLoading();
            img.removeClass('puml-is-hidden');
            this.fitToWidth();
            this.refreshMainPanAvailability();
            this.statusEl.setText(`Rendered: ${file.name}`);
          },
          { once: true },
        );
        img.addEventListener(
          'error',
          () => {
            if (signal.aborted) return;
            finishLoading();
            this.statusEl.setText('Render failed.');
            const errorEl = renderRoot.createDiv({ cls: 'puml-viewer-error' });
            errorEl.setText('Failed to load PNG diagram.');
          },
          { once: true },
        );
        setDiagramImageUrl(img, objectUrl, signal);
      }
    } catch (error) {
      if (signal.aborted) return;
      finishLoading();
      if (isRenderCancelled(error)) {
        this.statusEl.setText('Diagram generation cancelled.');
        return;
      }
      if (!(error instanceof PlantUmlJarError)) console.error(error);
      this.statusEl.setText('Render failed.');

      const errorEl = this.contentHostEl.createDiv({ cls: 'puml-viewer-error' });
      errorEl.setText(
        `Failed to render diagram.\n\n${error instanceof Error ? error.message : String(error)}`,
      );

      new Notice(`${diagramLabel} render failed.`);
    }
  }

  private setZoom(value: number): void {
    const nextZoom = Math.min(4, Math.max(0.25, Math.round(value * 100) / 100));
    this.zoom = nextZoom;
    this.applyZoom();
    this.refreshMainPanAvailability();
    this.updateZoomLabel();
  }

  private fitToWidth(): void {
    const renderRoot = this.contentHostEl?.querySelector<HTMLElement>('.puml-viewer-render-root');
    if (!renderRoot || !this.imageWrapEl) return;

    const imageEl = renderRoot.querySelector<HTMLImageElement>('.puml-viewer-image');
    if (imageEl) {
      const baseWidth = this.getImageBaseWidth(imageEl);
      if (!(baseWidth > 0)) return;

      const availableWidth = Math.max(1, this.imageWrapEl.clientWidth - 24);
      this.setZoom(Math.min(1, availableWidth / baseWidth));
      return;
    }

    const svgEl = renderRoot.querySelector<SVGSVGElement>('svg');
    if (!svgEl) return;

    const baseWidth = this.getSvgBaseWidth(svgEl);
    if (!(baseWidth > 0)) return;

    const availableWidth = Math.max(1, this.imageWrapEl.clientWidth - 24);
    this.setZoom(Math.min(1, availableWidth / baseWidth));
  }

  private updateZoomLabel(): void {
    if (!this.zoomValueEl) return;
    this.zoomValueEl.setText(`Zoom: ${Math.round(this.zoom * 100)}%`);
  }

  private applyZoom(): void {
    const renderRoot = this.contentHostEl?.querySelector<HTMLElement>('.puml-viewer-render-root');
    if (!renderRoot) return;

    const imageEl = renderRoot.querySelector<HTMLImageElement>('.puml-viewer-image');
    if (imageEl) {
      const baseWidth = this.getImageBaseWidth(imageEl);

      if (baseWidth > 0) {
        imageEl.style.maxWidth = CSS_NONE;
        imageEl.style.width = `${Math.max(1, Math.round(baseWidth * this.zoom))}px`;
        imageEl.style.height = CSS_AUTO;
      } else {
        imageEl.addEventListener(
          'load',
          () => {
            this.applyZoom();
          },
          { once: true },
        );
      }
      return;
    }

    const svgEl = renderRoot.querySelector<SVGSVGElement>('svg');
    if (!svgEl) return;

    const baseWidth = this.getSvgBaseWidth(svgEl);

    if (!(baseWidth > 0)) return;

    svgEl.style.maxWidth = CSS_NONE;
    svgEl.style.width = `${Math.max(1, Math.round(baseWidth * this.zoom))}px`;
    svgEl.style.height = CSS_AUTO;
  }

  private bindMainViewPanning(): void {
    this.registerDomEvent(this.imageWrapEl, 'mousedown', (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (this.mode !== 'view') return;
      if (!this.canMainPan()) return;

      this.isMainPanning = true;
      this.mainPanStartX = event.clientX;
      this.mainPanStartY = event.clientY;
      this.mainPanScrollLeft = this.imageWrapEl.scrollLeft;
      this.mainPanScrollTop = this.imageWrapEl.scrollTop;
      this.imageWrapEl.addClass('is-panning');
      event.preventDefault();
    });

    this.registerDomEvent(window, 'mousemove', (event: MouseEvent) => {
      if (!this.isMainPanning) return;
      const dx = event.clientX - this.mainPanStartX;
      const dy = event.clientY - this.mainPanStartY;
      this.imageWrapEl.scrollLeft = this.mainPanScrollLeft - dx;
      this.imageWrapEl.scrollTop = this.mainPanScrollTop - dy;
      event.preventDefault();
    });

    const stopPanning = () => {
      if (!this.isMainPanning) return;
      this.isMainPanning = false;
      this.imageWrapEl.removeClass('is-panning');
    };

    this.registerDomEvent(window, 'mouseup', stopPanning);
    this.registerDomEvent(this.imageWrapEl, 'mouseleave', stopPanning);
  }

  private canMainPan(): boolean {
    const hasHorizontal = this.imageWrapEl.scrollWidth > this.imageWrapEl.clientWidth + 1;
    const hasVertical = this.imageWrapEl.scrollHeight > this.imageWrapEl.clientHeight + 1;
    return hasHorizontal || hasVertical;
  }

  private refreshMainPanAvailability(): void {
    if (this.mode !== 'view') {
      this.imageWrapEl.removeClass('is-pan-enabled');
      return;
    }
    this.imageWrapEl.toggleClass('is-pan-enabled', this.canMainPan());
  }

  private getImageBaseWidth(imageEl: HTMLImageElement): number {
    const storedBaseWidth = Number(imageEl.dataset.baseWidth ?? 0);
    const measuredWidth =
      imageEl.naturalWidth || imageEl.clientWidth || imageEl.getBoundingClientRect().width;
    const baseWidth = storedBaseWidth > 0 ? storedBaseWidth : measuredWidth;
    if (baseWidth > 0) {
      imageEl.dataset.baseWidth = String(baseWidth);
    }
    return baseWidth;
  }

  private getSvgBaseWidth(svgEl: SVGSVGElement): number {
    const storedBaseWidth = Number(svgEl.dataset.baseWidth ?? 0);
    let baseWidth = storedBaseWidth;
    if (!(baseWidth > 0)) {
      const viewBoxWidth = svgEl.viewBox?.baseVal?.width ?? 0;
      const widthAttr = Number.parseFloat(svgEl.getAttribute('width') ?? '0');
      const measuredWidth = svgEl.getBoundingClientRect().width;
      baseWidth = viewBoxWidth || widthAttr || measuredWidth;
    }
    if (baseWidth > 0) {
      svgEl.dataset.baseWidth = String(baseWidth);
    }
    return baseWidth;
  }

  private updateEditorLineNumbers(text: string): void {
    if (!this.editorGutterEl) return;
    this.editorGutterEl.empty();

    const lineCount = Math.max(1, text.split('\n').length);
    for (let i = 1; i <= lineCount; i++) {
      this.editorGutterEl.createDiv({ cls: 'puml-viewer-editor-line', text: String(i) });
    }
  }
}

class ExportConflictModal extends Modal {
  private resolved = false;
  private readonly onResolve: (action: ExportConflictAction) => void;
  private readonly path: string;

  constructor(app: App, path: string, onResolve: (action: ExportConflictAction) => void) {
    super(app);
    this.path = path;
    this.onResolve = onResolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h3', { text: 'File already exists' });
    contentEl.createEl('p', {
      text: `The file "${this.path}" already exists. Overwrite it or save as a new file?`,
    });

    const buttonRow = contentEl.createDiv({ cls: 'modal-button-container' });

    const overwriteBtn = buttonRow.createEl('button', {
      text: 'Overwrite',
      cls: 'mod-warning',
    });
    overwriteBtn.addEventListener('click', () => this.finish('overwrite'));

    const newFileBtn = buttonRow.createEl('button', {
      text: 'Save as new',
      cls: 'mod-cta',
    });
    newFileBtn.addEventListener('click', () => this.finish('new-file'));

    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.finish('cancel'));
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.resolved) return;
    this.resolved = true;
    this.onResolve('cancel');
  }

  private finish(action: ExportConflictAction): void {
    if (this.resolved) return;
    this.resolved = true;
    this.onResolve(action);
    this.close();
  }
}

class PUMLViewerSettingTab extends PluginSettingTab {
  plugin: PUMLViewerPlugin;

  constructor(app: App, plugin: PUMLViewerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const desktop = Platform.isDesktopApp;
    const jarSelected = this.plugin.settings.serverType === 'jar';
    const renderOptions: Record<string, string> = { plantuml: 'Plantuml', kroki: 'Kroki', local: 'Local' };
    if (desktop || jarSelected) renderOptions.jar = desktop ? 'JAR' : 'JAR (desktop only)';
    let renderDescription = 'Choose how to generate PlantUML diagrams.';
    if (jarSelected) {
      renderDescription = desktop
        ? 'Run plantuml.jar using Java.'
        : 'PlantUML JAR is available in desktop Obsidian. Choose an HTTP render mode on mobile.';
    }

    new Setting(containerEl).setName('Plantuml viewer').setHeading();

    new Setting(containerEl)
      .setName('Render mode')
      .setDesc(renderDescription)
      .addDropdown((dropdown) => {
        const { selectEl } = dropdown.addOptions(renderOptions);
        selectEl.addClass('puml-render-mode-dropdown');
        if (!desktop && jarSelected) {
          selectEl.options[selectEl.options.length - 1].disabled = true;
        }
        dropdown
          .setValue(this.plugin.settings.serverType)
          .onChange((value) => {
            if (value !== 'plantuml' && value !== 'kroki' && value !== 'local' && value !== 'jar') return;
            if (value === 'jar' && !desktop) return;
            void this.plugin.setRenderMode(value).catch(() => new Notice('Could not save the render mode.'));
            if (jarSelected !== (value === 'jar')) this.display();
          });
      });

    new Setting(containerEl)
      .setName('Plantuml server URL')
      .setDesc('Example: https://www.plantuml.com/plantuml')
      .addText((text) =>
        text
          .setPlaceholder('https://www.plantuml.com/plantuml')
          .setValue(this.plugin.settings.plantumlServerUrl)
          .onChange(async (value) => {
            this.plugin.settings.plantumlServerUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Kroki URL')
      .setDesc('Example: https://kroki.io')
      .addText((text) =>
        text
          .setPlaceholder('https://kroki.io')
          .setValue(this.plugin.settings.krokiServerUrl)
          .onChange(async (value) => {
            this.plugin.settings.krokiServerUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Kroki diagram type')
      .setDesc('Default diagram type for kroki requests outside explicit code block language.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('plantuml', 'Plantuml')
          .addOption('mermaid', 'Mermaid')
          .setValue(this.plugin.settings.krokiDiagramType)
          .onChange(async (value) => {
            if (value !== 'plantuml' && value !== 'mermaid') return;
            this.plugin.settings.krokiDiagramType = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Local URL')
      .setDesc('Use a local server URL.')
      .addText((text) =>
        text
          .setPlaceholder('Local server URL')
          .setValue(this.plugin.settings.localServerUrl)
          .onChange(async (value) => {
            this.plugin.settings.localServerUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    if (desktop && jarSelected) {
      addJarSettings(containerEl, this.plugin.settings, () => this.plugin.saveSettings());
    }

    new Setting(containerEl)
      .setName('Image format')
      .setDesc('SVG is recommended.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('svg', 'SVG')
          .addOption('png', 'PNG')
          .setValue(this.plugin.settings.imageFormat)
          .onChange(async (value) => {
            if (value !== 'svg' && value !== 'png') return;
            this.plugin.settings.imageFormat = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Auto refresh')
      .setDesc('Automatically re-render diagram when the source file changes.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoRefresh).onChange(async (value) => {
          this.plugin.settings.autoRefresh = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Embedded block default view')
      .setDesc('Choose what to show first in embedded diagram blocks.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('diagram', 'Diagram')
          .addOption('code', 'Code')
          .setValue(this.plugin.settings.embeddedDefaultView)
          .onChange(async (value) => {
            if (value !== 'diagram' && value !== 'code') return;
            this.plugin.settings.embeddedDefaultView = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Embedded diagram alignment')
      .setDesc('Default alignment for diagrams in embedded diagram blocks.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('left', 'Left')
          .addOption('center', 'Center')
          .addOption('right', 'Right')
          .setValue(this.plugin.settings.embeddedDiagramAlign)
          .onChange(async (value) => {
            if (value !== 'left' && value !== 'center' && value !== 'right') return;
            this.plugin.settings.embeddedDiagramAlign = value;
            await this.plugin.saveSettings();
            this.plugin.rerenderMarkdownPreviews();
          }),
      );
  }
}
