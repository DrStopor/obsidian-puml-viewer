/* global require */

import { Notice, Setting } from 'obsidian';
import {
  DEFAULT_PLANTUML_LIMIT_SIZE,
  isPlantUmlLimitSize,
  MAX_PLANTUML_LIMIT_SIZE,
} from './plantuml-jar';

export interface JarSettings {
  javaExecutable: string;
  plantumlJarPath: string;
  plantumlLimitSize: number;
}

function getSelectedFilePath(file: File): string {
  // Electron before v32 exposes the native path on the selected file.
  const legacyPath = (file as File & { path?: string }).path;
  if (legacyPath) return legacyPath;

  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Loaded only by the desktop file picker.
  const electron = require('electron') as { webUtils?: { getPathForFile(file: File): string } };
  return electron.webUtils?.getPathForFile(file) ?? '';
}

export function addJarSettings(
  containerEl: HTMLElement,
  settings: JarSettings,
  saveSettings: () => Promise<void>,
): void {
  const heading = 'PlantUML JAR';
  const group = containerEl.createDiv({
    cls: 'puml-jar-settings',
    attr: { role: 'group', 'aria-label': heading },
  });
  new Setting(group).setName(heading).setHeading();

  const save = () => {
    void saveSettings().catch(() => new Notice('Could not save the rendering options.'));
  };
  addJarPathSetting(
    group, settings, save, 'javaExecutable',
    'Java executable', 'Enter an executable name from your system path or its full path.',
  );
  addJarPathSetting(
    group, settings, save, 'plantumlJarPath', 'JAR path', 'Enter the full path to plantuml.jar.',
  );

  const sizeDescription = `Maximum width or height in pixels. Clear the field to use the default of ${DEFAULT_PLANTUML_LIMIT_SIZE}.`;
  const sizeSetting = new Setting(group).setName('Image size limit').setDesc(sizeDescription);
  const showInvalidSize = () => {
    const current = isPlantUmlLimitSize(settings.plantumlLimitSize)
      ? `Current value: ${settings.plantumlLimitSize}.`
      : 'The saved value is invalid.';
    sizeSetting.setDesc(`Enter a whole number from 1 to ${MAX_PLANTUML_LIMIT_SIZE}. ${current}`);
  };
  sizeSetting.addText((text) => {
    const { inputEl } = text;
    inputEl.type = 'number';
    inputEl.min = '1';
    inputEl.max = String(MAX_PLANTUML_LIMIT_SIZE);
    inputEl.step = '1';
    text.setPlaceholder(String(DEFAULT_PLANTUML_LIMIT_SIZE));
    text.setValue(String(settings.plantumlLimitSize));
    if (!isPlantUmlLimitSize(settings.plantumlLimitSize)) showInvalidSize();
    text.onChange((value) => {
      const limit = value === '' ? DEFAULT_PLANTUML_LIMIT_SIZE : Number(value);
      if (inputEl.validity.badInput || (value !== '' && !/^\d+$/.test(value)) || !isPlantUmlLimitSize(limit)) {
        showInvalidSize();
        return;
      }
      sizeSetting.setDesc(sizeDescription);
      if (settings.plantumlLimitSize === limit) return;
      settings.plantumlLimitSize = limit;
      save();
    });
  });
}

function addJarPathSetting(
  group: HTMLElement,
  settings: JarSettings,
  saveSettings: () => void,
  key: 'javaExecutable' | 'plantumlJarPath',
  name: string,
  description: string,
): void {
  const isJar = key === 'plantumlJarPath';
  const defaultValue = isJar ? '' : 'java';
  const setting = new Setting(group).setName(name).setDesc(description);
  const picker = setting.controlEl.createEl('input', { type: 'file' });
  picker.hidden = true;
  if (isJar) picker.accept = '.jar';

  const save = (value: string) => {
    settings[key] = value || defaultValue;
    saveSettings();
  };

  setting.addText((text) => {
    if (isJar) text.setPlaceholder('Full path to plantuml.jar');
    text.setValue(typeof settings[key] === 'string' ? settings[key] : defaultValue).onChange(save);

    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      picker.value = '';
      if (!file || !setting.settingEl.isConnected) return;

      let path: string;
      try {
        path = getSelectedFilePath(file);
      } catch {
        path = '';
      }
      if (!path) {
        new Notice('Could not get the selected file path. Enter it in the text field.');
        return;
      }
      text.setValue(path);
      save(path);
    });
  });

  setting.addButton((button) =>
    button
      .setButtonText('Browse…')
      .setTooltip(isJar ? 'Choose a PlantUML JAR file' : 'Choose a Java executable')
      .onClick(() => picker.click()),
  );
}
