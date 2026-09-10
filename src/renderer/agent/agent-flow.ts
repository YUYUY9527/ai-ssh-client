import type { AgentResponse, Message } from '../../shared/types';
import type {
  AIChatResult,
  AIChatStreamEvent,
  AIChatStreamOptions,
  IPCResult,
} from '../../shared/ipc-types';

/**
 * Agent 单轮决策与命令执行流程。
 *
 * 历史：本模块原名 `langgraph-agent-flow.ts`，用 LangGraph `StateGraph` 编排。
 * 经评估（见 `docs/langgraph-removal-assessment.md`）确认两个图均为**严格线性
 * 流水线** —— 零条件边、零环、零中断、零检查点、零并行扇出，状态语义等价于
 * 浅合并 —— 而这份依赖占前端 JS 的约 50%（827.7 KB）。故改为普通顺序流水线，
 * 移除 `@langchain/langgraph` 与 `@langchain/core`。
 *
 * 公开 API 保持不变（`runAgentRoundGraph` / `runAgentExecutionGraph`），函数名中的
 * "Graph" 后缀属历史遗留，保留是为了维持既有调用点与测试契约的稳定。
 *
 * 职责边界：UI 状态更新、审批交互与传输细节都留在 `AgentRuntime` 中，本模块只
 * 负责编排形状并返回纯数据结果，因此保持可确定性测试。
 */

type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
type AnalyzeCommand = (command: string) => { riskLevel: RiskLevel };
type ParseAgentResponse = (content: string) => AgentResponse | null;
type ShouldBlockRepeatedCommand = (command: string) => boolean;
type NeedsApproval = (riskLevel: RiskLevel) => boolean;
type FallbackText = {
  parseRetry: string;
  cannotParse: string;
  invalidResponse: string;
  completed: string;
  analyzing: string;
  noCommand: string;
  duplicateCommand: (command: string) => string;
};

export type AgentGraphAction =
  | { type: 'execute'; response: AgentResponse; command: string }
  | { type: 'approval'; response: AgentResponse; command: string; riskLevel: RiskLevel }
  | { type: 'ask'; response: AgentResponse; question: string }
  | { type: 'finish'; response: AgentResponse; reason: string }
  | { type: 'retryParse'; message: string }
  | { type: 'fail'; reason: string; response?: AgentResponse };

type AiChatStreamService = (
  providerId: string,
  messages: Message[],
  options: AIChatStreamOptions,
) => Promise<IPCResult<AIChatResult>>;

interface RunAgentRoundGraphInput {
  providerId: string;
  messages: Message[];
  requestId: string;
  parseRetryAvailable: boolean;
  aiChatStream: AiChatStreamService;
  onStreamEvent?: (event: AIChatStreamEvent) => void;
  parseResponse: ParseAgentResponse;
  analyzeCommand: AnalyzeCommand;
  shouldBlockRepeatedCommand: ShouldBlockRepeatedCommand;
  needsApproval: NeedsApproval;
  fallbackText: FallbackText;
}

export interface AgentExecutionGraphResult {
  command: string;
  output: string;
  observation: string;
  nextDecisionContext: string;
  error?: string;
}

export interface AgentRoundGraphResult {
  rawContent?: string;
  response: AgentResponse | null;
  nextAction: AgentGraphAction;
  execution?: AgentExecutionGraphResult;
  error?: string;
}

// ==========================================================================
// 流水线基础设施
// ==========================================================================

type Patch<S> = Partial<S> | void;
type PipelineNode<S> = (state: Readonly<S>) => Patch<S> | Promise<Patch<S>>;

/**
 * 顺序执行节点，把每个节点返回的补丁浅合并进状态。
 *
 * 这正是前 LangGraph 实现实际使用的全部语义：节点读取「此前所有节点合并后的
 * 状态」，返回部分状态，由运行时浅合并（各通道均为 last-value-wins，无 reducer）。
 *
 * 约定（重要，请勿违反）：
 * - 节点**只返回补丁**，不得直接修改传入的 state。这里传入的是活对象，
 *   直接改它虽会生效，但会绕过补丁语义、破坏可预期性。
 * - 节点抛出的错误会中止剩余节点并向上冒泡。「被中止」与「执行失败」的区分
 *   依赖这条路径，详见 `runAgentExecutionGraph` 内注释。
 */
async function runPipeline<S extends object>(
  initial: S,
  nodes: Array<PipelineNode<S>>,
): Promise<S> {
  const state = { ...initial };
  for (const node of nodes) {
    const patch = await node(state);
    if (patch) {
      Object.assign(state, patch);
    }
  }
  return state;
}

/**
 * AgentRuntime 的 `AbortedByRuntimeError` 只按 `name` 识别 —— 本模块不引用
 * runtime，两者靠约定而非同一个类耦合。
 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortedByRuntimeError';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 命令执行流程：执行 → 观察输出 → 准备下一轮决策上下文。
 *
 * 前两个节点在失败时都会退化为填入 `error` 文本，且此时**不再**调用摘要与
 * 上下文构建（原实现依赖 `state.error` 早返回，此处保持一致）。
 */
export async function runAgentExecutionGraph(input: {
  command: string;
  execute: (command: string) => Promise<string>;
  summarizeOutput: (output: string) => string;
  buildNextDecisionContext: (command: string, output: string) => string;
}): Promise<AgentExecutionGraphResult> {
  interface ExecutionState {
    command: string;
    output?: string;
    observation?: string;
    nextDecisionContext?: string;
    error?: string;
  }

  const state = await runPipeline<ExecutionState>(
    { command: input.command },
    [
      async (current) => {
        try {
          return { output: await input.execute(current.command) };
        } catch (error) {
          // 中止（暂停 / 停止 / 关闭标签 / 版本变更）必须向上冒泡：AgentRuntime 依赖
          // AbortedByRuntimeError 区分「被中止」与「执行失败」。若在此吞成 error 字段，
          // 上层会被重新包成普通 Error，instanceof 判定失效，暂停会被误判为任务失败。
          // 与 executeAction 的处理保持一致。
          if (isAbortError(error)) {
            throw error;
          }

          return { error: messageOf(error) };
        }
      },
      (current) => (current.error
        ? { observation: current.error }
        : { observation: input.summarizeOutput(current.output || '') }),
      (current) => (current.error
        ? { nextDecisionContext: current.error }
        : {
          nextDecisionContext: input.buildNextDecisionContext(
            current.command,
            current.output || '',
          ),
        }),
    ],
  );

  return {
    command: state.command,
    output: state.output || '',
    observation: state.observation || '',
    nextDecisionContext: state.nextDecisionContext || '',
    error: state.error,
  };
}

/**
 * 执行一轮完整决策：模型调用 → 响应解析 → 动作路由 → 可选命令执行。
 *
 * 路由优先级（顺序即优先级，勿随意调整）：
 *   解析失败 → finish → ask → 无命令 fail → 重复命令 fail → 需审批 → execute
 */
export async function runAgentRoundGraph(input: RunAgentRoundGraphInput & {
  beforeExecute?: (action: Extract<AgentGraphAction, { type: 'execute' }>) => void;
  execute: (command: string) => Promise<string>;
  summarizeOutput: (command: string, output: string) => string;
  buildNextDecisionContext: (command: string, output: string) => string;
}): Promise<AgentRoundGraphResult> {
  interface RoundState {
    rawContent?: string;
    response: AgentResponse | null;
    nextAction: AgentGraphAction | null;
    execution?: AgentExecutionGraphResult;
    error?: string;
  }

  /** 模型调用失败会抛出，由 AgentRuntime 捕获（并区分中止与失败）。 */
  const callModel = async (): Promise<Patch<RoundState>> => {
    const result = await input.aiChatStream(input.providerId, input.messages, {
      requestId: input.requestId,
      onEvent: (event) => input.onStreamEvent?.(event),
    });

    if (!result.success || !result.data) {
      throw new Error(result.success ? 'AI response is empty' : result.error);
    }

    return { rawContent: result.data.content };
  };

  const parseModelResponse = (state: Readonly<RoundState>): Patch<RoundState> => {
    if (!state.rawContent) {
      return { response: null };
    }
    return { response: input.parseResponse(state.rawContent) };
  };

  const routeDecision = (state: Readonly<RoundState>): Patch<RoundState> => {
    const response = state.response;
    if (!response) {
      return {
        nextAction: input.parseRetryAvailable
          ? { type: 'retryParse', message: input.fallbackText.parseRetry }
          : { type: 'fail', reason: input.fallbackText.invalidResponse },
      };
    }

    if (response.decision === 'finish') {
      return {
        nextAction: {
          type: 'finish',
          response,
          reason: response.finishReason || input.fallbackText.completed,
        },
      };
    }

    if (response.decision === 'ask') {
      return {
        nextAction: {
          type: 'ask',
          response,
          question: response.question || input.fallbackText.analyzing,
        },
      };
    }

    const command = response.command?.trim();
    if (!command) {
      return {
        nextAction: {
          type: 'fail',
          response,
          reason: input.fallbackText.noCommand,
        },
      };
    }

    if (input.shouldBlockRepeatedCommand(command)) {
      return {
        nextAction: {
          type: 'fail',
          response,
          reason: input.fallbackText.duplicateCommand(command),
        },
      };
    }

    const risk = input.analyzeCommand(command);
    if (input.needsApproval(risk.riskLevel)) {
      return {
        nextAction: {
          type: 'approval',
          response,
          command,
          riskLevel: risk.riskLevel,
        },
      };
    }

    return {
      nextAction: {
        type: 'execute',
        response,
        command,
      },
    };
  };

  const executeAction = async (state: Readonly<RoundState>): Promise<Patch<RoundState>> => {
    const action = state.nextAction;
    if (action?.type !== 'execute') {
      return {};
    }

    const { command } = action;
    try {
      input.beforeExecute?.(action);
      const output = await input.execute(command);
      return {
        execution: {
          command,
          output: output || '',
          observation: input.summarizeOutput(command, output || '') || '',
          nextDecisionContext: input.buildNextDecisionContext(command, output || '') || '',
        },
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      const message = messageOf(error);
      return {
        execution: {
          command,
          output: '',
          observation: message,
          nextDecisionContext: message,
          error: message,
        },
      };
    }
  };

  const state = await runPipeline<RoundState>(
    { rawContent: undefined, response: null, nextAction: null, execution: undefined, error: undefined },
    [callModel, parseModelResponse, routeDecision, executeAction],
  );

  return {
    rawContent: state.rawContent,
    response: state.response,
    nextAction: state.nextAction || {
      type: 'fail',
      reason: input.fallbackText.cannotParse,
    },
    execution: state.execution,
    error: state.error,
  };
}
