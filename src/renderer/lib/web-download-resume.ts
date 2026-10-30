/**
 * FSA 流式下载续传的纯决策逻辑。
 *
 * 浏览器文件系统（File System Access API）无法在 node/vitest 里运行，因此把
 * “是否可以从本地已有文件续写”的判断抽成不依赖 DOM 的纯函数，单独做单元测试。
 *
 * 续传必须同时满足：
 * - 目标目录里存在本次任务专属的 checkpoint（`.<name>.<taskId>.partmeta`）；
 * - checkpoint 的 taskId 与当前任务一致（排除同名旧文件/其它任务残留）；
 * - 本地已有文件大小恰好等于 checkpoint 记录的已写字节数；
 * - checkpoint 必须记录非空的远端校验器（ETag），否则无法证明远端文件未被替换；
 * - 远端文件校验器（ETag）与 checkpoint 记录的一致（远端文件未被替换）；
 * - 远端总大小大于已写字节数（尚未下完）。
 * 任一不满足都必须从 0 重新覆盖，绝不能把新内容追加到无关的同名文件后面。
 */

export interface WebDownloadPartMeta {
  taskId: string;
  name: string;
  /** 远端文件校验器（服务端下发的 ETag）。 */
  etag: string;
  /** 远端文件总大小。 */
  size: number;
  /** 已经落盘的字节数。 */
  bytesWritten: number;
}

export interface WebDownloadResumeInput {
  /** 当前下载任务的 id。 */
  taskId: string;
  /** 读取到的 checkpoint（不存在或损坏时为 null/undefined）。 */
  metadata: WebDownloadPartMeta | null | undefined;
  /** 目标目录里同名文件的当前大小。 */
  existingSize: number;
  /**
   * 远端当前校验器（可选）。请求前未知时省略；收到响应后可传入响应的
   * ETag 复核，若与 checkpoint 不一致则视为远端文件已变化，必须重下。
   */
  remoteEtag?: string | null;
}

export interface WebDownloadResumeDecision {
  /** 是否可以从 offset 续写。 */
  resume: boolean;
  /** 续写起点；不可续写时为 0。 */
  offset: number;
  /** 续写时附带的 If-Range 校验器。 */
  ifRange?: string;
}

/** 任务专属 checkpoint 文件名：.${name}.${taskId}.partmeta */
export function webDownloadPartMetaName(name: string, taskId: string): string {
  return `.${name}.${taskId}.partmeta`;
}

export type WebDownloadConflictDecision = 'resume' | 'overwrite' | 'skip' | 'rename' | 'ask';

export interface WebDownloadConflictInput {
  /** 目标目录里是否已存在同名文件（不含本次任务 checkpoint 的判定）。 */
  exists: boolean;
  /** decideWebDownloadResume 的结果：是否可续写本次任务自己的断点。 */
  resume: boolean;
  /** 任务携带的冲突策略。 */
  policy: 'ask' | 'overwrite' | 'skip' | 'rename';
}

/**
 * 结合“本地是否已存在同名文件 + 能否续传 + 冲突策略”给出落盘动作。
 *
 * 顺序很关键：本任务自己的断点续传优先，不算冲突；只有无法续传但目标已存在时，
 * 才按 conflictPolicy 决定覆盖 / 跳过 / 重命名 / 询问用户。文件不存在时直接写入。
 */
export function decideWebDownloadConflict(input: WebDownloadConflictInput): WebDownloadConflictDecision {
  const { exists, resume, policy } = input;
  if (resume) return 'resume';
  if (!exists) return 'overwrite';
  switch (policy) {
    case 'overwrite':
      return 'overwrite';
    case 'skip':
      return 'skip';
    case 'rename':
      return 'rename';
    case 'ask':
    default:
      return 'ask';
  }
}

/** 拆出文件名主干与扩展名（保留扩展名前的点；无扩展名或隐藏文件时 extension 为空）。 */
export function splitLocalFileName(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, extension: '' };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

/** 生成第 index 个候选文件名：`base (1).ext`、`base (2).ext`……（index<1 时原样返回）。 */
export function localNameWithSuffix(name: string, index: number): string {
  if (!Number.isInteger(index) || index < 1) return name;
  const { stem, extension } = splitLocalFileName(name);
  return `${stem} (${index})${extension}`;
}

/** 冲突弹窗里默认建议的重命名：`base (1).ext`。 */
export function suggestedLocalName(name: string): string {
  return localNameWithSuffix(name, 1);
}

/** 根据 checkpoint / 本地大小 / 远端校验器决定续写起点。 */
export function decideWebDownloadResume(input: WebDownloadResumeInput): WebDownloadResumeDecision {
  const { taskId, metadata, existingSize, remoteEtag } = input;
  if (!metadata) return { resume: false, offset: 0 };
  if (metadata.taskId !== taskId) return { resume: false, offset: 0 };
  // 没有记录校验器的 checkpoint 无法证明远端未被替换，禁止续传。
  if (!metadata.etag) return { resume: false, offset: 0 };
  if (!(metadata.bytesWritten > 0)) return { resume: false, offset: 0 };
  if (existingSize !== metadata.bytesWritten) return { resume: false, offset: 0 };
  if (!(metadata.size > metadata.bytesWritten)) return { resume: false, offset: 0 };
  if (remoteEtag != null && remoteEtag !== '' && metadata.etag && remoteEtag !== metadata.etag) {
    return { resume: false, offset: 0 };
  }
  return {
    resume: true,
    offset: metadata.bytesWritten,
    ifRange: metadata.etag || undefined,
  };
}
