import { getIcon } from 'material-file-icons';

interface FileTypeIconProps {
  name: string;
  isDirectory?: boolean;
  isSymbolicLink?: boolean;
}

/** 金色文件夹，贴近资源管理器 / 参考图的黄色文件夹样式。 */
const FOLDER_SVG = '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%">'
  + '<path d="M3 8.2A2.7 2.7 0 0 1 5.7 5.5h6.1c.8 0 1.5.35 2 .95l1.5 1.8c.25.3.62.47 1.02.47h9.9A2.7 2.7 0 0 1 29 11.4v12.4a2.7 2.7 0 0 1-2.7 2.7H5.7A2.7 2.7 0 0 1 3 23.8z" fill="#e2b33c"/>'
  + '<path d="M3 13.4h26v10.4a2.7 2.7 0 0 1-2.7 2.7H5.7A2.7 2.7 0 0 1 3 23.8z" fill="#f3c73f"/>'
  + '</svg>';

/** 符号链接图标（使用 currentColor，跟随所在行的文字颜色）。 */
const LINK_SVG = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>'
  + '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'
  + '</svg>';

/**
 * 文件类型图标。
 * 目录用金色文件夹，符号链接用链接图标，普通文件复用 Material Icon Theme（与参考图同一套图标）。
 */
export function FileTypeIcon({ name, isDirectory, isSymbolicLink }: FileTypeIconProps) {
  if (isDirectory) {
    return <span className="file-type-icon" aria-hidden dangerouslySetInnerHTML={{ __html: FOLDER_SVG }} />;
  }
  if (isSymbolicLink) {
    return <span className="file-type-icon text-slate-400" aria-hidden dangerouslySetInnerHTML={{ __html: LINK_SVG }} />;
  }
  return (
    <span
      className="file-type-icon"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: getIcon(name).svg }}
    />
  );
}
