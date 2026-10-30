import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { oneDark } from '@codemirror/theme-one-dark';

import type { CodeLanguage } from './code-format';

interface CodeEditorProps {
  value: string;
  language: CodeLanguage;
  readOnly?: boolean;
  onChange: (value: string) => void;
}

function languageExtension(language: CodeLanguage): Extension {
  switch (language) {
    case 'json':
      return json();
    case 'yaml':
      return yaml();
    default:
      return [];
  }
}

function themeExtension(isDark: boolean): Extension {
  return isDark ? oneDark : [];
}

/** 编辑器基础样式：铺满容器、等宽字体、跟随应用背景。 */
const baseTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'transparent',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    lineHeight: '1.55',
  },
  '.cm-content': {
    padding: '10px 0',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    borderRight: '1px solid color-mix(in srgb, var(--border-color) 55%, transparent)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
});

/** CodeMirror 6 薄封装：value 受控同步、按语言高亮、深浅色主题跟随应用。 */
export function CodeEditor({ value, language, readOnly = false, onChange }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const languageCompartment = useRef(new Compartment()).current;
  const themeCompartment = useRef(new Compartment()).current;
  const editableCompartment = useRef(new Compartment()).current;

  const editableExtensions = (editable: boolean): Extension => [
    EditorState.readOnly.of(!editable),
    EditorView.editable.of(editable),
  ];

  // 只在挂载时创建一次实例
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const isDark = document.documentElement.classList.contains('dark');
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          baseTheme,
          EditorState.tabSize.of(2),
          EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
          languageCompartment.of(languageExtension(language)),
          themeCompartment.of(themeExtension(isDark)),
          editableCompartment.of(editableExtensions(!readOnly)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;

    // 应用切换深浅色时，同步编辑器主题
    const observer = new MutationObserver(() => {
      const dark = document.documentElement.classList.contains('dark');
      view.dispatch({ effects: themeCompartment.reconfigure(themeExtension(dark)) });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      observer.disconnect();
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部重置 / 格式化后同步到编辑器（和当前内容相同则跳过，避免打断输入）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: languageCompartment.reconfigure(languageExtension(language)) });
  }, [language, languageCompartment]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: editableCompartment.reconfigure(editableExtensions(!readOnly)) });
  }, [readOnly, editableCompartment]);

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />;
}
