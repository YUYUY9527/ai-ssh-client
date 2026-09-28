/**
 * AI 相关纯函数模块
 *
 * 历史：这里还曾导出 `./extract-command`（LangChain 时代的「从自由文本里抠命令」模块）。
 * Agent 改为纯 JSON 决策后它已无任何调用方，2026-09 随死代码清理删除 ——
 * 顺带消除「从散文里提取命令去执行」这一绕过审批的路径。
 */

export * from './analyze-command-risk';
